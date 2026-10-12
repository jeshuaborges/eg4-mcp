import type { Env, GrantProps } from "../src/env";

export function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

export function makeEnv(kv = fakeKv()): Env & { OAUTH_KV: ReturnType<typeof fakeKv> } {
  return {
    OAUTH_KV: kv as unknown as KVNamespace & ReturnType<typeof fakeKv>,
    OAUTH_PROVIDER: undefined as never,
    PUBLIC_BASE_URL: "https://eg4.example.test",
    EG4_BASE_URL: "https://eg4.portal.test",
    EG4_CACHE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  } as Env & { OAUTH_KV: ReturnType<typeof fakeKv> };
}

export const props = (over: Partial<GrantProps> = {}): GrantProps => ({ account: "family", password: "secret", canWrite: false, ...over });

export const SN = "45000E0207";

/** Settings as EG4's remoteRead returns them (subset), split across the three register blocks. */
export function baseSettings(): Record<string, unknown> {
  return {
    HOLD_TIME: "2026-10-11 19:33:07",
    HOLD_MODEL_batteryType: 2,
    HOLD_MODEL_lithiumType: 0,
    FUNC_SET_TO_STANDBY: true,
    FUNC_BAT_CHARGE_CONTROL: false,
    FUNC_BAT_DISCHARGE_CONTROL: false,
    FUNC_AC_CHARGE: true,
    FUNC_GRID_PEAK_SHAVING: true,
    FUNC_BATTERY_BACKUP_CTRL: false,
    FUNC_FORCED_DISCHG_EN: false,
    FUNC_PV_SELL_TO_GRID_EN: false,
    FUNC_EPS_EN: true,
    BIT_AC_CHARGE_TYPE: 0,
    HOLD_DISCHG_CUT_OFF_SOC_EOD: "15",
    HOLD_SOC_LOW_LIMIT_EPS_DISCHG: "10",
    HOLD_ON_GRID_EOD_VOLTAGE: "52.1",
    HOLD_LEAD_ACID_DISCHARGE_CUT_OFF_VOLT: "50",
    HOLD_LEAD_ACID_CHARGE_RATE: "80",
    HOLD_AC_CHARGE_POWER_CMD: "5",
    HOLD_AC_CHARGE_SOC_LIMIT: "100",
    HOLD_AC_CHARGE_START_HOUR: "00",
    HOLD_AC_CHARGE_START_MINUTE: "01",
    HOLD_AC_CHARGE_END_HOUR: "15",
    HOLD_AC_CHARGE_END_MINUTE: "00",
    _12K_HOLD_GRID_PEAK_SHAVING_POWER: "0",
    _12K_HOLD_GRID_PEAK_SHAVING_SOC: "50",
    LSP_HOLD_DIS_CHG_POWER_TIME_37: "15",
    LSP_HOLD_DIS_CHG_POWER_TIME_38: "00",
    LSP_HOLD_DIS_CHG_POWER_TIME_39: "23",
    LSP_HOLD_DIS_CHG_POWER_TIME_40: "59",
  };
}

export interface Call {
  path: string;
  form: URLSearchParams;
  cookie: string | null;
}

export interface FakeOptions {
  password?: string;
  /** Paths whose next N authenticated calls answer UNLOGIN_ERROR. */
  expireSessions?: number;
  /** holdParam/functionParam names EG4 should refuse. */
  reject?: string[];
  /** holdParam names EG4 accepts but silently ignores. */
  ignore?: string[];
  dayData?: unknown[];
}

const FUNC_TO_FLAT: Record<string, string> = {};
const TIME_TO_FLAT: Record<string, [string, string]> = {
  HOLD_AC_CHARGE_END_TIME: ["HOLD_AC_CHARGE_END_HOUR", "HOLD_AC_CHARGE_END_MINUTE"],
  HOLD_AC_CHARGE_START_TIME: ["HOLD_AC_CHARGE_START_HOUR", "HOLD_AC_CHARGE_START_MINUTE"],
  HOLD_PEAK_SHAVING_START_TIME_1: ["LSP_HOLD_DIS_CHG_POWER_TIME_37", "LSP_HOLD_DIS_CHG_POWER_TIME_38"],
  HOLD_PEAK_SHAVING_END_TIME_1: ["LSP_HOLD_DIS_CHG_POWER_TIME_39", "LSP_HOLD_DIS_CHG_POWER_TIME_40"],
};
const MODEL_TO_FLAT: Record<string, string> = { MODEL_BIT_BATTERY_TYPE: "HOLD_MODEL_batteryType", MODEL_BIT_LITHIUM_TYPE: "HOLD_MODEL_lithiumType" };

/** A fake EG4 portal with mutable settings state. */
export function fakeEg4(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  const settings = baseSettings();
  let logins = 0;
  let wrote = false;
  let expire = opts.expireSessions ?? 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  let state: { failReadsAfterWrite: boolean };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/WManage/, "");
    const form = new URLSearchParams(String(init?.body ?? ""));
    const cookie = new Headers(init?.headers).get("Cookie");
    calls.push({ path, form, cookie });

    if (path === "/api/login") {
      if (form.get("password") !== (opts.password ?? "secret")) return json({ success: false, msg: "LOGIN_ERROR_DISMATCH", msgCode: 101 });
      logins++;
      return json({ success: true, plants: [] }, 200, { "Set-Cookie": `JSESSIONID=S${logins}-n1; Path=/WManage; HttpOnly` });
    }
    if (path.startsWith("/web/maintain/remoteSet/")) wrote = true;
    if (!cookie?.startsWith("JSESSIONID=")) return json({ success: false, msg: "UNLOGIN_ERROR", msgCode: 102 }, 401);
    if (expire > 0) {
      expire--;
      return json({ success: false, msg: "UNLOGIN_ERROR", msgCode: 102 }, 401);
    }

    switch (path) {
      case "/web/config/inverter/list":
        return json({
          total: 2,
          rows: [
            { serialNum: "4434850690", deviceType: 9, deviceTypeText: "Grid Boss", batteryType: "NO_BATTERY", statusText: "Standby", lost: false },
            { serialNum: SN, deviceType: 6, deviceTypeText: "FlexBOSS21", batteryType: "LITHIUM", batParallelNum: 2, batCapacity: "560", statusText: "Battery Grid on", fwCode: "FAAB-2525", plantId: 19134, plantName: "Hilltop", lost: false },
          ],
        });
      case "/web/maintain/remoteRead/read": {
        if (state.failReadsAfterWrite && wrote) return json({ success: false, msg: "DEVICE_TIMEOUT" });
        const start = Number(form.get("startRegister"));
        // Spread keys across blocks to prove the reader merges them.
        const keys = Object.keys(settings);
        const third = Math.ceil(keys.length / 3);
        const slice = start === 0 ? keys.slice(0, third) : start === 127 ? keys.slice(third, third * 2) : keys.slice(third * 2);
        return json({ success: true, valueFrame: "AAAA", startRegister: start, ...Object.fromEntries(slice.map((k) => [k, settings[k]])) });
      }
      case "/web/maintain/remoteSet/write": {
        const p = form.get("holdParam")!;
        if (opts.reject?.includes(p)) return json({ success: false, msg: "PARAM_OUT_OF_RANGE" });
        if (!opts.ignore?.includes(p)) settings[p] = form.get("valueText");
        return json({ success: true });
      }
      case "/web/maintain/remoteSet/functionControl": {
        const p = form.get("functionParam")!;
        if (opts.reject?.includes(p)) return json({ success: false, msg: "DEVICE_OFFLINE" });
        settings[FUNC_TO_FLAT[p] ?? p] = form.get("enable") === "true";
        return json({ success: true });
      }
      case "/web/maintain/remoteSet/bitParamControl":
        settings[form.get("bitParam")!] = Number(form.get("value"));
        return json({ success: true });
      case "/web/maintain/remoteSet/bitModelParamControl":
        settings[MODEL_TO_FLAT[form.get("modelBitParam")!]!] = Number(form.get("value"));
        return json({ success: true });
      case "/web/maintain/remoteSet/writeTime": {
        const [h, m] = TIME_TO_FLAT[form.get("timeParam")!]!;
        settings[h] = form.get("hour")!.padStart(2, "0");
        settings[m] = form.get("minute")!.padStart(2, "0");
        return json({ success: true });
      }
      case "/api/inverter/getInverterRuntime":
        return json({
          success: true, serialNum: SN, statusText: "normal", status: 16, lost: false, soc: 90, vBat: 529, batPower: -855, pCharge: 0, pDisCharge: 855,
          pToUser: 0, pToGrid: 0, vacr: 2406, fac: 6003, consumptionPower: 824, batteryType: "LITHIUM", batParallelNum: "2", batCapacity: "560",
          bmsCharge: true, bmsDischarge: true, bmsForceCharge: false, maxChgCurrValue: 400, maxDischgCurrValue: 400, bmsBatCurrent: -1670, faultCode: 0, warningCode: 0,
        });
      case "/api/battery/getBatteryInfo":
        return json({ success: true, bmsCycleCnt: 75, currentBatteryCharge: 504, maxBatteryCharge: 560, hasCellExtremes: true, globalMaxCellVoltage: 3311, globalMinCellVoltage: 3306, globalMaxCellTemp: 190, globalMinCellTemp: 190, batteryArray: [] });
      case "/api/inverter/getInverterEnergyInfo":
        return json({ success: true, serialNum: SN, soc: 90, todayUsage: 150, todayImport: 207, todayExport: 0, todayCharging: 84, todayDischarging: 28, todayYielding: 0, totalUsage: 109255, totalImport: 113109, totalExport: 12, totalCharging: 17821, totalDischarging: 14474, totalYielding: 0 });
      case "/api/analyze/chart/dayMultiLine":
        return json({ success: true, xAxis: "time", data: opts.dayData ?? [] });
      case "/api/inverterChart/monthColumn":
        return json({ success: true, dayMax: 31, data: [{ day: 1, eChgDay: 112, eDisChgDay: 86, eToUserDay: 544, eToGridDay: 0, eConsumptionDay: 514, ePv1Day: 0, ePv2Day: 0, ePv3Day: 0 }] });
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;

  const out = { fetchImpl, calls, settings, logins: () => logins, failReadsAfterWrite: false };
  state = out;
  return out;
}

/** One sample in EG4's dayMultiLine shape. gridPower negative = import; batteryDischarging negative = charging. */
export function point(hhmm: string, { grid = 0, battery = 0, load = 0, soc = 80 } = {}) {
  return { time: `2026-10-08 ${hhmm}:00`, solarPv: 0, gridPower: -grid, batteryDischarging: battery, consumption: load, soc, acCouplePower: 0 };
}
