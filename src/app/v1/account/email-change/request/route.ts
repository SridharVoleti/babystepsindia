import { NextResponse } from "next/server";
import { requireApiParent } from "@/lib/auth/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { validateNewEmail } from "@/lib/account/security-validation";
import { findUserByEmail } from "@/lib/db/users";
import { requestEmailChange } from "@/lib/db/account-security-repo";

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireApiParent();
  if (!guard.ok) return guard.response;

  if (
    !checkRateLimit(
      `email-change-request:${guard.context.session.sub}`,
      RATE_LIMIT_ATTEMPTS,
      RATE_LIMIT_WINDOW_MS,
    )
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
  const newEmailInput = typeof body.newEmail === "string" ? body.newEmail : "";
  const currentEmail = guard.context.user.email;

  const validation = validateNewEmail({ currentEmail, newEmail: newEmailInput });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.code, message: validation.error }, { status: 400 });
  }

  const reauth = await sqliteAuthAdapter.signInWithPassword(currentEmail, currentPassword);
  if (!reauth) {
    return NextResponse.json({ error: "CURRENT_PASSWORD_INCORRECT" }, { status: 401 });
  }

  // Business rule 4: unused by another Auth identity. Generic error —
  // "reject without revealing unrelated account details" (unlike IA-001
  // signup, which intentionally does reveal an existing account).
  if (findUserByEmail(validation.email)) {
    return NextResponse.json(
      { error: "EMAIL_UNAVAILABLE", message: "That email can't be used for your account." },
      { status: 400 },
    );
  }

  const issued = requestEmailChange(guard.context.session.sub, currentEmail, validation.email);

  return NextResponse.json({
    newEmail: validation.email,
    expiresAt: issued.expiresAt,
    // Local dev mode — no email provider configured, same pattern as
    // IA-001's verification/reset links.
    verificationUrl: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/email-change/callback?token=${issued.token}`,
  });
}
