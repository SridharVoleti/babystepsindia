import { NextResponse } from "next/server";
import { requireApiParent } from "@/lib/auth/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { validateDeleteConfirmation } from "@/lib/account/security-validation";
import { softDeleteAccount } from "@/lib/db/account-security-repo";
import { clearSessionCookie } from "@/lib/auth/session";

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireApiParent();
  if (!guard.ok) return guard.response;

  if (
    !checkRateLimit(`soft-delete:${guard.context.session.sub}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)
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

  const reauth = await sqliteAuthAdapter.signInWithPassword(guard.context.user.email, currentPassword);
  if (!reauth) {
    return NextResponse.json({ error: "CURRENT_PASSWORD_INCORRECT", message: "That password is incorrect." }, { status: 401 });
  }

  softDeleteAccount(guard.context.session.sub);
  // Belt-and-suspenders: auth_revoked_before already denies this session's
  // token on its next check (guards.ts/api-guard.ts), but clearing the
  // cookie here means *this* browser tab reflects it immediately too.
  clearSessionCookie();

  return NextResponse.json({ ok: true });
}
