import { AppLaunchError } from "@/lib/app-launch/service";

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppLaunchError("INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new AppLaunchError("DESTINATION_OVERRIDE_REJECTED");
  return record;
}

export function parseDispatchBody(value: unknown) {
  const body = exactObject(value, ["expectedVersion", "idempotencyKey"]);
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1 ||
      typeof body.idempotencyKey !== "string" || !body.idempotencyKey) throw new AppLaunchError("INVALID_REQUEST");
  return { expectedVersion: Number(body.expectedVersion), idempotencyKey: body.idempotencyKey };
}

export function parseExchangeBody(value: unknown) {
  const body = exactObject(value, ["launchCode", "launchAttemptId", "exchangeIdempotencyKey"]);
  for (const key of ["launchCode", "launchAttemptId", "exchangeIdempotencyKey"] as const) {
    if (typeof body[key] !== "string" || !body[key]) throw new AppLaunchError("INVALID_REQUEST");
  }
  return { launchCode: body.launchCode as string, launchAttemptId: body.launchAttemptId as string,
    exchangeIdempotencyKey: body.exchangeIdempotencyKey as string };
}
