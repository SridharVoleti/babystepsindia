import { getDb } from "@/lib/db/client";
import {
  authorizeEndUserAction,
  deriveAuthorizationContext,
  type AuthorizationAction,
  type EndUserAuthorizationContext,
} from "@/lib/authorization/modes";

/**
 * Repeats the authoritative end-user decision after SQLite has acquired its
 * write lock. Nested repository transactions become savepoints, so the final
 * decision and every resulting write commit or roll back as one unit.
 */
export function withLockedEndUserMutation<T>(input: {
  preflight: EndUserAuthorizationContext;
  action: AuthorizationAction;
  resource?: { learnerId?: string; parentUserId?: string };
  now?: Date;
  mutate: () => T;
}): T {
  const db = getDb();
  const run = db.transaction(() => {
    const current = deriveAuthorizationContext({
      parentUserId: input.preflight.parentUserId,
      parentSessionId: input.preflight.parentSessionId,
      deviceSessionId: input.preflight.deviceSessionId,
      now: input.now ?? new Date(),
    });
    authorizeEndUserAction(current, input.action, input.resource);
    return input.mutate();
  });
  return run.immediate();
}
