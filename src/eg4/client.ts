import type { Env, GrantProps } from "../env";
import { open, seal, sha256Hex } from "../crypto";

export type Eg4ErrorKind = "auth" | "api" | "network" | "input" | "verify";

export class Eg4Error extends Error {
  constructor(
    message: string,
    readonly kind: Eg4ErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "Eg4Error";
  }
}

type FetchLike = typeof fetch;

/** Workers' global fetch throws "Illegal invocation" when called as a method of another object. */
const globalFetch: FetchLike = (input, init) => fetch(input, init);

/** EG4 web sessions idle out; re-use a cookie for at most this long. */
const SESSION_TTL_S = 25 * 60;
/** After a rejected login, don't retry the same credentials for this long. */
const FAILED_LOGIN_BACKOFF_S = 5 * 60;
/** A forced re-login (session rejected mid-use) is allowed at most this often per account. */
const FORCED_REFRESH_WINDOW_S = 60;
/** EG4 serial numbers are 10 alphanumerics. */
export const SERIAL_RE = /^[A-Za-z0-9]{6,20}$/;

export type Form = Record<string, string | number | boolean | undefined>;
export type Json = Record<string, unknown>;

function encodeForm(form: Form): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
}

function extractSessionCookie(res: Response): string | null {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const all = headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[A-Za-z0-9_]+=)/);
  for (const c of all) {
    const m = c.match(/(?:^|\s)JSESSIONID=([^;]+)/);
    if (m) return `JSESSIONID=${m[1]}`;
  }
  return null;
}

const LOGIN_MESSAGES: Record<string, string> = {
  LOGIN_ERROR_DISMATCH: "EG4 rejected the account name or password.",
  LOGIN_ERROR_ACCOUNT_LOCKED: "EG4 has locked this account after too many attempts. Wait and try again, or reset the password at monitor.eg4electronics.com.",
};

/** POST /WManage/api/login. Returns the session cookie and the raw login payload. */
export async function login(
  base: string,
  account: string,
  password: string,
  fetchImpl: FetchLike = globalFetch,
): Promise<{ cookie: string; body: Json }> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/WManage/api/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json" },
      body: encodeForm({ account, password }),
    });
  } catch (err) {
    throw new Eg4Error(`Couldn't reach EG4: ${(err as Error).message}`, "network");
  }
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    throw new Eg4Error(`EG4 sign-in returned an unexpected response (HTTP ${res.status}).`, "api", res.status);
  }
  if (body.success !== true) {
    const code = String(body.msg ?? "");
    throw new Eg4Error(LOGIN_MESSAGES[code] ?? `EG4 sign-in failed${code ? ` (${code})` : ""}.`, "auth", res.status);
  }
  const cookie = extractSessionCookie(res);
  if (!cookie) throw new Eg4Error("EG4 signed in but returned no session cookie.", "api", res.status);
  return { cookie, body };
}

function isUnauthenticated(res: Response, body: unknown): boolean {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400) return true; // web routes redirect to the login page
  if (body && typeof body === "object" && (body as Json).msg === "UNLOGIN_ERROR") return true;
  if (typeof body === "string" && /<form[^>]+login|id="loginForm"/i.test(body)) return true;
  return false;
}

export class Eg4Client {
  readonly base: string;
  private accountHash?: Promise<string>;

  constructor(
    private readonly env: Env,
    private readonly props: GrantProps,
    private readonly fetchImpl: FetchLike = globalFetch,
  ) {
    this.base = env.EG4_BASE_URL.replace(/\/+$/, "");
  }

  /** Stable, non-reversible key for this EG4 account. */
  hash(): Promise<string> {
    this.accountHash ??= sha256Hex(`eg4|${this.props.account.toLowerCase()}`);
    return this.accountHash;
  }

  private async credentialHash(): Promise<string> {
    return sha256Hex(`eg4|${this.props.account.toLowerCase()}|${this.props.password}`);
  }

  private async cacheKey(): Promise<string> {
    return `eg4mcp:session:${await this.hash()}`;
  }

  /** Returns a cached session cookie, signing in only when there isn't one. */
  async session(force = false): Promise<string> {
    const kv = this.env.OAUTH_KV;
    const key = await this.cacheKey();
    const h = await this.hash();

    if (!force) {
      const sealed = await kv.get(key);
      if (sealed) {
        const cookie = await open(this.env.EG4_CACHE_KEY, sealed, key);
        if (cookie) return cookie;
      }
    } else {
      const forcedKey = `eg4mcp:forced:${h}`;
      if (await kv.get(forcedKey)) {
        throw new Eg4Error(
          "EG4 keeps rejecting this connection's session. Wait a minute and retry; if it persists, reconnect the EG4 connector.",
          "auth",
          401,
        );
      }
      await kv.put(forcedKey, "1", { expirationTtl: FORCED_REFRESH_WINDOW_S });
    }

    const failKey = `eg4mcp:fail:${await this.credentialHash()}`;
    const failed = await kv.get(failKey);
    if (failed) {
      throw new Eg4Error(`EG4 rejected the stored credentials (${failed}). Reconnect the EG4 connector with the current password.`, "auth", 401);
    }

    let cookie: string;
    try {
      ({ cookie } = await login(this.base, this.props.account, this.props.password, this.fetchImpl));
    } catch (err) {
      if (err instanceof Eg4Error && err.kind === "auth") {
        await kv.put(failKey, err.message.slice(0, 200), { expirationTtl: FAILED_LOGIN_BACKOFF_S });
      }
      throw err;
    }
    await this.storeSession(cookie);
    return cookie;
  }

  /** Caches a fresh session cookie (the authorize form calls this right after it signs in). */
  async storeSession(cookie: string): Promise<void> {
    const key = await this.cacheKey();
    await this.env.OAUTH_KV.put(key, await seal(this.env.EG4_CACHE_KEY, cookie, key), { expirationTtl: SESSION_TTL_S });
    await this.env.OAUTH_KV.delete(`eg4mcp:fail:${await this.credentialHash()}`);
  }

  /**
   * POSTs a form to a /WManage path and returns the parsed JSON.
   * Re-signs in once if EG4 says the session has expired.
   */
  async post(path: string, form: Form = {}): Promise<Json> {
    if (!path.startsWith("/WManage/")) throw new Eg4Error(`Path must start with /WManage/ (got ${path})`, "input");
    const url = this.base + path;

    const send = async (cookie: string) => {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: encodeForm(form),
        });
      } catch (err) {
        throw new Eg4Error(`Couldn't reach EG4: ${(err as Error).message}`, "network");
      }
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* leave as text */
      }
      return { res, body };
    };

    let { res, body } = await send(await this.session());
    if (isUnauthenticated(res, body)) {
      await this.env.OAUTH_KV.delete(await this.cacheKey());
      ({ res, body } = await send(await this.session(true)));
      if (isUnauthenticated(res, body)) throw new Eg4Error("EG4 rejected the session right after signing in.", "auth", res.status);
    }

    if (!res.ok) {
      const msg = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
      throw new Eg4Error(`EG4 returned HTTP ${res.status}: ${msg}`, "api", res.status);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Eg4Error(`EG4 returned a non-JSON response for ${path}.`, "api", res.status);
    }
    return body as Json;
  }

  /** Like post(), but throws when EG4 reports success:false. */
  async call(path: string, form: Form = {}): Promise<Json> {
    const body = await this.post(path, form);
    if (body.success === false) {
      const msg = String(body.msg ?? body.message ?? "") || "no message";
      throw new Eg4Error(`EG4 reported a failure for ${path.replace("/WManage", "")}: ${msg}`, "api");
    }
    return body;
  }
}
