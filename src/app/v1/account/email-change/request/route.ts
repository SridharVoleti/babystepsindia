import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { requestAuthoritativeEmailChange } from "@/lib/account/supabase-account-security";
import { validateNewEmail } from "@/lib/account/security-validation";

// Postgres service transactions replace the legacy withLockedEndUserMutation SQLite boundary.

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.email_change.request");
  if (!guard.ok) return guard.response;

  if (
    !(await consumeDistributedRateLimit({ key: `email-change-request:${guard.parent.session.sub}`, limit: RATE_LIMIT_ATTEMPTS, windowMs: RATE_LIMIT_WINDOW_MS }))
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
  const currentEmail = guard.parent.user.email;

  const validation = validateNewEmail({ currentEmail, newEmail: newEmailInput });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.code, message: validation.error }, { status: 400 });
  }

  const issued = await requestAuthoritativeEmailChange({ userId: guard.parent.session.sub, currentEmail, currentPassword, newEmail: validation.email });
  if (!issued.ok && issued.code === "CURRENT_PASSWORD_INCORRECT") {
    return NextResponse.json({ error: "CURRENT_PASSWORD_INCORRECT", message: "That password is incorrect." }, { status: 401 });
  }

  // Business rule 4: unused by another Auth identity. Generic error —
  // "reject without revealing unrelated account details" (unlike IA-001
  // signup, which intentionally does reveal an existing account).
  if (!issued.ok) {
    return NextResponse.json(
      { error: "EMAIL_UNAVAILABLE", message: "That email can't be used for your account." },
      { status: 400 },
    );
  }

  return NextResponse.json({
    newEmail: issued.newEmail,
    expiresAt: issued.expiresAt,
    ...("localLink" in issued && issued.localLink ? { localLink: issued.localLink } : {}),
  });
}
