import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { resendAuthoritativeEmailChange } from "@/lib/account/supabase-account-security";

// Postgres service transactions replace the legacy withLockedEndUserMutation SQLite boundary.

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.email_change.resend");
  if (!guard.ok) return guard.response;

  if (
    !(await consumeDistributedRateLimit({
      key: `email-change-resend:${guard.parent.session.sub}`,
      limit: RATE_LIMIT_ATTEMPTS,
      windowMs: RATE_LIMIT_WINDOW_MS,
    }))
  ) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  const issued = await resendAuthoritativeEmailChange(guard.parent.session.sub);
  if (!issued) {
    return NextResponse.json({ error: "NO_PENDING_REQUEST" }, { status: 404 });
  }

  return NextResponse.json({
    expiresAt: issued.expiresAt,
    ...(issued.localLink ? { localLink: issued.localLink } : {}),
  });
}
