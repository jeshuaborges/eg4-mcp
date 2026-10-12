import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env, GrantProps } from "../env";
import { Eg4Client, Eg4Error, type Json } from "../eg4/client";
import { analyzeDay, decodeColumns, decodeDay, decodeEnergy, decodeStatus, downsample, EV2A, type Period } from "../eg4/decode";
import { listDevices, resolveSerial } from "../eg4/devices";
import {
  currentValue,
  describe,
  GROUPS,
  plan,
  review,
  sameValue,
  SETTINGS,
  writeRequest,
  type Flat,
  type Group,
  type PlannedWrite,
} from "../eg4/settings";
import { fail, ok } from "./util";

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const serialNum = z
  .string()
  .optional()
  .describe("Inverter serial number. Optional when the account has a single battery inverter; see eg4_list_inverters.");
const date = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe(`${what} (YYYY-MM-DD, plant local date)`);

/** remoteRead blocks the 12K-family settings live in. */
const READ_BLOCKS = [0, 127, 240];
const MAX_CHANGES = 15;
const AUDIT_KEEP = 50;

export function buildServer(env: Env, props: GrantProps, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer(
    { name: "eg4", version: "0.1.0" },
    {
      instructions:
        "Connected to the EG4 monitoring portal (monitor.eg4electronics.com) for a home inverter + battery system. " +
        "Start with eg4_get_status for live state, eg4_analyze_tou to see whether the battery covered expensive hours, and eg4_get_settings to see configuration. " +
        "serialNum can be omitted when the account has one battery inverter. Times are the plant's local time. " +
        (props.canWrite
          ? "eg4_change_settings changes a real inverter: call it with apply=false first, show the user the preview, and apply only after they confirm. It reads the inverter back and reports any setting that didn't stick."
          : "This connection is read-only."),
    },
  );
  const eg4 = new Eg4Client(env, props, fetchImpl);

  const run = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err);
    }
  };

  const readSettings = async (sn: string): Promise<Flat> => {
    const flat: Flat = {};
    for (const startRegister of READ_BLOCKS) {
      const body = await eg4.call("/WManage/web/maintain/remoteRead/read", { inverterSn: sn, startRegister, pointNumber: 127, autoRetry: true });
      for (const [k, v] of Object.entries(body)) if (!["success", "valueFrame", "startRegister", "pointNumber"].includes(k)) flat[k] = v;
    }
    return flat;
  };

  const groupedSettings = (flat: Flat, groups?: Group[]) => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const s of SETTINGS) {
      if (groups?.length && !groups.includes(s.group)) continue;
      const v = currentValue(s, flat);
      if (v === undefined) continue;
      (out[s.group] ??= {})[s.key] = s.kind === "hold" ? `${v} ${s.unit}`.trim() : v;
    }
    return out;
  };

  // ---------------------------------------------------------------- discovery

  server.registerTool(
    "eg4_list_inverters",
    {
      title: "List EG4 devices",
      description: "Lists inverters and GridBOSS units on the EG4 account: serial numbers, model, plant, status, battery type and capacity, firmware.",
      inputSchema: { refresh: z.boolean().optional().describe("Bypass the 30-minute cache") },
      annotations: READ,
    },
    async ({ refresh }) => run(async () => ({ devices: await listDevices(env, eg4, refresh ?? false) })),
  );

  server.registerTool(
    "eg4_describe_settings",
    {
      title: "Describe changeable EG4 settings",
      description:
        "Offline catalogue of the settings eg4_get_settings shows by name and eg4_change_settings can change: key, group, kind, unit, range, allowed values and notes.",
      inputSchema: { group: z.enum(GROUPS as [Group, ...Group[]]).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ group }) => ok(SETTINGS.filter((s) => !group || s.group === group).map(describe)),
  );

  // ---------------------------------------------------------------- live data

  server.registerTool(
    "eg4_get_status",
    {
      title: "Live inverter and battery status",
      description:
        "Real-time state: battery SOC, voltage, power (+ discharging / − charging), BMS limits and permissions, cell voltage spread and temperatures, cycle count, grid import/export, house load, PV, fault/warning codes. " +
        "If soc and the BMS fields are empty, closed-loop BMS communication isn't working.",
      inputSchema: { serialNum },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const d = await resolveSerial(env, eg4, a.serialNum);
        const runtime = await eg4.call("/WManage/api/inverter/getInverterRuntime", { serialNum: d.serialNum });
        let battery: Json | null = null;
        try {
          battery = await eg4.post("/WManage/api/battery/getBatteryInfo", { serialNum: d.serialNum });
        } catch {
          battery = null;
        }
        return decodeStatus(runtime, battery);
      }),
  );

  server.registerTool(
    "eg4_get_energy",
    {
      title: "Energy totals (today and lifetime)",
      description: "Today's and lifetime kWh: consumption, grid import/export, battery charge/discharge, solar.",
      inputSchema: { serialNum },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const d = await resolveSerial(env, eg4, a.serialNum);
        return decodeEnergy(await eg4.call("/WManage/api/inverter/getInverterEnergyInfo", { serialNum: d.serialNum }));
      }),
  );

  server.registerTool(
    "eg4_get_day",
    {
      title: "Power flows for one day",
      description:
        "The day's power chart (EG4 logs every ~4 minutes) averaged into buckets: grid_w (+ import), battery_w (+ discharge), load_w, solar_w, soc_pct. " +
        "Use eg4_analyze_tou for a per-rate-period summary instead of reading raw points.",
      inputSchema: {
        serialNum,
        date: date("Day"),
        interval_min: z.number().int().min(5).max(120).optional().describe("Bucket size in minutes (default 15)"),
      },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const d = await resolveSerial(env, eg4, a.serialNum);
        const body = await eg4.call("/WManage/api/analyze/chart/dayMultiLine", { serialNum: d.serialNum, dateText: a.date });
        const samples = decodeDay(body.data);
        return { serialNum: d.serialNum, date: a.date, raw_samples: samples.length, interval_min: a.interval_min ?? 15, series: downsample(samples, a.interval_min ?? 15) };
      }),
  );

  server.registerTool(
    "eg4_get_history",
    {
      title: "Daily or monthly energy history",
      description: "kWh per day for a month (pass year and month), or per month for a year (pass year only).",
      inputSchema: {
        serialNum,
        year: z.number().int().min(2018).max(2100),
        month: z.number().int().min(1).max(12).optional(),
      },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const d = await resolveSerial(env, eg4, a.serialNum);
        if (a.month) {
          const body = await eg4.call("/WManage/api/inverterChart/monthColumn", { serialNum: d.serialNum, year: a.year, month: a.month });
          return { serialNum: d.serialNum, year: a.year, month: a.month, days: decodeColumns(body.data, "day") };
        }
        const body = await eg4.call("/WManage/api/inverterChart/yearColumn", { serialNum: d.serialNum, year: a.year });
        return { serialNum: d.serialNum, year: a.year, months: decodeColumns(body.data, "month") };
      }),
  );

  server.registerTool(
    "eg4_analyze_tou",
    {
      title: "Time-of-use battery coverage",
      description:
        "For each day in a range (max 14), splits grid import, load and battery charge/discharge by rate period and reports how much of each period's load the battery covered, " +
        "SOC at the start of the first costly period, minimum SOC, and when the battery first went idle while the house was importing in a costly period " +
        "(the usual sign of a cut-off set too high). Defaults to PG&E EV2-A; pass `periods` for another plan, with optional $/kWh rates for a cost estimate.",
      inputSchema: {
        serialNum,
        start_date: date("First day"),
        end_date: date("Last day").optional(),
        periods: z
          .array(
            z.object({
              name: z.string().describe('e.g. "peak", "part_peak", "off_peak" (name the cheapest one off_peak)'),
              windows: z.array(z.string().regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/)).describe('e.g. ["16:00-21:00"]; end is exclusive, 24:00 allowed'),
              rate_per_kwh: z.number().min(0).optional(),
            }),
          )
          .optional()
          .describe("Rate periods covering the whole day. Default: PG&E EV2-A."),
      },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const d = await resolveSerial(env, eg4, a.serialNum);
        const start = new Date(`${a.start_date}T00:00:00Z`);
        const end = new Date(`${a.end_date ?? a.start_date}T00:00:00Z`);
        const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
        if (days < 1) throw new Eg4Error("end_date is before start_date.", "input");
        if (days > 14) throw new Eg4Error("Analyze at most 14 days at a time.", "input");
        const periods: Period[] = a.periods ?? EV2A;
        const results: Json[] = [];
        for (let i = 0; i < days; i++) {
          const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
          const body = await eg4.call("/WManage/api/analyze/chart/dayMultiLine", { serialNum: d.serialNum, dateText: day });
          const samples = decodeDay(body.data);
          results.push(samples.length ? { date: day, ...analyzeDay(samples, periods) } : { date: day, note: "no data" });
        }
        return { serialNum: d.serialNum, plan: a.periods ? "custom" : "PG&E EV2-A (peak 16–21, part-peak 15–16 & 21–24)", days: results };
      }),
  );

  // ---------------------------------------------------------------- settings

  server.registerTool(
    "eg4_get_settings",
    {
      title: "Read inverter settings",
      description:
        "Reads the inverter's current settings live (takes a few seconds) and returns them grouped with friendly names: battery type and BMS mode, charge/discharge control (volt vs soc), cut-offs, " +
        "AC (grid) charge schedule, peak-shaving, forced discharge, backup and export. Set raw=true for EG4's full register map (filter it with raw_filter).",
      inputSchema: {
        serialNum,
        groups: z.array(z.enum(GROUPS as [Group, ...Group[]])).optional(),
        raw: z.boolean().optional(),
        raw_filter: z.string().max(60).optional().describe("Case-insensitive substring to keep raw keys, e.g. AC_CHARGE"),
      },
      annotations: READ,
    },
    async (a) =>
      run(async () => {
        const d = await resolveSerial(env, eg4, a.serialNum);
        const flat = await readSettings(d.serialNum);
        const result: Json = { serialNum: d.serialNum, deviceTime: flat.HOLD_TIME ?? flat.inverterRuntimeDeviceTime, settings: groupedSettings(flat, a.groups) };
        if (a.raw) {
          const f = a.raw_filter?.toLowerCase();
          result.raw = Object.fromEntries(Object.entries(flat).filter(([k]) => !f || k.toLowerCase().includes(f)));
        }
        return result;
      }),
  );

  if (!props.canWrite) return server;

  // ---------------------------------------------------------------- writes

  const auditKey = async () => `eg4mcp:audit:${await eg4.hash()}`;

  server.registerTool(
    "eg4_change_settings",
    {
      title: "Change inverter settings",
      description:
        "Changes inverter settings by key (see eg4_describe_settings), e.g. {\"on_grid_cutoff_soc_pct\": 15, \"discharge_control\": \"soc\", \"ac_charge_window_1_end\": \"15:00\"}. " +
        "With apply=false (default) it reads the inverter and returns a preview: current vs new values, blocking errors, warnings and the order writes will run in. " +
        "With apply=true it writes each change, then reads the inverter back and reports verified/mismatched values. Show the preview to the user and get their OK before apply=true.",
      inputSchema: {
        serialNum,
        changes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("setting key → new value"),
        apply: z.boolean().optional().describe("false/omitted = preview only"),
      },
      annotations: WRITE,
    },
    async (a) =>
      run(async () => {
        const entries = Object.entries(a.changes);
        if (entries.length === 0) throw new Eg4Error("Pass at least one change.", "input");
        if (entries.length > MAX_CHANGES) throw new Eg4Error(`At most ${MAX_CHANGES} changes per call.`, "input");
        const writes: PlannedWrite[] = entries.map(([k, v]) => plan(k, v));
        const d = await resolveSerial(env, eg4, a.serialNum);
        const before = await readSettings(d.serialNum);
        const { errors, warnings, ordered } = review(writes, before);
        const rows = ordered.map((w) => ({
          setting: w.setting.key,
          label: w.setting.label,
          current: currentValue(w.setting, before) ?? null,
          new: w.value,
          unit: w.setting.kind === "hold" ? w.setting.unit : undefined,
          unchanged: sameValue(currentValue(w.setting, before), w.value) || undefined,
        }));

        if (!a.apply || errors.length) {
          return { serialNum: d.serialNum, mode: "preview", applied: false, changes: rows, errors, warnings, next: errors.length ? "Fix the errors and preview again." : "Confirm with the user, then call again with apply=true." };
        }

        const results: Json[] = [];
        for (const w of ordered) {
          if (sameValue(currentValue(w.setting, before), w.value)) {
            results.push({ setting: w.setting.key, status: "already_set" });
            continue;
          }
          const { path, form } = writeRequest(w, d.serialNum);
          try {
            const body = await eg4.post(path, form);
            if (body.success === true) results.push({ setting: w.setting.key, status: "written" });
            else {
              results.push({ setting: w.setting.key, status: "rejected", message: String(body.msg ?? body.message ?? "EG4 returned success=false") });
              break; // stop on the first refusal so later writes don't land on an unexpected state
            }
          } catch (err) {
            results.push({ setting: w.setting.key, status: "error", message: (err as Error).message });
            break;
          }
        }

        const after = await readSettings(d.serialNum);
        const verification = ordered.map((w) => {
          const now = currentValue(w.setting, after);
          return { setting: w.setting.key, requested: w.value, now: now ?? null, verified: sameValue(now, w.value) };
        });
        const entry = {
          at: new Date().toISOString(),
          serialNum: d.serialNum,
          changes: verification.map((v) => ({
            setting: v.setting,
            from: rows.find((r) => r.setting === v.setting)?.current ?? null,
            to: v.requested,
            verified: v.verified,
            status: results.find((r) => r.setting === v.setting)?.status ?? "not_attempted",
          })),
        };
        try {
          const key = await auditKey();
          const prev = JSON.parse((await env.OAUTH_KV.get(key)) ?? "[]") as unknown[];
          await env.OAUTH_KV.put(key, JSON.stringify([entry, ...prev].slice(0, AUDIT_KEEP)));
        } catch {
          /* audit is best-effort */
        }
        const allVerified = verification.every((v) => v.verified);
        return {
          serialNum: d.serialNum,
          mode: "apply",
          applied: true,
          all_verified: allVerified,
          results,
          verification,
          warnings,
          undo: Object.fromEntries(rows.filter((r) => r.current !== null && !r.unchanged).map((r) => [r.setting, r.current])),
        };
      }),
  );

  server.registerTool(
    "eg4_change_history",
    {
      title: "Recent setting changes",
      description: "The last 50 changes made through this connector (any serial on the account): when, from → to, and whether each verified. Use it to undo.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => run(async () => JSON.parse((await env.OAUTH_KV.get(await auditKey())) ?? "[]")),
  );

  return server;
}
