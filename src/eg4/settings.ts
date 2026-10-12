/**
 * Curated registry of EG4 settings this server can read by name and change.
 *
 * Parameter names, ranges and on/off semantics come from the EG4 monitor's own
 * settings page (Maintenance → Remote Set, FlexBOSS/18kPV "12K" family,
 * portal v2.8.5). Anything not listed here can be read (eg4_get_settings with
 * raw=true) but not written: grid-compliance, CT/meter and firmware parameters
 * are deliberately excluded.
 *
 * How each kind is written:
 *   hold      POST /web/maintain/remoteSet/write              holdParam=…  valueText=…
 *   function  POST /web/maintain/remoteSet/functionControl    functionParam=… enable=true|false
 *   bit       POST /web/maintain/remoteSet/bitParamControl    bitParam=…   value=…
 *   modelBit  POST /web/maintain/remoteSet/bitModelParamControl modelBitParam=… value=…
 *   time      POST /web/maintain/remoteSet/writeTime          timeParam=… hour=… minute=…
 */

export type SettingKind = "hold" | "function" | "bit" | "modelBit" | "time";
export type Group = "battery" | "cutoffs" | "ac_charge" | "peak_shaving" | "forced_discharge" | "backup" | "grid" | "pv" | "general";

interface Base {
  key: string;
  label: string;
  group: Group;
  param: string;
  /** "high": changes how the inverter treats the battery or turns output off; previews call this out. */
  risk?: "high";
  note?: string;
}

export interface HoldSetting extends Base {
  kind: "hold";
  unit: string;
  min: number;
  max: number;
  /** Decimal places EG4 accepts (0 = integers). */
  decimals: number;
  /** Key in the remoteRead response (defaults to param). */
  readKey?: string;
}

export interface FunctionSetting extends Base {
  kind: "function";
  /** Friendly value → EG4's `enable` flag. The flag is not always "on" (e.g. Volt/SOC, Normal/Standby, RSD). */
  values: Record<string, boolean>;
}

export interface ChoiceSetting extends Base {
  kind: "bit" | "modelBit";
  /** Friendly value → numeric code. */
  values: Record<string, number>;
  readKey: string;
}

export interface TimeSetting extends Base {
  kind: "time";
  readHour: string;
  readMinute: string;
}

export type Setting = HoldSetting | FunctionSetting | ChoiceSetting | TimeSetting;

const ONOFF = { on: true, off: false } as const;

const hold = (s: Omit<HoldSetting, "kind">): HoldSetting => ({ kind: "hold", ...s });
const fn = (s: Omit<FunctionSetting, "kind" | "values"> & { values?: Record<string, boolean> }): FunctionSetting => ({
  kind: "function",
  values: s.values ?? ONOFF,
  ...s,
});

/** HOLD_AC_CHARGE_START_TIME_1 → HOLD_AC_CHARGE_START_HOUR_1 / _MINUTE_1 */
function standardTime(key: string, label: string, group: Group, param: string): TimeSetting {
  const m = param.match(/^(.*)_TIME(_\d)?$/)!;
  const suffix = m[2] ?? "";
  return { kind: "time", key, label, group, param, readHour: `${m[1]}_HOUR${suffix}`, readMinute: `${m[1]}_MINUTE${suffix}` };
}

/** Peak-shaving windows are stored in the LSP_HOLD_DIS_CHG_POWER_TIME_37…44 registers. */
function peakTime(key: string, label: string, param: string, hourReg: number): TimeSetting {
  return {
    kind: "time",
    key,
    label,
    group: "peak_shaving",
    param,
    readHour: `LSP_HOLD_DIS_CHG_POWER_TIME_${hourReg}`,
    readMinute: `LSP_HOLD_DIS_CHG_POWER_TIME_${hourReg + 1}`,
  };
}

function windows(prefix: string, labelPrefix: string, group: Group, startParam: string, endParam: string, count: number): TimeSetting[] {
  const out: TimeSetting[] = [];
  for (let i = 0; i < count; i++) {
    const sfx = i === 0 ? "" : `_${i}`;
    const n = i + 1;
    out.push(standardTime(`${prefix}_${n}_start`, `${labelPrefix} window ${n} start`, group, `${startParam}${sfx}`));
    out.push(standardTime(`${prefix}_${n}_end`, `${labelPrefix} window ${n} end`, group, `${endParam}${sfx}`));
  }
  return out;
}

export const SETTINGS: Setting[] = [
  // ---------------------------------------------------------------- general
  fn({
    key: "operating_mode",
    label: "Normal / Standby",
    group: "general",
    param: "FUNC_SET_TO_STANDBY",
    values: { normal: true, standby: false },
    risk: "high",
    note: "Standby stops all charging, discharging and export; the grid bypass relay carries the house.",
  }),

  // ---------------------------------------------------------------- battery
  {
    kind: "modelBit",
    key: "battery_type",
    label: "Battery type",
    group: "battery",
    param: "MODEL_BIT_BATTERY_TYPE",
    readKey: "HOLD_MODEL_batteryType",
    values: { no_battery: 0, lead_acid: 1, lithium: 2 },
    risk: "high",
    note: "Lithium + an EG4 brand enables closed-loop BMS communication. Choose lead_acid only if the battery can't talk to the inverter.",
  },
  {
    kind: "modelBit",
    key: "lithium_brand",
    label: "Lithium brand / no comms",
    group: "battery",
    param: "MODEL_BIT_LITHIUM_TYPE",
    readKey: "HOLD_MODEL_lithiumType",
    values: { eg4: 0, eg4_advanced: 1, briggs: 22, no_comms_15s: 30, no_comms_16s: 31 },
    risk: "high",
    note: "eg4 = closed-loop with EG4 batteries (PowerPro, LifePower4, WallMount). no_comms_16s = 16-cell LiFePO4 controlled by voltage only.",
  },
  fn({
    key: "charge_control",
    label: "Battery charge control",
    group: "battery",
    param: "FUNC_BAT_CHARGE_CONTROL",
    values: { volt: true, soc: false },
    note: "SOC needs closed-loop BMS communication. On this inverter it moves together with discharge_control.",
  }),
  fn({
    key: "discharge_control",
    label: "Battery discharge control",
    group: "battery",
    param: "FUNC_BAT_DISCHARGE_CONTROL",
    values: { volt: true, soc: false },
    note: "Decides whether the *_cutoff_soc_pct or *_cutoff_volt settings apply.",
  }),
  hold({ key: "charge_current_limit_a", label: "Charge current limit", group: "battery", param: "HOLD_LEAD_ACID_CHARGE_RATE", unit: "A", min: 0, max: 250, decimals: 0 }),
  hold({ key: "discharge_current_limit_a", label: "Discharge current limit", group: "battery", param: "HOLD_LEAD_ACID_DISCHARGE_RATE", unit: "A", min: 0, max: 250, decimals: 0 }),
  hold({ key: "system_charge_soc_limit_pct", label: "System charge SOC limit", group: "battery", param: "HOLD_SYSTEM_CHARGE_SOC_LIMIT", unit: "%", min: 10, max: 101, decimals: 0, note: "101 lets the BMS top-balance past 100%." }),
  hold({ key: "system_charge_volt_limit_v", label: "System charge volt limit", group: "battery", param: "HOLD_SYSTEM_CHARGE_VOLT_LIMIT", unit: "V", min: 40, max: 59.5, decimals: 1 }),
  hold({ key: "charge_voltage_v", label: "Absorb / charge voltage", group: "battery", param: "HOLD_LEAD_ACID_CHARGE_VOLT_REF", unit: "V", min: 50, max: 59, decimals: 1 }),
  hold({ key: "float_voltage_v", label: "Float voltage", group: "battery", param: "HOLD_FLOATING_VOLTAGE", unit: "V", min: 50, max: 56, decimals: 1 }),
  hold({ key: "battery_capacity_ah", label: "Battery capacity (lead-acid mode)", group: "battery", param: "_12K_HOLD_LEAD_CAPACITY", unit: "Ah", min: 50, max: 5000, decimals: 0 }),
  fn({ key: "battery_calibration", label: "Battery calibration", group: "battery", param: "FUNC_BATTERY_CALIBRATION_EN" }),
  fn({ key: "charge_last", label: "Charge last (PV to loads first)", group: "battery", param: "FUNC_CHARGE_LAST" }),

  // ---------------------------------------------------------------- cutoffs
  hold({ key: "on_grid_cutoff_soc_pct", label: "On-grid cut-off SOC", group: "cutoffs", param: "HOLD_DISCHG_CUT_OFF_SOC_EOD", unit: "%", min: 0, max: 90, decimals: 0, note: "Battery stops discharging at this SOC while the grid is up (SOC control). Must be ≥ off_grid_cutoff_soc_pct." }),
  hold({ key: "off_grid_cutoff_soc_pct", label: "Off-grid cut-off SOC", group: "cutoffs", param: "HOLD_SOC_LOW_LIMIT_EPS_DISCHG", unit: "%", min: 0, max: 90, decimals: 0, note: "Battery stops discharging at this SOC during an outage (SOC control)." }),
  hold({ key: "on_grid_cutoff_volt", label: "On-grid cut-off voltage", group: "cutoffs", param: "HOLD_ON_GRID_EOD_VOLTAGE", unit: "V", min: 40, max: 56, decimals: 1, note: "Applies only with volt discharge control." }),
  hold({ key: "off_grid_cutoff_volt", label: "Off-grid cut-off voltage", group: "cutoffs", param: "HOLD_LEAD_ACID_DISCHARGE_CUT_OFF_VOLT", unit: "V", min: 40, max: 56, decimals: 1, note: "Applies only with volt discharge control." }),
  hold({ key: "start_discharge_import_w", label: "Start discharge at grid import", group: "cutoffs", param: "HOLD_P_TO_USER_START_DISCHG", unit: "W", min: 50, max: 10000, decimals: 0 }),

  // ---------------------------------------------------------------- AC (grid) charging
  fn({ key: "ac_charge_enabled", label: "AC charge (charge from grid)", group: "ac_charge", param: "FUNC_AC_CHARGE", note: "Can't be on together with battery_backup_mode." }),
  {
    kind: "bit",
    key: "ac_charge_based_on",
    label: "AC charge based on",
    group: "ac_charge",
    param: "BIT_AC_CHARGE_TYPE",
    readKey: "BIT_AC_CHARGE_TYPE",
    values: { time: 0, soc_volt: 1, time_and_soc_volt: 2 },
  },
  hold({ key: "ac_charge_power_kw", label: "AC charge power", group: "ac_charge", param: "HOLD_AC_CHARGE_POWER_CMD", unit: "kW", min: 0, max: 25.5, decimals: 1 }),
  hold({ key: "ac_charge_start_soc_pct", label: "Start AC charge SOC", group: "ac_charge", param: "HOLD_AC_CHARGE_START_BATTERY_SOC", unit: "%", min: 0, max: 100, decimals: 0 }),
  hold({ key: "ac_charge_stop_soc_pct", label: "Stop AC charge SOC", group: "ac_charge", param: "HOLD_AC_CHARGE_SOC_LIMIT", unit: "%", min: 0, max: 100, decimals: 0 }),
  hold({ key: "ac_charge_start_volt", label: "Start AC charge voltage", group: "ac_charge", param: "HOLD_AC_CHARGE_START_BATTERY_VOLTAGE", unit: "V", min: 40, max: 57, decimals: 1 }),
  hold({ key: "ac_charge_stop_volt", label: "Stop AC charge voltage", group: "ac_charge", param: "HOLD_AC_CHARGE_END_BATTERY_VOLTAGE", unit: "V", min: 42, max: 59, decimals: 1 }),
  ...windows("ac_charge_window", "AC charge", "ac_charge", "HOLD_AC_CHARGE_START_TIME", "HOLD_AC_CHARGE_END_TIME", 3),
  fn({ key: "sporadic_charge", label: "Sporadic charge", group: "ac_charge", param: "FUNC_SPORADIC_CHARGE" }),

  // ---------------------------------------------------------------- peak shaving
  fn({ key: "peak_shaving_enabled", label: "Grid peak-shaving", group: "peak_shaving", param: "FUNC_GRID_PEAK_SHAVING" }),
  hold({ key: "peak_shaving_1_grid_limit_kw", label: "Peak-shaving window 1 grid limit", group: "peak_shaving", param: "_12K_HOLD_GRID_PEAK_SHAVING_POWER", unit: "kW", min: 0, max: 25.5, decimals: 1, note: "Max grid draw while peak-shaving; 0 = battery covers all load." }),
  hold({ key: "peak_shaving_1_start_soc_pct", label: "Peak-shaving window 1 start SOC", group: "peak_shaving", param: "_12K_HOLD_GRID_PEAK_SHAVING_SOC", unit: "%", min: 0, max: 100, decimals: 0 }),
  hold({ key: "peak_shaving_1_start_volt", label: "Peak-shaving window 1 start voltage", group: "peak_shaving", param: "_12K_HOLD_GRID_PEAK_SHAVING_VOLT", unit: "V", min: 40, max: 59, decimals: 1 }),
  peakTime("peak_shaving_window_1_start", "Peak-shaving window 1 start", "HOLD_PEAK_SHAVING_START_TIME_1", 37),
  peakTime("peak_shaving_window_1_end", "Peak-shaving window 1 end", "HOLD_PEAK_SHAVING_END_TIME_1", 39),
  hold({ key: "peak_shaving_2_grid_limit_kw", label: "Peak-shaving window 2 grid limit", group: "peak_shaving", param: "_12K_HOLD_GRID_PEAK_SHAVING_POWER_2", unit: "kW", min: 0, max: 25.5, decimals: 1 }),
  hold({ key: "peak_shaving_2_start_soc_pct", label: "Peak-shaving window 2 start SOC", group: "peak_shaving", param: "_12K_HOLD_GRID_PEAK_SHAVING_SOC_2", unit: "%", min: 0, max: 100, decimals: 0 }),
  hold({ key: "peak_shaving_2_start_volt", label: "Peak-shaving window 2 start voltage", group: "peak_shaving", param: "_12K_HOLD_GRID_PEAK_SHAVING_VOLT_2", unit: "V", min: 40, max: 59, decimals: 1 }),
  peakTime("peak_shaving_window_2_start", "Peak-shaving window 2 start", "HOLD_PEAK_SHAVING_START_TIME_2", 41),
  peakTime("peak_shaving_window_2_end", "Peak-shaving window 2 end", "HOLD_PEAK_SHAVING_END_TIME_2", 43),

  // ---------------------------------------------------------------- forced discharge
  fn({ key: "forced_discharge_enabled", label: "Forced discharge", group: "forced_discharge", param: "FUNC_FORCED_DISCHG_EN", note: "Can't be on together with export_pv_only. Exports to the grid only if grid_sell_back is on." }),
  hold({ key: "forced_discharge_power_kw", label: "Forced discharge power", group: "forced_discharge", param: "HOLD_FORCED_DISCHG_POWER_CMD", unit: "kW", min: 0, max: 25.5, decimals: 1 }),
  hold({ key: "forced_discharge_stop_soc_pct", label: "Forced discharge stop SOC", group: "forced_discharge", param: "HOLD_FORCED_DISCHG_SOC_LIMIT", unit: "%", min: 0, max: 100, decimals: 0 }),
  hold({ key: "forced_discharge_stop_volt", label: "Forced discharge stop voltage", group: "forced_discharge", param: "_12K_HOLD_STOP_DISCHG_VOLT", unit: "V", min: 40, max: 56, decimals: 1 }),
  ...windows("forced_discharge_window", "Forced discharge", "forced_discharge", "HOLD_FORCED_DISCHARGE_START_TIME", "HOLD_FORCED_DISCHARGE_END_TIME", 3),

  // ---------------------------------------------------------------- backup
  fn({ key: "battery_backup_mode", label: "Battery backup mode", group: "backup", param: "FUNC_BATTERY_BACKUP_CTRL", note: "Holds the battery as last-resort backup. Can't be on together with ac_charge_enabled." }),
  fn({ key: "power_backup_eps", label: "Power backup (EPS output)", group: "backup", param: "FUNC_EPS_EN", risk: "high", note: "Off means no backup power during an outage." }),
  fn({ key: "seamless_eps_switching", label: "Seamless EPS switching", group: "backup", param: "FUNC_SW_SEAMLESSLY_EN" }),

  // ---------------------------------------------------------------- grid export
  fn({ key: "grid_sell_back", label: "Grid sell back (export)", group: "grid", param: "FUNC_FEED_IN_GRID_EN", note: "Exporting may need utility permission (NEM interconnection)." }),
  hold({ key: "grid_sell_back_power_kw", label: "Grid sell back power", group: "grid", param: "HOLD_FEED_IN_GRID_POWER_PERCENT", unit: "kW", min: 0, max: 25.5, decimals: 1 }),
  fn({ key: "export_pv_only", label: "Export PV only", group: "grid", param: "FUNC_PV_SELL_TO_GRID_EN" }),
  fn({ key: "fast_zero_export", label: "Fast zero export", group: "grid", param: "FUNC_RUN_WITHOUT_GRID" }),

  // ---------------------------------------------------------------- PV
  fn({ key: "pv_charge_priority", label: "PV charge priority", group: "pv", param: "FUNC_FORCED_CHG_EN" }),
  hold({ key: "pv_charge_power_kw", label: "PV charge priority power", group: "pv", param: "HOLD_FORCED_CHG_POWER_CMD", unit: "kW", min: 0, max: 25.5, decimals: 1 }),
  hold({ key: "pv_charge_stop_soc_pct", label: "PV charge priority stop SOC", group: "pv", param: "HOLD_FORCED_CHG_SOC_LIMIT", unit: "%", min: 0, max: 100, decimals: 0 }),
  ...windows("pv_charge_window", "PV charge priority", "pv", "HOLD_FORCED_CHARGE_START_TIME", "HOLD_FORCED_CHARGE_END_TIME", 3),
];

export const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export const GROUPS: Group[] = ["general", "battery", "cutoffs", "ac_charge", "peak_shaving", "forced_discharge", "backup", "grid", "pv"];

// ------------------------------------------------------------------ decoding

export type Flat = Record<string, unknown>;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Reads a setting's current friendly value out of a flat remoteRead map. undefined = not present. */
export function currentValue(s: Setting, flat: Flat): string | number | undefined {
  switch (s.kind) {
    case "hold": {
      const raw = flat[s.readKey ?? s.param];
      if (raw === undefined || raw === null || raw === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : String(raw);
    }
    case "function": {
      const raw = flat[s.param];
      if (typeof raw !== "boolean") return undefined;
      return Object.entries(s.values).find(([, v]) => v === raw)?.[0];
    }
    case "bit":
    case "modelBit": {
      const raw = flat[s.readKey];
      if (raw === undefined || raw === null) return undefined;
      const n = Number(raw);
      return Object.entries(s.values).find(([, v]) => v === n)?.[0] ?? `code_${n}`;
    }
    case "time": {
      const h = flat[s.readHour];
      const m = flat[s.readMinute];
      if (h === undefined || m === undefined) return undefined;
      return `${pad2(Number(h))}:${pad2(Number(m))}`;
    }
  }
}

export function describe(s: Setting): Record<string, unknown> {
  const base: Record<string, unknown> = { key: s.key, label: s.label, group: s.group, kind: s.kind };
  if (s.kind === "hold") Object.assign(base, { unit: s.unit, min: s.min, max: s.max, decimals: s.decimals });
  if (s.kind === "function" || s.kind === "bit" || s.kind === "modelBit") base.values = Object.keys(s.values);
  if (s.kind === "time") base.format = "HH:MM (24h, inverter local time)";
  if (s.risk) base.risk = s.risk;
  if (s.note) base.note = s.note;
  return base;
}

// ------------------------------------------------------------------ validation

export interface PlannedWrite {
  setting: Setting;
  /** Normalised friendly value (number for hold, key for choices/functions, HH:MM for time). */
  value: string | number;
}

export class SettingInputError extends Error {}

/** Validates and normalises one requested change. Throws SettingInputError with a helpful message. */
export function plan(key: string, input: unknown): PlannedWrite {
  const s = BY_KEY.get(key);
  if (!s) {
    const close = SETTINGS.filter((x) => x.key.includes(key.toLowerCase().replace(/[^a-z0-9]+/g, "_").split("_")[0] ?? "")).map((x) => x.key);
    throw new SettingInputError(`Unknown setting "${key}".${close.length ? ` Did you mean: ${close.slice(0, 8).join(", ")}?` : " See eg4_describe_settings."}`);
  }
  switch (s.kind) {
    case "hold": {
      const n = typeof input === "number" ? input : Number(String(input).trim());
      if (!Number.isFinite(n)) throw new SettingInputError(`${key} needs a number (${s.unit}).`);
      if (n < s.min || n > s.max) throw new SettingInputError(`${key} must be between ${s.min} and ${s.max} ${s.unit} (got ${n}).`);
      const f = 10 ** s.decimals;
      const rounded = Math.round(n * f) / f;
      if (Math.abs(rounded - n) > 1e-9) throw new SettingInputError(`${key} accepts ${s.decimals === 0 ? "whole numbers" : `${s.decimals} decimal place(s)`} (got ${n}).`);
      return { setting: s, value: rounded };
    }
    case "function":
    case "bit":
    case "modelBit": {
      const v = String(input).trim().toLowerCase();
      const aliases: Record<string, string> = { true: "on", false: "off", enable: "on", enabled: "on", disable: "off", disabled: "off" };
      const k = s.values[v] !== undefined ? v : aliases[v] && s.values[aliases[v]!] !== undefined ? aliases[v]! : undefined;
      if (!k) throw new SettingInputError(`${key} must be one of: ${Object.keys(s.values).join(", ")} (got "${input}").`);
      return { setting: s, value: k };
    }
    case "time": {
      const m = String(input).trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) throw new SettingInputError(`${key} must be a 24-hour time like "15:00" (got "${input}").`);
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) throw new SettingInputError(`${key} must be between 00:00 and 23:59 (got "${input}").`);
      return { setting: s, value: `${pad2(h)}:${pad2(min)}` };
    }
  }
}

/** Builds the form for one write. */
export function writeRequest(w: PlannedWrite, serialNum: string): { path: string; form: Record<string, string> } {
  const common = { inverterSn: serialNum, clientType: "WEB", remoteSetType: "NORMAL" };
  const s = w.setting;
  switch (s.kind) {
    case "hold":
      return { path: "/WManage/web/maintain/remoteSet/write", form: { ...common, holdParam: s.param, valueText: String(w.value) } };
    case "function":
      return { path: "/WManage/web/maintain/remoteSet/functionControl", form: { ...common, functionParam: s.param, enable: String(s.values[String(w.value)]) } };
    case "bit":
      return { path: "/WManage/web/maintain/remoteSet/bitParamControl", form: { ...common, bitParam: s.param, value: String(s.values[String(w.value)]) } };
    case "modelBit":
      return { path: "/WManage/web/maintain/remoteSet/bitModelParamControl", form: { ...common, modelBitParam: s.param, value: String(s.values[String(w.value)]) } };
    case "time": {
      const [hour, minute] = String(w.value).split(":");
      return { path: "/WManage/web/maintain/remoteSet/writeTime", form: { ...common, timeParam: s.param, hour: String(Number(hour)), minute: String(Number(minute)) } };
    }
  }
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Math.abs(Number(a) - Number(b)) < 1e-6;
  return String(a) === String(b);
}

/**
 * Cross-setting checks against the state the inverter will end up in.
 * Returns blocking errors and non-blocking warnings, and an order to apply writes in.
 */
export function review(writes: PlannedWrite[], current: Flat): { errors: string[]; warnings: string[]; ordered: PlannedWrite[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const next = new Map<string, string | number | undefined>();
  for (const s of SETTINGS) next.set(s.key, currentValue(s, current));
  const changed = new Set(writes.map((w) => w.setting.key));
  for (const w of writes) next.set(w.setting.key, w.value);
  const get = (k: string) => next.get(k);

  const dupes = writes.map((w) => w.setting.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupes.length) errors.push(`Each setting can appear once per request (repeated: ${[...new Set(dupes)].join(", ")}).`);

  const onSoc = Number(get("on_grid_cutoff_soc_pct"));
  const offSoc = Number(get("off_grid_cutoff_soc_pct"));
  if (Number.isFinite(onSoc) && Number.isFinite(offSoc) && offSoc > onSoc) {
    errors.push(`off_grid_cutoff_soc_pct (${offSoc}%) must be ≤ on_grid_cutoff_soc_pct (${onSoc}%).`);
  }
  if (get("ac_charge_enabled") === "on" && get("battery_backup_mode") === "on" && (changed.has("ac_charge_enabled") || changed.has("battery_backup_mode"))) {
    errors.push("ac_charge_enabled and battery_backup_mode can't both be on; EG4 refuses the second one.");
  }
  if (get("forced_discharge_enabled") === "on" && get("export_pv_only") === "on" && (changed.has("forced_discharge_enabled") || changed.has("export_pv_only"))) {
    errors.push("forced_discharge_enabled and export_pv_only can't both be on.");
  }

  for (const w of writes) {
    if (w.setting.risk === "high") warnings.push(`${w.setting.key} is a high-impact setting: ${w.setting.note ?? w.setting.label}`);
  }
  const ctl = get("discharge_control");
  for (const w of writes) {
    const k = w.setting.key;
    if (ctl === "volt" && /_cutoff_soc_pct$/.test(k)) warnings.push(`${k} has no effect while discharge_control is "volt".`);
    if (ctl === "soc" && /_cutoff_volt$/.test(k)) warnings.push(`${k} has no effect while discharge_control is "soc".`);
  }
  if (changed.has("battery_type") && get("battery_type") === "lithium" && !changed.has("lithium_brand") && get("lithium_brand") === undefined) {
    warnings.push("Set lithium_brand too (eg4 for EG4 batteries with a comms cable).");
  }
  if (changed.has("battery_type") && get("battery_type") === "lithium" && get("lithium_brand") !== undefined && !String(get("lithium_brand")).startsWith("no_comms")) {
    warnings.push("Closed-loop lithium needs a working BMS cable from the master battery to the inverter; without it the inverter raises a BMS comm fault and stops using the battery. Check eg4_get_status afterwards (soc and bms fields should populate).");
  }
  if (Number.isFinite(onSoc) && onSoc < 10 && changed.has("on_grid_cutoff_soc_pct")) {
    warnings.push(`on_grid_cutoff_soc_pct ${onSoc}% leaves little reserve for an outage or for SOC drift.`);
  }

  // Apply order: battery type/brand before control mode; the cut-off pair in whichever order keeps off ≤ on at every step.
  const rank = (w: PlannedWrite): number => {
    const k = w.setting.key;
    if (k === "battery_type") return 0;
    if (k === "lithium_brand") return 1;
    if (k === "charge_control" || k === "discharge_control") return 2;
    if (k === "off_grid_cutoff_soc_pct") return Number(w.value) < Number(currentValue(w.setting, current) ?? Infinity) ? 3 : 5;
    if (k === "on_grid_cutoff_soc_pct") return 4;
    if (w.setting.kind === "function" && w.value === "off") return 6; // turn things off before turning others on
    return 7;
  };
  const ordered = [...writes].sort((a, b) => rank(a) - rank(b));
  return { errors, warnings, ordered };
}
