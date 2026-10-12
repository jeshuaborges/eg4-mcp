import { describe, expect, it } from "vitest";
import { Eg4Client, Eg4Error } from "../src/eg4/client";
import { fakeEg4, makeEnv, props } from "./helpers";

describe("Eg4Client sessions", () => {
  it("signs in once and reuses the encrypted session cookie", async () => {
    const env = makeEnv();
    const eg4 = fakeEg4();
    const c = new Eg4Client(env, props(), eg4.fetchImpl);
    await c.call("/WManage/api/inverter/getInverterRuntime", { serialNum: "x" });
    await c.call("/WManage/api/inverter/getInverterRuntime", { serialNum: "x" });
    expect(eg4.logins()).toBe(1);
    expect(eg4.calls.filter((x) => x.path !== "/api/login").every((x) => x.cookie === "JSESSIONID=S1-n1")).toBe(true);
    const stored = [...env.OAUTH_KV.store.entries()].find(([k]) => k.startsWith("eg4mcp:session:"));
    expect(stored?.[1]).not.toContain("JSESSIONID"); // sealed, not plaintext
  });

  it("sends the login as a form with account and password", async () => {
    const eg4 = fakeEg4();
    await new Eg4Client(makeEnv(), props(), eg4.fetchImpl).session();
    const login = eg4.calls.find((c) => c.path === "/api/login")!;
    expect(login.form.get("account")).toBe("family");
    expect(login.form.get("password")).toBe("secret");
  });

  it("re-signs in once when EG4 says the session expired", async () => {
    const eg4 = fakeEg4({ expireSessions: 1 });
    const c = new Eg4Client(makeEnv(), props(), eg4.fetchImpl);
    const body = await c.call("/WManage/api/inverter/getInverterRuntime", { serialNum: "x" });
    expect(body.soc).toBe(90);
    expect(eg4.logins()).toBe(2);
  });

  it("gives up if the fresh session is rejected too", async () => {
    const eg4 = fakeEg4({ expireSessions: 5 });
    const c = new Eg4Client(makeEnv(), props(), eg4.fetchImpl);
    await expect(c.call("/WManage/api/inverter/getInverterRuntime", {})).rejects.toMatchObject({ kind: "auth" });
  });

  it("maps a bad password to a clear auth error and backs off", async () => {
    const env = makeEnv();
    const eg4 = fakeEg4({ password: "other" });
    const c = new Eg4Client(env, props(), eg4.fetchImpl);
    await expect(c.session()).rejects.toThrow(/rejected the account name or password/);
    await expect(c.session()).rejects.toThrow(/Reconnect the EG4 connector/);
    expect(eg4.calls.filter((x) => x.path === "/api/login")).toHaveLength(1);
  });

  it("refuses paths outside /WManage", async () => {
    const c = new Eg4Client(makeEnv(), props(), fakeEg4().fetchImpl);
    await expect(c.post("/other")).rejects.toBeInstanceOf(Eg4Error);
  });

  it("call() surfaces success:false with EG4's message", async () => {
    const eg4 = fakeEg4({ reject: ["HOLD_X"] });
    const c = new Eg4Client(makeEnv(), props(), eg4.fetchImpl);
    await expect(c.call("/WManage/web/maintain/remoteSet/write", { holdParam: "HOLD_X", valueText: "1" })).rejects.toThrow(/PARAM_OUT_OF_RANGE/);
  });
});
