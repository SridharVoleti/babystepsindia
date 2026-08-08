function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomDeviceKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes.buffer);
}

async function hmacKey(deviceKeyRaw: string) {
  return crypto.subtle.importKey("raw", hexToBytes(deviceKeyRaw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function canonicalMessage(payload: unknown, serverProgressVersion: number, recordedAt: string) {
  return new TextEncoder().encode(JSON.stringify({ payload, serverProgressVersion, recordedAt }));
}

// GAP-081: the pending capsule is bound (HMAC) to this device's runtime
// instance via a key that only ever lives in this browser's IndexedDB —
// it never travels to the server or another device, so a capsule that
// verifies here could only have been written by this same runtime.
export async function signCapsulePayload(deviceKeyRaw: string, payload: unknown, serverProgressVersion: number, recordedAt: string) {
  const key = await hmacKey(deviceKeyRaw);
  const signature = await crypto.subtle.sign("HMAC", key, canonicalMessage(payload, serverProgressVersion, recordedAt));
  return bytesToHex(signature);
}

export async function verifyCapsulePayload(deviceKeyRaw: string, payload: unknown, serverProgressVersion: number,
  recordedAt: string, hmac: string) {
  const key = await hmacKey(deviceKeyRaw);
  return crypto.subtle.verify("HMAC", key, hexToBytes(hmac), canonicalMessage(payload, serverProgressVersion, recordedAt));
}
