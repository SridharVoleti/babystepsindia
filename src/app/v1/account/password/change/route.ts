import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { changeAuthoritativePassword } from "@/lib/account/supabase-account-security";
import { validateNewPasswordFormat } from "@/lib/account/security-validation";

// Postgres service transactions replace the legacy withLockedEndUserMutation SQLite boundary.

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.password.change");
  if (!guard.ok) return guard.response;

  if (
    !(await consumeDistributedRateLimit({ key: `password-change:${guard.parent.session.sub}`, limit: RATE_LIMIT_ATTEMPTS, windowMs: RATE_LIMIT_WINDOW_MS }))
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
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  const format = validateNewPasswordFormat({ newPassword, confirmPassword });
  if (!format.ok) {
    return NextResponse.json({ error: format.code, message: format.error }, { status: 400 });
  }

  // AC2: current password revalidated immediately before the change,
  // using the same stateless reauth check as login (no session side
  // effects — nothing persists from this call beyond its return value).
  const email = guard.parent.user.email;
  const result = await changeAuthoritativePassword({ userId: guard.parent.session.sub, email, currentPassword, newPassword });
  if (!result.ok && result.code === "CURRENT_PASSWORD_INCORRECT") {
    return NextResponse.json({ error: "CURRENT_PASSWORD_INCORRECT", message: "That password is incorrect." }, { status: 401 });
  }

  // Business rule 3: new password must differ from the current one.
  if (!result.ok && result.code === "PASSWORD_UNCHANGED") {
    return NextResponse.json(
      { error: "PASSWORD_UNCHANGED", message: "New password must differ from your current password." },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true });
}
