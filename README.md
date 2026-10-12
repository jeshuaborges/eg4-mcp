# EG4 MCP server

A remote MCP server for EG4 inverters and batteries, running on Cloudflare Workers. It lets Claude (claude.ai, the desktop app, Claude Code) read live status, energy history and settings from the EG4 monitoring portal ([monitor.eg4electronics.com](https://monitor.eg4electronics.com)), analyze time-of-use battery coverage, and change inverter settings safely. You connect once with your EG4 monitor login, and your credentials never pass through Claude.

Built for a FlexBOSS21 with EG4 PowerPro WallMount batteries on PG&E EV2-A. It should work with other "12K-family" hybrids that use the same settings page (18kPV, 12kPV, FlexBOSS18).

## How it works

```
Claude ──OAuth──▶ /authorize (EG4 login form) ──▶ grant stored in KV, credentials encrypted
Claude ──Bearer─▶ /mcp ──▶ tools ──▶ cached EG4 session cookie ──▶ monitor.eg4electronics.com
```

- **OAuth 2.1** via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). It serves discovery, client registration (CIMD and DCR), tokens and refresh. `/authorize` is our sign-in form.
- **EG4 has no public API or API keys.** The portal uses a form login that returns a `JSESSIONID` cookie, and the server uses the same endpoints the portal's own JavaScript calls.
  - The grant holds the EG4 account, password and a `canWrite` flag, encrypted by the OAuth provider.
  - The session cookie is cached in KV, AES-GCM-encrypted with `EG4_CACHE_KEY`, for 25 minutes.
  - When EG4 answers `UNLOGIN_ERROR`, the server signs in again, at most once a minute.
  - A rejected password backs off for 5 minutes, so the account isn't locked out.
- **Read-only by default.** Write tools exist only when the user ticks "Allow changes" on the sign-in form.
- **Stateless MCP over Streamable HTTP.** A fresh server handles each request, so no Durable Objects are needed.

## Tools

| Tool | What it does |
|---|---|
| `eg4_list_inverters` | Devices on the account: serial, model, plant, battery type/capacity, firmware, online |
| `eg4_get_status` | Live state: SOC, battery V/W, BMS limits and flags, cell voltage spread and temperatures, cycle count, grid import/export, load, PV, fault/warning codes |
| `eg4_get_energy` | Today's and lifetime kWh |
| `eg4_get_day` | One day's power chart, bucketed (default 15 min) |
| `eg4_get_history` | kWh per day for a month, or per month for a year |
| `eg4_analyze_tou` | Per rate period over up to 14 days: grid import, load, battery charge/discharge, battery share of load, SOC at the start of the costly period, minimum SOC, and **when the battery first went idle while the house was importing**. Defaults to PG&E EV2-A; pass your own periods and $/kWh rates for other plans |
| `eg4_get_settings` | Live settings grouped with friendly names (battery, cutoffs, AC charge, peak-shaving, forced discharge, backup, grid, PV); `raw=true` gives EG4's full register map |
| `eg4_describe_settings` | Offline catalog of changeable settings: key, unit, range, allowed values, notes |
| `eg4_change_settings` *(opt-in)* | Preview, then apply, then read back and verify. See below |
| `eg4_change_history` *(opt-in)* | Last 50 changes with from → to and verification, for undo |

`serialNum` is optional when the account has one battery inverter.

### Changing settings

`eg4_change_settings` takes `{setting_key: value}` using keys from `eg4_describe_settings`, for example `{"on_grid_cutoff_soc_pct": 15, "discharge_control": "soc", "ac_charge_window_1_end": "15:00"}`.

1. **Preview** (default, `apply` omitted) reads the inverter and returns current vs new values, blocking errors and warnings.
   - Errors block the change: off-grid cutoff above on-grid, AC charge together with battery backup mode, or forced discharge together with export PV only.
   - Warnings flag a SOC cutoff while the control mode is volt, high-impact settings, and switching to closed-loop lithium without a BMS cable.
2. **Apply** (`apply: true`) writes in a safe order:
   - battery type and brand first, then the control mode, then the cutoff pair ordered so off ≤ on at every step, then switches turned off before others turn on.
   - It stops at the first refusal, reads the inverter back, and returns `verification` per setting plus an `undo` map of previous values.

Only settings in `src/eg4/settings.ts` can be changed. Grid-compliance (voltage/frequency trip), CT/meter, firmware and reset parameters are deliberately excluded.

**EG4 quirks this encodes:**
- `FUNC_BAT_DISCHARGE_CONTROL`/`FUNC_BAT_CHARGE_CONTROL`: `true` means **Volt** and `false` means **SOC**. On the FlexBOSS21 the two move together.
- `FUNC_SET_TO_STANDBY=true` means **Normal**, and `FUNC_RSD_DISABLE=true` means RSD is off.
- Peak-shaving windows are stored in `LSP_HOLD_DIS_CHG_POWER_TIME_37…44`.
- Battery type and lithium brand are "model bits", written through `bitModelParamControl`.
- Energy figures arrive in 0.1 kWh, voltages ×10, frequency ×100 and cell voltages in mV. In the day chart, `gridPower` is negative for import.

## Deploy

```bash
npm ci
npx wrangler kv namespace create OAUTH_KV        # put the id in wrangler.jsonc
# set PUBLIC_BASE_URL in wrangler.jsonc to the Worker's final URL
openssl rand -base64 32 | npx wrangler secret put EG4_CACHE_KEY
npx wrangler deploy
```

Then add `https://<PUBLIC_BASE_URL>/mcp` as a custom connector in claude.ai (Settings → Connectors).

Changing `PUBLIC_BASE_URL` or rotating `EG4_CACHE_KEY` invalidates existing connections and cached sessions, so users have to reconnect.

## Develop

```bash
cp .dev.vars.example .dev.vars   # fill in EG4_CACHE_KEY
npm run dev                       # http://localhost:8787
npm run typecheck && npm test
```

Tests run against a fake EG4 portal with mutable settings state. They cover:
- session caching, expiry and backoff
- the exact request forms the portal sends
- settings decoding, validation, cross-setting rules and write order
- time-of-use analysis
- the full preview → apply → read-back flow, including refused and silently ignored writes

`research/params_catalog.json` is the parameter catalog scraped from the portal's settings page (names, labels, ranges, tooltips). Use it when adding settings.

## Credits

The endpoint map started from [`eg4_python`](https://pypi.org/project/eg4-python/) and [matt-dreyer/EG4_MCP_server](https://github.com/matt-dreyer/EG4_MCP_server) (MIT). The settings write paths, parameter catalog and on/off semantics were taken from the portal's own settings page.
