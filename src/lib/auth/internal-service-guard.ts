import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export type InternalServiceGuardResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

// AC31 / AT-AN-001-31: internal contribution and scheduled-job endpoints
// are unavailable to browsers — gated by a dedicated shared secret header
// only trusted platform services present, never a browser session
// cookie. Fails closed (no configured secret => reject) rather than
// treating a misconfigured server as open.
export function requireInternalService(request: Request): InternalServiceGuardResult {
  const expected = process.env.ANALYTICS_INTERNAL_SERVICE_SECRET;
  const unauthenticated = () =>
    ({ ok: false as const, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) });

  if (!expected || expected.length < 32) return unauthenticated();

  const provided = request.headers.get("x-internal-service-secret");
  if (!provided) return unauthenticated();

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  const valid = expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
  if (!valid) return unauthenticated();

  return { ok: true };
}
