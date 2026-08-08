import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { parseExchangeBody } from "@/lib/app-launch/contracts";
import { AppLaunchError, exchangeAppLaunch } from "@/lib/app-launch/service";

function failure(error: unknown) {
  const code = error instanceof AppLaunchError ? error.code : "APP_LAUNCH_EXCHANGE_FAILED";
  const status = code === "APP_SERVICE_AUTHENTICATION_FAILED" ? 401 : code === "LAUNCH_CODE_INVALID" ? 404 :
    code === "IDEMPOTENCY_KEY_REUSED" || code.includes("REPLAY") || code.includes("USED") ? 409 : 403;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const assertion = request.headers.get("x-babysteps-app-assertion");
  if (!assertion) return NextResponse.json({ error: "APP_SERVICE_AUTHENTICATION_FAILED" }, { status: 401 });
  const peer = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!checkRateLimit(`app-launch-exchange:${peer}`, 60, 60_000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const body = parseExchangeBody(await request.json());
    const result = await exchangeAppLaunch({ ...body, clientAssertion: assertion, now: new Date() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
