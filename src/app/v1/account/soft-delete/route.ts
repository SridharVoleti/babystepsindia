import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { softDeleteAuthoritativeAccount } from "@/lib/account/supabase-account-security";

// Postgres service transactions replace the legacy withLockedEndUserMutation SQLite boundary.
import { validateDeleteConfirmation } from "@/lib/account/security-validation";
import { clearSessionCookie } from "@/lib/auth/session";

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.delete");
  if (!guard.ok) return guard.response;

  if (
    !(await consumeDistributedRateLimit({ key: `soft-delete:${guard.parent.session.sub}`, limit: RATE_LIMIT_ATTEMPTS, windowMs: RATE_LIMIT_WINDOW_MS }))
  ) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";

  if (!validateDeleteConfirmation(confirmation)) {
    return NextResponse.json(
      { error: "CONFIRMATION_REQUIRED", message: 'Type "DELETE" to confirm.' },
      { status: 400 },
    );
  }

  const deleted = await softDeleteAuthoritativeAccount({ userId: guard.parent.session.sub, email: guard.parent.user.email, currentPassword });
  if (!deleted) {
    return NextResponse.json({ error: "CURRENT_PASSWORD_INCORRECT", message: "That password is incorrect." }, { status: 401 });
  }

  // Belt-and-suspenders: auth_revoked_before already denies this session's
  // token on its next check (guards.ts/api-guard.ts), but clearing the
  // cookie here means *this* browser tab reflects it immediately too.
  clearSessionCookie();

  return NextResponse.json({ ok: true });
}
