import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { validateDeleteConfirmation } from "@/lib/account/security-validation";
import { softDeleteAccount } from "@/lib/db/account-security-repo";
import { clearSessionCookie } from "@/lib/auth/session";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.delete");
  if (!guard.ok) return guard.response;

  if (
    !checkRateLimit(`soft-delete:${guard.parent.session.sub}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)
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

  const reauth = await sqliteAuthAdapter.signInWithPassword(guard.parent.user.email, currentPassword);
  if (!reauth) {
    return NextResponse.json({ error: "CURRENT_PASSWORD_INCORRECT", message: "That password is incorrect." }, { status: 401 });
  }

  await withLockedEndUserMutation({ preflight: guard.authorization,
    action: "parent.account.delete", resource: { parentUserId: guard.parent.session.sub },
    mutate: () => softDeleteAccount(guard.parent.session.sub) });
  // Belt-and-suspenders: auth_revoked_before already denies this session's
  // token on its next check (guards.ts/api-guard.ts), but clearing the
  // cookie here means *this* browser tab reflects it immediately too.
  clearSessionCookie();

  return NextResponse.json({ ok: true });
}
