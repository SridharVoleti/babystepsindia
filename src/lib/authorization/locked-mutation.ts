import { resolveDbClient } from "@/lib/db-client";
import {
  authorizeEndUserAction,
  deriveAuthorizationContext,
  type AuthorizationAction,
  type EndUserAuthorizationContext,
} from "@/lib/authorization/modes";

/**
 * Repeats the authoritative end-user decision after the write lock is
 * acquired. Nested repository transactions become savepoints (SQLite) or
 * run on the same held connection (Postgres), so the final decision and
 * every resulting write commit or roll back as one unit.
 */
export async function withLockedEndUserMutation<T>(input: {
  preflight: EndUserAuthorizationContext;
  action: AuthorizationAction;
  resource?: { learnerId?: string; parentUserId?: string };
  now?: Date;
  mutate: () => T | Promise<T>;
}): Promise<T> {
  return resolveDbClient().transaction(async () => {
    const current = deriveAuthorizationContext({
      parentUserId: input.preflight.parentUserId,
      parentSessionId: input.preflight.parentSessionId,
      deviceSessionId: input.preflight.deviceSessionId,
      now: input.now ?? new Date(),
    });
    authorizeEndUserAction(current, input.action, input.resource);
    return input.mutate();
  });
}
