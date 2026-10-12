import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Eg4Error } from "../eg4/client";
import { SettingInputError } from "../eg4/settings";

/** Keeps tool results inside a comfortable context budget. */
export const MAX_RESULT_CHARS = 60_000;

export function ok(payload: unknown): CallToolResult {
  let text = JSON.stringify(payload ?? null);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated: result too large. Narrow the request (shorter date range, larger interval, raw_filter).]`;
  }
  return { content: [{ type: "text", text }] };
}

export function fail(err: unknown): CallToolResult {
  const message =
    err instanceof Eg4Error || err instanceof SettingInputError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}
