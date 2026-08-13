import { NextResponse } from "next/server";
import { AppAuthorizationError } from "@/lib/app-authorization/service";
import { JourneyError } from "@/lib/journey/service";

export function strictJourneyObject(value: unknown, allowed: readonly string[]) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      Object.keys(value).some((key) => !allowed.includes(key))) throw new JourneyError("JOURNEY_CONTENT_INVALID");
  return value as Record<string, unknown>;
}

export function journeyRouteError(error: unknown) {
  const code = error instanceof JourneyError || error instanceof AppAuthorizationError
    ? error.code : "JOURNEY_OPERATION_FAILED";
  const status = code === "JOURNEY_PAYLOAD_TOO_LARGE" ? 413
    : code === "JOURNEY_PURGED" || code === "JOURNEY_PURGED_OLD_SOURCE" ? 410
    : ["JOURNEY_IDEMPOTENCY_CONFLICT", "JOURNEY_SOURCE_CONFLICT", "JOURNEY_RECONCILE_CONFLICT",
      "JOURNEY_ACHIEVEMENT_ALREADY_PROJECTED", "JOURNEY_CONTRACT_UNSUPPORTED"].includes(code) ? 409
    : code === "JOURNEY_NOT_FOUND" ? 404
    : error instanceof AppAuthorizationError ? 401 : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

