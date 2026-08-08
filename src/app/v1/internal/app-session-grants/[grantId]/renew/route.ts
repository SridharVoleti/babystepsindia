import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppAuthorizationError, renewAppGrantWithAssertion } from "@/lib/app-authorization/service";
import { AppLaunchError } from "@/lib/app-launch/errors";

export async function POST(request: Request, { params }: { params: { grantId: string } }) {
  const assertion = request.headers.get("x-babysteps-app-assertion");
  const authorization = request.headers.get("authorization");
  if (!assertion || !authorization?.startsWith("Bearer "))
    return NextResponse.json({ error: "APP_DUAL_CREDENTIAL_REQUIRED" }, { status: 401 });
  if (!checkRateLimit(`grant-renew:${params.grantId}`, 30, 60_000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => key !== "renewalIdempotencyKey") ||
        typeof body.renewalIdempotencyKey !== "string" || !body.renewalIdempotencyKey)
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const result = await renewAppGrantWithAssertion({ grantId: params.grantId,
      accessToken: authorization.slice(7), clientAssertion: assertion,
      idempotencyKey: body.renewalIdempotencyKey, now: new Date() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof AppAuthorizationError || error instanceof AppLaunchError ? error.code : "APP_AUTHORIZATION_FAILED";
    const status = error instanceof AppLaunchError ? 401 :
      ["IDEMPOTENCY_KEY_REUSED","APP_CLIENT_ASSERTION_REPLAYED"].includes(code) ? 409 : 403;
    return NextResponse.json({ error: code }, { status,
      headers: { "Cache-Control": "no-store" } });
  }
}
