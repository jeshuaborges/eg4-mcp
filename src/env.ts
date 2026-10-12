import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Public origin of this Worker, e.g. https://eg4-mcp.example.workers.dev (no trailing slash). */
  PUBLIC_BASE_URL: string;
  /** EG4 monitoring portal origin. */
  EG4_BASE_URL: string;
  /** base64 of 32 random bytes; encrypts cached EG4 session cookies. */
  EG4_CACHE_KEY: string;
}

/** Stored encrypted on the OAuth grant (decryptable only with a valid access token). */
export interface GrantProps {
  /** EG4 monitor account (username). */
  account: string;
  password: string;
  /** False when the user connected read-only; write tools aren't registered. */
  canWrite: boolean;
}
