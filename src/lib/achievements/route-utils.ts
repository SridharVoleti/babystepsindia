import { NextResponse } from "next/server";
import { AchievementError } from "@/lib/achievements/service";
import { AppAuthorizationError, consumeAppAssertionReplay } from "@/lib/app-authorization/service";
import { AppLaunchError } from "@/lib/app-launch/errors";
import { verifyAppClientAssertionWithClient } from "@/lib/app-launch/principal";
import { resolveDbClient } from "@/lib/db-client";

export function strictAchievementObject(value: unknown, allowed: readonly string[]) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AchievementError("ACHIEVEMENT_CONTENT_INVALID");
  }
  return value as Record<string, unknown>;
}

export function achievementRouteError(error: unknown) {
  const code = error instanceof AchievementError || error instanceof AppAuthorizationError || error instanceof AppLaunchError
    ? error.code : "ACHIEVEMENT_OPERATION_FAILED";
  const status = code === "ACHIEVEMENT_PAYLOAD_TOO_LARGE" ? 413
    : ["ACHIEVEMENT_INSTANCE_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "ACHIEVEMENT_VERSION_CONFLICT",
      "ACHIEVEMENT_ALREADY_REVOKED", "ACHIEVEMENT_CONTRACT_UNSUPPORTED"].includes(code) ? 409
    : code === "ACHIEVEMENT_RESOURCE_NOT_FOUND" || code === "ACHIEVEMENT_CONTRACT_NOT_FOUND" ? 404
    : error instanceof AppAuthorizationError || error instanceof AppLaunchError ? 401
    : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function authorizeAppPrincipalAssertion(request: Request, now = new Date()) {
  const assertion = request.headers.get("x-babysteps-app-assertion") ?? "";
  const auth = await verifyAppClientAssertionWithClient(resolveDbClient(), assertion, now, "babysteps:platform-api");
  await consumeAppAssertionReplay(auth);
  return auth.principal;
}
