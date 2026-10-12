import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { GrantProps } from "../src/env";
import { buildServer } from "../src/tools";
import { fakeEg4, makeEnv, point, props, SN, type FakeOptions } from "./helpers";

async function connect(p: GrantProps, opts: FakeOptions = {}) {
  const env = makeEnv();
  const eg4 = fakeEg4(opts);
  const server = buildServer(env, p, eg4.fetchImpl);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { client, call, eg4, env };
}

const writes = (eg4: ReturnType<typeof fakeEg4>) => eg4.calls.filter((c) => c.path.startsWith("/web/maintain/remoteSet/"));

describe("registration", () => {
  it("is read-only unless changes were allowed", async () => {
    const ro = (await (await connect(props())).client.listTools()).tools.map((t) => t.name);
    expect(ro).toContain("eg4_get_status");
    expect(ro).not.toContain("eg4_change_settings");
    const rw = (await (await connect(props({ canWrite: true }))).client.listTools()).tools;
    expect(rw.find((t) => t.name === "eg4_change_settings")?.annotations?.destructiveHint).toBe(true);
    expect(rw.find((t) => t.name === "eg4_get_settings")?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("reads", () => {
  it("defaults to the only battery inverter and decodes status", async () => {
    const { call } = await connect(props());
    const r = await call("eg4_get_status");
    expect(r.isError).toBe(false);
    expect(r.json.serialNum).toBe(SN);
    expect(r.json.battery).toMatchObject({ soc_pct: 90, voltage_v: 52.9, power_w: 855, cycle_count: 75 });
  });

  it("rejects a serial that isn't on the account", async () => {
    const { call } = await connect(props());
    const r = await call("eg4_get_status", { serialNum: "ZZZ9999999" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/isn't on this EG4 account/);
  });

  it("merges all register blocks into friendly grouped settings", async () => {
    const { call, eg4 } = await connect(props());
    const r = await call("eg4_get_settings", {});
    expect(eg4.calls.filter((c) => c.path === "/web/maintain/remoteRead/read").map((c) => c.form.get("startRegister"))).toEqual(["0", "127", "240"]);
    expect(r.json.settings.battery).toMatchObject({ battery_type: "lithium", lithium_brand: "eg4", discharge_control: "soc" });
    expect(r.json.settings.cutoffs).toMatchObject({ on_grid_cutoff_soc_pct: "15 %", off_grid_cutoff_soc_pct: "10 %" });
    expect(r.json.settings.ac_charge.ac_charge_window_1_end).toBe("15:00");
    expect(r.json.raw).toBeUndefined();
  });

  it("filters raw settings", async () => {
    const { call } = await connect(props());
    const r = await call("eg4_get_settings", { raw: true, raw_filter: "peak_shaving" });
    expect(Object.keys(r.json.raw).every((k) => k.toLowerCase().includes("peak_shaving"))).toBe(true);
  });

  it("converts history and energy to kWh", async () => {
    const { call } = await connect(props());
    expect((await call("eg4_get_energy")).json.today_kwh).toMatchObject({ consumption: 15, grid_import: 20.7, battery_discharge: 2.8 });
    expect((await call("eg4_get_history", { year: 2026, month: 10 })).json.days[0]).toMatchObject({ day: 1, battery_charge_kwh: 11.2, grid_import_kwh: 54.4 });
  });

  it("analyzes time-of-use coverage over a date range", async () => {
    const { call, eg4 } = await connect(props(), { dayData: [point("16:00", { battery: 3000, load: 3000 }), point("18:00", { grid: 2500, load: 2500, soc: 40 })] });
    const r = await call("eg4_analyze_tou", { start_date: "2026-10-08", end_date: "2026-10-09" });
    expect(r.json.days).toHaveLength(2);
    expect(r.json.days[0].battery_first_went_idle_while_importing_in_costly_period).toMatchObject({ time: "18:00", soc_pct: 40 });
    expect(eg4.calls.filter((c) => c.path === "/api/analyze/chart/dayMultiLine").map((c) => c.form.get("dateText"))).toEqual(["2026-10-08", "2026-10-09"]);
    expect((await call("eg4_analyze_tou", { start_date: "2026-10-01", end_date: "2026-10-20" })).text).toMatch(/at most 14 days/);
  });
});

describe("eg4_change_settings", () => {
  it("previews without writing", async () => {
    const { call, eg4 } = await connect(props({ canWrite: true }));
    const r = await call("eg4_change_settings", { changes: { on_grid_cutoff_soc_pct: 20, ac_charge_window_1_end: "14:30" } });
    expect(r.json.mode).toBe("preview");
    expect(r.json.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ setting: "on_grid_cutoff_soc_pct", current: 15, new: 20 }),
        expect.objectContaining({ setting: "ac_charge_window_1_end", current: "15:00", new: "14:30" }),
      ]),
    );
    expect(writes(eg4)).toHaveLength(0);
  });

  it("applies, reads back, verifies, logs and returns an undo map", async () => {
    const { call, eg4 } = await connect(props({ canWrite: true }));
    const r = await call("eg4_change_settings", {
      changes: { on_grid_cutoff_soc_pct: 20, peak_shaving_window_1_start: "16:00", discharge_control: "volt" },
      apply: true,
    });
    expect(r.json.all_verified).toBe(true);
    expect(r.json.undo).toEqual({ on_grid_cutoff_soc_pct: 15, peak_shaving_window_1_start: "15:00", discharge_control: "soc" });
    expect(eg4.settings.HOLD_DISCHG_CUT_OFF_SOC_EOD).toBe("20");
    expect(eg4.settings.FUNC_BAT_DISCHARGE_CONTROL).toBe(true);
    expect(eg4.settings.LSP_HOLD_DIS_CHG_POWER_TIME_37).toBe("16");
    // cut-offs and windows are written before the control mode that activates them
    expect(writes(eg4).map((c) => c.form.get("holdParam") ?? c.form.get("timeParam") ?? c.form.get("functionParam"))).toEqual([
      "HOLD_DISCHG_CUT_OFF_SOC_EOD",
      "HOLD_PEAK_SHAVING_START_TIME_1",
      "FUNC_BAT_DISCHARGE_CONTROL",
    ]);
    expect(r.json.applied).toBe("all");
    const hist = await call("eg4_change_history");
    expect(hist.json[0].changes).toHaveLength(3);
  });

  it("switches features off first and on last, after their settings", async () => {
    const { call, eg4 } = await connect(props({ canWrite: true }));
    await call("eg4_change_settings", {
      changes: { forced_discharge_enabled: "on", forced_discharge_power_kw: 3, ac_charge_enabled: "off", forced_discharge_stop_soc_pct: 40 },
      apply: true,
    });
    const order = writes(eg4).map((c) => c.form.get("holdParam") ?? c.form.get("functionParam"));
    expect(order[0]).toBe("FUNC_AC_CHARGE");
    expect(order.at(-1)).toBe("FUNC_FORCED_DISCHG_EN");
  });

  it("reports a partial apply with what landed and what was skipped", async () => {
    const { call } = await connect(props({ canWrite: true }), { reject: ["HOLD_AC_CHARGE_POWER_CMD"] });
    const r = await call("eg4_change_settings", { changes: { on_grid_cutoff_soc_pct: 20, ac_charge_power_kw: 6, ac_charge_enabled: "off" }, apply: true });
    expect(r.json.applied).toBe("partial");
    expect(r.json.headline).toMatch(/Earlier changes DID land/);
    const byKey = Object.fromEntries(r.json.verification.map((v: any) => [v.setting, v.status]));
    expect(byKey).toEqual({ ac_charge_enabled: "written", on_grid_cutoff_soc_pct: "written", ac_charge_power_kw: "rejected" });
    expect(r.json.undo).toEqual({ ac_charge_enabled: "on", on_grid_cutoff_soc_pct: 15 });
  });

  it("refuses to apply when the review finds errors", async () => {
    const { call, eg4 } = await connect(props({ canWrite: true }));
    const r = await call("eg4_change_settings", { changes: { off_grid_cutoff_soc_pct: 40 }, apply: true });
    expect(r.json.applied).toBe(false);
    expect(r.json.errors[0]).toMatch(/must be ≤/);
    expect(writes(eg4)).toHaveLength(0);
  });

  it("skips values that are already set", async () => {
    const { call, eg4 } = await connect(props({ canWrite: true }));
    const r = await call("eg4_change_settings", { changes: { on_grid_cutoff_soc_pct: 15 }, apply: true });
    expect(r.json.results[0].status).toBe("already_set");
    expect(writes(eg4)).toHaveLength(0);
  });

  it("stops at the first refusal and reports what didn't stick", async () => {
    const { call, eg4 } = await connect(props({ canWrite: true }), { reject: ["HOLD_LEAD_ACID_CHARGE_RATE"] });
    const r = await call("eg4_change_settings", { changes: { charge_current_limit_a: 100, ac_charge_power_kw: 6 }, apply: true });
    expect(r.json.results).toEqual([expect.objectContaining({ setting: "charge_current_limit_a", status: "rejected", message: "PARAM_OUT_OF_RANGE" })]);
    expect(r.json.applied).toBe("none");
    expect(r.json.verification.find((v: any) => v.setting === "ac_charge_power_kw").status).toBe("not_attempted");
    expect(writes(eg4)).toHaveLength(1);
  });

  it("still reports landed writes when the read-back fails", async () => {
    const { call, eg4 } = await connect(props({ canWrite: true }));
    const env = eg4; // flip remoteRead to failing after the writes
    const r1 = await call("eg4_change_settings", { changes: { on_grid_cutoff_soc_pct: 25 } }); // preview reads fine
    expect(r1.json.mode).toBe("preview");
    env.failReadsAfterWrite = true;
    const r = await call("eg4_change_settings", { changes: { on_grid_cutoff_soc_pct: 25 }, apply: true });
    expect(r.isError).toBe(false);
    expect(r.json.applied).toBe("all");
    expect(r.json.all_verified).toBeNull();
    expect(r.json.read_back_error).toMatch(/DEVICE_TIMEOUT/);
    expect(r.json.headline).toMatch(/read-back failed/);
    expect(r.json.undo).toEqual({ on_grid_cutoff_soc_pct: 15 });
  });

  it("flags a write EG4 accepted but the inverter didn't keep", async () => {
    const { call } = await connect(props({ canWrite: true }), { ignore: ["HOLD_AC_CHARGE_POWER_CMD"] });
    const r = await call("eg4_change_settings", { changes: { ac_charge_power_kw: 6 }, apply: true });
    expect(r.json.verification[0]).toMatchObject({ setting: "ac_charge_power_kw", requested: 6, now: 5, verified: false });
  });

  it("rejects unknown settings with suggestions", async () => {
    const { call } = await connect(props({ canWrite: true }));
    const r = await call("eg4_change_settings", { changes: { cutoff: 10 } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown setting "cutoff"/);
  });
});
