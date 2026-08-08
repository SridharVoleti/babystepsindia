import { authorizeDualCredentialRequest, type AppApiScope } from "@/lib/app-authorization/service";

/** Shared guard for every app-facing protected API route. */
export function authorizeProtectedAppApi(request: Request, requiredScope: AppApiScope, now = new Date()) {
  const authorization = request.headers.get("authorization");
  return authorizeDualCredentialRequest({
    accessToken: authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined,
    clientAssertion: request.headers.get("x-babysteps-app-assertion") ?? undefined,
    requiredScope,
    now,
  });
}
