import type { Json } from "./client";

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const div = (v: unknown, d: number): number | null => {
  const n = num(v);
  return n === null ? null : Math.round((n / d) * 1000) / 1000;
};

/**
 * getInverterRuntime + getBatteryInfo → one status object in real units.
 * EG4 sends voltages ×10, frequency ×100, cell mV, cell temps ×10, energy in 0.1 kWh.
 */
export function decodeStatus(runtime: Json, battery: Json | null): Json {
  // Prefer the explicit charge/discharge figures; fall back to batPower (negative = discharging).
  const pChg = num(runtime.pCharge);
  const pDis = num(runtime.pDisCharge);
  const batPower = pChg !== null && pDis !== null ? pChg - pDis : num(runtime.batPower);
  const out: Json = {
    serialNum: runtime.serialNum,
    deviceTime: runtime.deviceTime,
    status: runtime.statusText,
    statusCode: runtime.status,
    faultCode: runtime.faultCode,
    warningCode: runtime.warningCode,
    online: runtime.lost === false,
    battery: {
      soc_pct: num(runtime.soc),
      voltage_v: div(runtime.vBat, 10),
      power_w: batPower === null ? null : -batPower,
      power_note: "positive = discharging to the house, negative = charging",
      charge_w: num(runtime.pCharge),
      discharge_w: num(runtime.pDisCharge),
      type: runtime.batteryType,
      modules: num(runtime.batParallelNum),
      capacity_ah: num(runtime.batCapacity),
      bms: {
        charge_allowed: runtime.bmsCharge,
        discharge_allowed: runtime.bmsDischarge,
        force_charge: runtime.bmsForceCharge,
        max_charge_current_a: num(runtime.maxChgCurrValue),
        max_discharge_current_a: num(runtime.maxDischgCurrValue),
        current_a: div(runtime.bmsBatCurrent, 100),
      },
    },
    grid: {
      import_w: num(runtime.pToUser),
      export_w: num(runtime.pToGrid),
      voltage_v: div(runtime.vacr, 10),
      frequency_hz: div(runtime.fac, 100),
    },
    load: {
      consumption_w: num(runtime.consumptionPower),
      eps_w: num(runtime.peps),
      eps_l1_w: num(runtime.pEpsL1N),
      eps_l2_w: num(runtime.pEpsL2N),
    },
    pv: {
      total_w: num(runtime.ppv),
      strings: [1, 2, 3].map((i) => ({ power_w: num(runtime[`ppv${i}`]), voltage_v: div(runtime[`vpv${i}`], 10) })),
    },
    generator: { in_use: runtime._12KUsingGenerator, power_w: num(runtime.genPower), dry_contact: runtime.genDryContact },
    inverter: {
      output_w: num(runtime.pinv),
      rectifier_w: num(runtime.prec),
      internal_temp_c: num(runtime.tinner),
      radiator_temp_c: [num(runtime.tradiator1), num(runtime.tradiator2)],
      firmware: runtime.fwCode,
      power_rating: runtime.powerRatingText,
    },
  };
  if (battery && battery.success !== false) {
    const bat = out.battery as Json;
    Object.assign(bat, {
      remaining_ah: num(battery.currentBatteryCharge),
      full_ah: num(battery.maxBatteryCharge),
      cycle_count: num(battery.bmsCycleCnt),
      status: battery.batStatus,
      cells: battery.hasCellExtremes
        ? {
            max_voltage_v: div(battery.globalMaxCellVoltage, 1000),
            min_voltage_v: div(battery.globalMinCellVoltage, 1000),
            spread_mv: (num(battery.globalMaxCellVoltage) ?? 0) - (num(battery.globalMinCellVoltage) ?? 0),
            max_temp_c: div(battery.globalMaxCellTemp, 10),
            min_temp_c: div(battery.globalMinCellTemp, 10),
          }
        : null,
      modules_detail: Array.isArray(battery.batteryArray) && battery.batteryArray.length ? battery.batteryArray : undefined,
    });
  }
  return out;
}

const kwh = (v: unknown) => div(v, 10);

export function decodeEnergy(e: Json): Json {
  return {
    serialNum: e.serialNum,
    soc_pct: num(e.soc),
    today_kwh: {
      consumption: kwh(e.todayUsage),
      grid_import: kwh(e.todayImport),
      grid_export: kwh(e.todayExport),
      battery_charge: kwh(e.todayCharging),
      battery_discharge: kwh(e.todayDischarging),
      solar: kwh(e.todayYielding),
    },
    total_kwh: {
      consumption: kwh(e.totalUsage),
      grid_import: kwh(e.totalImport),
      grid_export: kwh(e.totalExport),
      battery_charge: kwh(e.totalCharging),
      battery_discharge: kwh(e.totalDischarging),
      solar: kwh(e.totalYielding),
    },
  };
}

/** monthColumn / yearColumn rows → kWh. */
export function decodeColumns(rows: unknown, indexKey: "day" | "month"): Json[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r: Json) => ({
    [indexKey]: r[indexKey],
    consumption_kwh: kwh(r.eConsumptionDay ?? r.eLoadDay),
    grid_import_kwh: kwh(r.eToUserDay),
    grid_export_kwh: kwh(r.eToGridDay),
    battery_charge_kwh: kwh(r.eChgDay),
    battery_discharge_kwh: kwh(r.eDisChgDay),
    solar_kwh: kwh((num(r.ePv1Day) ?? 0) + (num(r.ePv2Day) ?? 0) + (num(r.ePv3Day) ?? 0)),
    inverter_output_kwh: kwh(r.eInvDay),
    rectifier_kwh: kwh(r.eRecDay),
  }));
}

// ------------------------------------------------------------------ day series

export interface Sample {
  /** Local time "YYYY-MM-DD HH:mm:ss" as EG4 reports it (plant time zone). */
  time: string;
  minuteOfDay: number;
  /** Watts. Grid: positive = import. Battery: positive = discharge. */
  grid_w: number;
  battery_w: number;
  load_w: number;
  solar_w: number;
  soc_pct: number | null;
}

/** dayMultiLine data → samples. EG4 reports gridPower negative for import; we flip it. */
export function decodeDay(data: unknown): Sample[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((p: Json) => {
      const time = String(p.time ?? "");
      const m = time.match(/ (\d{2}):(\d{2})/);
      return {
        time,
        minuteOfDay: m ? Number(m[1]) * 60 + Number(m[2]) : 0,
        grid_w: -(num(p.gridPower) ?? 0),
        battery_w: num(p.batteryDischarging) ?? 0,
        load_w: num(p.consumption) ?? 0,
        solar_w: num(p.solarPv) ?? 0,
        soc_pct: num(p.soc),
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Averages samples into fixed buckets for a compact series. */
export function downsample(samples: Sample[], bucketMin: number): Json[] {
  const buckets = new Map<number, Sample[]>();
  for (const s of samples) {
    const b = Math.floor(s.minuteOfDay / bucketMin) * bucketMin;
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(s);
  }
  const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, xs]) => ({
      t: `${String(Math.floor(b / 60)).padStart(2, "0")}:${String(b % 60).padStart(2, "0")}`,
      grid_w: avg(xs.map((x) => x.grid_w)),
      battery_w: avg(xs.map((x) => x.battery_w)),
      load_w: avg(xs.map((x) => x.load_w)),
      solar_w: avg(xs.map((x) => x.solar_w)),
      soc_pct: xs[xs.length - 1]!.soc_pct,
    }));
}

// ------------------------------------------------------------------ time-of-use

export interface Period {
  name: string;
  /** "HH:MM-HH:MM", end exclusive; "24:00" allowed as an end. */
  windows: string[];
  rate_per_kwh?: number;
}

/** PG&E EV2-A (residential EV TOU): peak 4–9 pm, part-peak 3–4 pm and 9 pm–midnight, off-peak otherwise. */
export const EV2A: Period[] = [
  { name: "peak", windows: ["16:00-21:00"] },
  { name: "part_peak", windows: ["15:00-16:00", "21:00-24:00"] },
  { name: "off_peak", windows: ["00:00-15:00"] },
];

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

export function parsePeriods(periods: Period[]): { name: string; ranges: [number, number][]; rate?: number }[] {
  return periods.map((p) => ({
    name: p.name,
    rate: p.rate_per_kwh,
    ranges: p.windows.map((w) => {
      const m = w.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      if (!m) throw new Error(`Bad window "${w}" (use HH:MM-HH:MM)`);
      return [toMin(m[1]!), toMin(m[2]!)] as [number, number];
    }),
  }));
}

/**
 * Integrates a day's samples into per-period energy and spots evenings where the
 * battery sat idle while the house imported during a costly period.
 */
export function analyzeDay(samples: Sample[], periods: Period[], idleThresholdW = 150, maxGapMin = 15): Json {
  const parsed = parsePeriods(periods);
  const periodOf = (min: number) => parsed.find((p) => p.ranges.some(([a, b]) => min >= a && min < b))?.name ?? "unassigned";
  const acc = new Map<string, { import_kwh: number; export_kwh: number; load_kwh: number; battery_discharge_kwh: number; battery_charge_kwh: number; idle_import_min: number }>();
  const blank = () => ({ import_kwh: 0, export_kwh: 0, load_kwh: 0, battery_discharge_kwh: 0, battery_charge_kwh: 0, idle_import_min: 0 });
  for (const p of parsed) acc.set(p.name, blank());

  let firstIdle: Json | null = null;
  const costly = new Set(parsed.filter((p) => p.name !== "off_peak").map((p) => p.name));
  let minSoc: { soc: number; time: string } | null = null;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const nextMin = i + 1 < samples.length ? samples[i + 1]!.minuteOfDay : Math.min(1440, s.minuteOfDay + 5);
    const dtMin = Math.max(0, Math.min(maxGapMin, nextMin - s.minuteOfDay));
    const h = dtMin / 60;
    const name = periodOf(s.minuteOfDay);
    const a = acc.get(name) ?? acc.set(name, blank()).get(name)!;
    a.import_kwh += (Math.max(0, s.grid_w) * h) / 1000;
    a.export_kwh += (Math.max(0, -s.grid_w) * h) / 1000;
    a.load_kwh += (s.load_w * h) / 1000;
    a.battery_discharge_kwh += (Math.max(0, s.battery_w) * h) / 1000;
    a.battery_charge_kwh += (Math.max(0, -s.battery_w) * h) / 1000;
    const idle = s.battery_w < idleThresholdW && s.grid_w > idleThresholdW;
    if (idle) a.idle_import_min += dtMin;
    if (idle && costly.has(name) && !firstIdle) firstIdle = { time: s.time.slice(11, 16), period: name, soc_pct: s.soc_pct, grid_w: s.grid_w };
    if (s.soc_pct !== null && (minSoc === null || s.soc_pct < minSoc.soc)) minSoc = { soc: s.soc_pct, time: s.time.slice(11, 16) };
  }

  const socAt = (hhmm: string) => {
    const t = toMin(hhmm);
    let best: Sample | undefined;
    for (const s of samples) if (s.minuteOfDay <= t) best = s;
    return best?.soc_pct ?? null;
  };
  const round = (n: number) => Math.round(n * 100) / 100;
  const byPeriod: Json = {};
  let cost = 0;
  let hasRates = false;
  for (const p of parsed) {
    const a = acc.get(p.name)!;
    byPeriod[p.name] = {
      grid_import_kwh: round(a.import_kwh),
      grid_export_kwh: round(a.export_kwh),
      load_kwh: round(a.load_kwh),
      battery_discharge_kwh: round(a.battery_discharge_kwh),
      battery_charge_kwh: round(a.battery_charge_kwh),
      battery_share_of_load_pct: a.load_kwh > 0 ? Math.round((a.battery_discharge_kwh / a.load_kwh) * 100) : null,
      minutes_importing_with_battery_idle: Math.round(a.idle_import_min),
    };
    if (p.rate !== undefined) {
      hasRates = true;
      cost += a.import_kwh * p.rate;
      (byPeriod[p.name] as Json).import_cost = round(a.import_kwh * p.rate);
    }
  }
  const firstCostly = parsed.filter((p) => costly.has(p.name)).flatMap((p) => p.ranges.map((r) => r[0])).sort((x, y) => x - y)[0];
  return {
    samples: samples.length,
    by_period: byPeriod,
    ...(hasRates ? { estimated_import_cost: round(cost) } : {}),
    soc: {
      at_start_of_first_costly_period: firstCostly !== undefined ? socAt(`${Math.floor(firstCostly / 60)}:${String(firstCostly % 60).padStart(2, "0")}`) : null,
      minimum: minSoc ? { soc_pct: minSoc.soc, time: minSoc.time } : null,
      end_of_day: samples.length ? samples[samples.length - 1]!.soc_pct : null,
    },
    battery_first_went_idle_while_importing_in_costly_period: firstIdle,
  };
}
