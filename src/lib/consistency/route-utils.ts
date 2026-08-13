import { NextResponse } from "next/server";
import { ConsistencyError } from "./service";

export function consistencyRouteError(error: unknown) {
  const code = error instanceof ConsistencyError ? error.code : "CONSISTENCY_OPERATION_FAILED";
  const status = code === "CONSISTENCY_RESOURCE_NOT_FOUND" || code === "CONSISTENCY_SOURCE_NOT_FOUND" ? 404
    : ["IDEMPOTENCY_KEY_REUSED", "CONSISTENCY_USAGE_VERSION_CONFLICT", "CONSISTENCY_SOURCE_CONFLICT"].includes(code) ? 409
    : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export function strictConsistencyObject(value: unknown, allowed: readonly string[]) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
    Object.keys(value).some((key) => !allowed.includes(key))) throw new ConsistencyError("CONSISTENCY_REQUEST_INVALID");
  return value as Record<string, unknown>;
}
