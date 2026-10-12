import type { Env } from "../env";
import { Eg4Client, Eg4Error, SERIAL_RE, type Json } from "./client";

const CACHE_TTL_S = 30 * 60;

export interface Device {
  serialNum: string;
  type: string;
  deviceType: number;
  plantId: number | null;
  plantName: string | null;
  status: string;
  batteryType: string;
  batteryModules: number | null;
  batteryCapacityAh: number | null;
  firmware: string;
  powerRating: string;
  online: boolean;
  lastUpdate: string | null;
}

function toDevice(r: Json): Device {
  return {
    serialNum: String(r.serialNum),
    type: String(r.deviceTypeText ?? r.deviceType ?? ""),
    deviceType: Number(r.deviceType),
    plantId: r.plantId === undefined ? null : Number(r.plantId),
    plantName: (r.plantName as string) ?? null,
    status: String(r.statusText ?? ""),
    batteryType: String(r.batteryType ?? ""),
    batteryModules: r.batParallelNum === "" || r.batParallelNum === undefined ? null : Number(r.batParallelNum),
    batteryCapacityAh: r.batCapacity === "" || r.batCapacity === undefined ? null : Number(r.batCapacity),
    firmware: String(r.fwCode ?? ""),
    powerRating: String(r.powerRatingText ?? ""),
    online: r.lost === false,
    lastUpdate: (r.lastUpdateTime as string) ?? null,
  };
}

/** Lists every device on the account (inverters and GridBOSS), cached for 30 minutes. */
export async function listDevices(env: Env, eg4: Eg4Client, refresh = false): Promise<Device[]> {
  const key = `eg4mcp:devices:${await eg4.hash()}`;
  if (!refresh) {
    const cached = await env.OAUTH_KV.get(key);
    if (cached) return JSON.parse(cached) as Device[];
  }
  const devices: Device[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await eg4.post("/WManage/web/config/inverter/list", { page, rows: 50 });
    const rows = Array.isArray(body.rows) ? (body.rows as Json[]) : [];
    devices.push(...rows.map(toDevice));
    if (rows.length < 50 || devices.length >= Number(body.total ?? 0)) break;
  }
  await env.OAUTH_KV.put(key, JSON.stringify(devices), { expirationTtl: CACHE_TTL_S });
  return devices;
}

/**
 * Confirms the serial belongs to this account. With no serial, picks the only
 * battery inverter on the account, so single-inverter homes never need to pass one.
 */
export async function resolveSerial(env: Env, eg4: Eg4Client, serialNum?: string): Promise<Device> {
  let devices = await listDevices(env, eg4);
  if (serialNum) {
    if (!SERIAL_RE.test(serialNum)) throw new Eg4Error(`"${serialNum}" doesn't look like an EG4 serial number.`, "input");
    let d = devices.find((x) => x.serialNum.toLowerCase() === serialNum.toLowerCase());
    if (!d) {
      devices = await listDevices(env, eg4, true);
      d = devices.find((x) => x.serialNum.toLowerCase() === serialNum.toLowerCase());
    }
    if (!d) throw new Eg4Error(`Serial ${serialNum} isn't on this EG4 account. Devices: ${devices.map((x) => `${x.serialNum} (${x.type})`).join(", ") || "none"}.`, "input");
    return d;
  }
  const inverters = devices.filter((d) => d.deviceType !== 9 && d.batteryType !== "NO_BATTERY" && d.batteryType !== "");
  if (inverters.length === 1) return inverters[0]!;
  throw new Eg4Error(
    inverters.length === 0
      ? "No battery inverter found on this EG4 account."
      : `This account has several inverters; pass serialNum (${inverters.map((d) => d.serialNum).join(", ")}).`,
    "input",
  );
}
