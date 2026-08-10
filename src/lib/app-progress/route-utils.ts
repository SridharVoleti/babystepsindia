import { NextResponse } from "next/server";
import { AppAuthorizationError } from "@/lib/app-authorization/service";
import { AppLaunchError } from "@/lib/app-launch/errors";
import { AppProgressError } from "@/lib/app-progress/service";

export function progressRouteError(error: unknown) {
  const code = error instanceof AppAuthorizationError || error instanceof AppLaunchError || error instanceof AppProgressError
    ? error.code : "PROGRESS_OPERATION_FAILED";
  const status = code === "IDEMPOTENCY_KEY_REUSED" || code === "PROGRESS_VERSION_CONFLICT" ||
    code === "PROGRESS_INTEGRITY_MUTATION_BLOCKED" || code === "PROGRESS_INTEGRITY_UNREADABLE" ? 409 :
    error instanceof AppAuthorizationError || error instanceof AppLaunchError ? 401 :
    code === "LEARNER_SESSION_NOT_ACTIVE" ? 403 : 400;
  return NextResponse.json({error:code},{status,headers:{"Cache-Control":"no-store"}});
}

export function strictObject(value: unknown, allowed: string[]) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
    Object.keys(value).some((key) => !allowed.includes(key))) throw new AppProgressError("PROGRESS_STATE_INVALID");
  return value as Record<string,unknown>;
}
