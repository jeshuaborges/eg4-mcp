const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secretB64: string): Promise<CryptoKey> {
  let key = keyCache.get(secretB64);
  if (!key) {
    const raw = b64ToBytes(secretB64);
    if (raw.length !== 32) throw new Error("EG4_CACHE_KEY must be base64 of exactly 32 bytes");
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secretB64, key);
  }
  return key;
}

/** AES-GCM encrypt; output is base64(iv || ciphertext). `aad` binds the value to its storage key. */
export async function seal(secretB64: string, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    await importKey(secretB64),
    enc.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return bytesToB64(out);
}

/** Returns null when the value can't be decrypted (wrong key, tampering, rotated secret). */
export async function open(secretB64: string, sealed: string, aad: string): Promise<string | null> {
  try {
    const bytes = b64ToBytes(sealed);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(aad) },
      await importKey(secretB64),
      bytes.slice(12),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
