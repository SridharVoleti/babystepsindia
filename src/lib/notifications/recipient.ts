import { resolveDbClient } from "@/lib/db-client";

export type VerifiedParentEmail = { parentId: string; email: string; identityVersion: string };

// Rules 14-17, 56: the single authoritative "current verified parent email"
// resolver — deliberately the only gate is email_verified_at being set.
// Never reads email_change_requests (a pending replacement is never used,
// rule 15). Does not gate on profiles.account_status (rule 55: NT-001 never
// silently drops a mandatory financial/security message solely because
// interactive account access is blocked — a suspended/soft-deleted parent
// keeps whatever verified email they had; whether to enqueue at all for
// such a parent is the calling source domain's decision, not this
// resolver's).
export async function resolveCurrentVerifiedParentEmail(parentId: string): Promise<VerifiedParentEmail | null> {
  const row = await resolveDbClient().get<{ email: string; email_verified_at: string | null }>(
    "select email, email_verified_at from users where id = ?", [parentId]);
  if (!row || !row.email_verified_at) return null;
  return { parentId, email: row.email, identityVersion: row.email_verified_at };
}
