import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { randomToken, safeEqual } from "./crypto";
import type { Env, GrantProps } from "./env";
import { Eg4Client, Eg4Error, login } from "./eg4/client";

export const SCOPE_READ = "eg4:read";
export const SCOPE_WRITE = "eg4:write";

const CSRF_COOKIE = "__Host-eg4mcp_csrf";
const RATE_LIMIT = { attempts: 10, windowS: 15 * 60 };

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** parseAuthRequest reads the OAuth parameters from the query string; re-run it as a GET for the POST. */
async function parseAuth(env: Env, request: Request): Promise<AuthRequest | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(new Request(request.url, { method: "GET" }));
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) {
      // Unknown client or unregistered redirect URI: never redirect, render locally.
      return page({ title: "Can't connect", body: `<p class="error">${esc(error.description)}</p>` }, 400);
    }
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect.toString(), 302);
  }
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const parsed = await parseAuth(env, request);
  if (parsed instanceof Response) return parsed;
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) return page({ title: "Can't connect", body: `<p class="error">Unknown application.</p>` }, 400);
  // Clients name themselves at registration, so show where the grant will be sent too.
  let redirectHost = "";
  try {
    redirectHost = new URL(parsed.redirectUri).host;
  } catch {
    /* leave blank */
  }
  const clientName = `${client.clientName || "An application"}${redirectHost ? ` (${redirectHost})` : ""}`;

  if (request.method === "GET") return renderForm(request, clientName, {});
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // --- POST: sign in -------------------------------------------------------
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (await rateLimited(env, ip)) {
    return renderForm(request, clientName, { error: "Too many sign-in attempts. Wait a few minutes and try again." }, 429);
  }

  const form = await request.formData();
  const csrfField = String(form.get("csrf") ?? "");
  const csrfCookie = readCookie(request, CSRF_COOKIE) ?? "";
  if (!csrfField || !csrfCookie || !safeEqual(csrfField, csrfCookie)) {
    return renderForm(request, clientName, { error: "Your session expired. Please try again." }, 400);
  }

  const account = String(form.get("account") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const canWrite = form.get("allow_changes") === "on";
  const values = { account, allowChanges: canWrite };

  if (!account || !password) return renderForm(request, clientName, { ...values, error: "Enter your EG4 monitor account and password." }, 400);

  let cookie: string;
  try {
    ({ cookie } = await login(env.EG4_BASE_URL.replace(/\/+$/, ""), account, password));
  } catch (err) {
    const msg = err instanceof Eg4Error ? err.message : "Sign-in failed. Try again.";
    return renderForm(request, clientName, { ...values, error: msg }, err instanceof Eg4Error && err.kind === "auth" ? 401 : 502);
  }

  const props: GrantProps = { account, password, canWrite };
  const eg4 = new Eg4Client(env, props);
  await eg4.storeSession(cookie);

  const scope = canWrite ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: parsed,
    // Must not contain ":"; a hash keeps the account name out of storage-visible metadata.
    userId: `eg4.${(await eg4.hash()).slice(0, 40)}`,
    metadata: { label: "EG4 monitor", canWrite },
    scope,
    props,
    // Several family members may connect the same EG4 account from different Claude accounts.
    revokeExistingGrants: false,
  });

  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo, "Set-Cookie": `${CSRF_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}

async function rateLimited(env: Env, ip: string): Promise<boolean> {
  const key = `eg4mcp:rl:${ip}`;
  const count = Number((await env.OAUTH_KV.get(key)) ?? "0") + 1;
  await env.OAUTH_KV.put(key, String(count), { expirationTtl: RATE_LIMIT.windowS });
  return count > RATE_LIMIT.attempts;
}

interface FormState {
  account?: string;
  allowChanges?: boolean;
  error?: string;
}

function renderForm(request: Request, clientName: string, state: FormState, status = 200): Response {
  const csrf = randomToken();
  const url = new URL(request.url);
  const action = esc(url.pathname + url.search);
  const body = `
    <p class="lede"><strong>${esc(clientName)}</strong> wants to use your EG4 inverter and battery monitor on your behalf.</p>
    ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ""}
    <form method="post" action="${action}">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <label>EG4 monitor account<input name="account" autocomplete="username" required value="${esc(state.account ?? "")}"></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <label class="inline"><input type="checkbox" name="allow_changes" ${state.allowChanges ? "checked" : ""}> Allow changes to inverter settings (cut-offs, charge schedule, working modes). Every change is previewed first and read back afterwards. Leave unchecked for read-only access.</label>
      <button type="submit">Connect</button>
    </form>
    <p class="fine">This is the login you use at monitor.eg4electronics.com. It's encrypted and used only to call EG4.</p>`;
  const res = page({ title: "Connect EG4", body }, status);
  res.headers.append("Set-Cookie", `${CSRF_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`);
  return res;
}

function page({ title, body }: { title: string; body: string }, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f6;--fg:#1f1e1c;--muted:#6b6a65;--line:#d6d4cc;--accent:#2f6b3a;--err:#a32d2d;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a18;--fg:#eceae4;--muted:#a3a19a;--line:#3a3935;--accent:#3f8a4c;--err:#f09595;--card:#242320}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;display:flex;justify-content:center;padding:48px 16px}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;font-weight:600;margin:0 0 12px}.lede{margin:0 0 20px}
label{display:block;font-size:14px;font-weight:500;margin:0 0 14px}
input[type=text],input:not([type]),input[type=password]{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
fieldset{border:0;padding:0;margin:0 0 14px}legend{font-size:14px;font-weight:500;margin-bottom:6px}
label.inline{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin-bottom:8px}label.inline input{margin-top:4px}
button{width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer;margin-top:6px}
.error{color:var(--err);margin:0 0 16px}.fine{color:var(--muted);font-size:13px;margin:18px 0 0}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
}
