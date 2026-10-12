import { describe, expect, it } from "vitest";
import { analyzeDay, decodeDay, decodeStatus, EV2A } from "../src/eg4/decode";
import { BY_KEY, currentValue, plan, review, SETTINGS, SettingInputError, writeRequest } from "../src/eg4/settings";
import { baseSettings, point } from "./helpers";

describe("settings registry", () => {
  it("has unique keys and params per kind", () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const params = SETTINGS.map((s) => `${s.kind}:${s.param}`);
    expect(new Set(params).size).toBe(params.length);
  });

  it("decodes EG4's inverted flags (discharge control false = SOC, standby flag true = normal)", () => {
    const flat = baseSettings();
    expect(currentValue(BY_KEY.get("discharge_control")!, flat)).toBe("soc");
    expect(currentValue(BY_KEY.get("operating_mode")!, flat)).toBe("normal");
    expect(currentValue(BY_KEY.get("battery_type")!, flat)).toBe("lithium");
    expect(currentValue(BY_KEY.get("lithium_brand")!, flat)).toBe("eg4");
    expect(currentValue(BY_KEY.get("on_grid_cutoff_soc_pct")!, flat)).toBe(15);
    expect(currentValue(BY_KEY.get("ac_charge_window_1_end")!, flat)).toBe("15:00");
    expect(currentValue(BY_KEY.get("peak_shaving_window_1_end")!, flat)).toBe("23:59");
  });

  it("validates ranges, decimals, choices and times", () => {
    expect(plan("on_grid_cutoff_soc_pct", 15).value).toBe(15);
    expect(plan("on_grid_cutoff_volt", "48.5").value).toBe(48.5);
    expect(() => plan("on_grid_cutoff_soc_pct", 95)).toThrow(/between 0 and 90/);
    expect(() => plan("on_grid_cutoff_soc_pct", 15.5)).toThrow(/whole numbers/);
    expect(plan("ac_charge_enabled", "Enable").value).toBe("on");
    expect(plan("discharge_control", "SOC").value).toBe("soc");
    expect(() => plan("discharge_control", "on")).toThrow(/volt, soc/);
    expect(plan("ac_charge_window_1_end", "9:05").value).toBe("09:05");
    expect(() => plan("ac_charge_window_1_end", "24:00")).toThrow(SettingInputError);
    expect(() => plan("grid_volt_limit", 1)).toThrow(/Unknown setting/);
  });

  it("builds the exact forms the EG4 portal sends", () => {
    expect(writeRequest(plan("on_grid_cutoff_soc_pct", 15), "SN1")).toEqual({
      path: "/WManage/web/maintain/remoteSet/write",
      form: { inverterSn: "SN1", clientType: "WEB", remoteSetType: "NORMAL", holdParam: "HOLD_DISCHG_CUT_OFF_SOC_EOD", valueText: "15" },
    });
    expect(writeRequest(plan("discharge_control", "soc"), "SN1").form).toMatchObject({ functionParam: "FUNC_BAT_DISCHARGE_CONTROL", enable: "false" });
    expect(writeRequest(plan("battery_type", "lithium"), "SN1")).toMatchObject({ path: "/WManage/web/maintain/remoteSet/bitModelParamControl", form: { modelBitParam: "MODEL_BIT_BATTERY_TYPE", value: "2" } });
    expect(writeRequest(plan("peak_shaving_window_1_start", "16:30"), "SN1").form).toMatchObject({ timeParam: "HOLD_PEAK_SHAVING_START_TIME_1", hour: "16", minute: "30" });
    expect(writeRequest(plan("ac_charge_based_on", "time"), "SN1").form).toMatchObject({ bitParam: "BIT_AC_CHARGE_TYPE", value: "0" });
  });

  it("blocks off-grid cut-off above on-grid and orders the pair safely", () => {
    const flat = baseSettings(); // on 15, off 10
    expect(review([plan("off_grid_cutoff_soc_pct", 20)], flat).errors[0]).toMatch(/must be ≤/);
    // Lowering both: off first so off ≤ on at every step.
    const down = review([plan("on_grid_cutoff_soc_pct", 8), plan("off_grid_cutoff_soc_pct", 5)], flat);
    expect(down.errors).toEqual([]);
    expect(down.ordered.map((w) => w.setting.key)).toEqual(["off_grid_cutoff_soc_pct", "on_grid_cutoff_soc_pct"]);
    // Raising both: on first.
    const up = review([plan("off_grid_cutoff_soc_pct", 25), plan("on_grid_cutoff_soc_pct", 30)], flat);
    expect(up.ordered.map((w) => w.setting.key)).toEqual(["on_grid_cutoff_soc_pct", "off_grid_cutoff_soc_pct"]);
  });

  it("enforces EG4's mutually exclusive modes and warns about ineffective settings", () => {
    const flat = baseSettings(); // AC charge on, SOC control
    expect(review([plan("battery_backup_mode", "on")], flat).errors[0]).toMatch(/can't both be on/);
    expect(review([plan("battery_backup_mode", "on"), plan("ac_charge_enabled", "off")], flat).errors).toEqual([]);
    expect(review([plan("on_grid_cutoff_volt", 48.5)], flat).warnings.join(" ")).toMatch(/no effect while discharge_control is "soc"/);
    expect(review([plan("operating_mode", "standby")], flat).warnings.join(" ")).toMatch(/high-impact/);
  });
});

describe("decoding", () => {
  it("converts EG4 units", () => {
    const s = decodeStatus(
      { serialNum: "SN", soc: 90, vBat: 529, batPower: -855, vacr: 2406, fac: 6003, pToUser: 120, pToGrid: 0, bmsBatCurrent: -1670, lost: false },
      { hasCellExtremes: true, globalMaxCellVoltage: 3311, globalMinCellVoltage: 3306, globalMaxCellTemp: 190, globalMinCellTemp: 185, bmsCycleCnt: 75 },
    ) as any;
    expect(s.battery.voltage_v).toBe(52.9);
    expect(s.battery.power_w).toBe(855); // discharging is positive
    expect(s.grid.voltage_v).toBe(240.6);
    expect(s.grid.frequency_hz).toBe(60.03);
    expect(s.battery.cells.spread_mv).toBe(5);
    expect(s.battery.cells.min_temp_c).toBe(18.5);
    expect(s.battery.bms.current_a).toBe(-16.7);
  });

  it("finds the evening the battery quit early (Oct 8 pattern)", () => {
    // Battery carries 4 kW from 16:00 to 17:45, then idles while the house imports until 21:00.
    const data = [] as ReturnType<typeof point>[];
    for (let m = 15 * 60; m < 24 * 60; m += 15) {
      const hh = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const carrying = m >= 16 * 60 && m < 17 * 60 + 45;
      data.push(point(hh, carrying ? { battery: 4000, grid: 0, load: 4000, soc: 80 } : { battery: 0, grid: 3000, load: 3000, soc: 78 }));
    }
    const r = analyzeDay(decodeDay(data), EV2A) as any;
    expect(r.by_period.peak.battery_discharge_kwh).toBeCloseTo(7, 1); // 1.75 h × 4 kW
    expect(r.by_period.peak.grid_import_kwh).toBeCloseTo(9.75, 1); // 3.25 h × 3 kW
    expect(r.by_period.peak.battery_share_of_load_pct).toBe(42);
    expect(r.battery_first_went_idle_while_importing_in_costly_period).toMatchObject({ time: "15:00", period: "part_peak" });
    expect(r.soc.at_start_of_first_costly_period).toBe(78);
  });

  it("estimates cost when rates are given", () => {
    const data = [point("16:00", { grid: 2000, load: 2000 }), point("17:00", { grid: 2000, load: 2000 })];
    const r = analyzeDay(decodeDay(data), [
      { name: "peak", windows: ["16:00-21:00"], rate_per_kwh: 0.5 },
      { name: "off_peak", windows: ["00:00-16:00", "21:00-24:00"], rate_per_kwh: 0.2 },
    ]) as any;
    // first sample: 15-minute gap cap; second: 5-minute tail
    expect(r.by_period.peak.grid_import_kwh).toBeCloseTo(0.67, 2);
    expect(r.estimated_import_cost).toBeCloseTo(0.33, 2);
  });
});
