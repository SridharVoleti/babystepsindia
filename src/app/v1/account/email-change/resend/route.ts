import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { resendEmailChange } from "@/lib/db/account-security-repo";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";

const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.email_change.resend");
  if (!guard.ok) return guard.response;

  if (
    !checkRateLimit(
      `email-change-resend:${guard.parent.session.sub}`,
      RATE_LIMIT_ATTEMPTS,
      RATE_LIMIT_WINDOW_MS,
    )
  ) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  const issued = await withLockedEndUserMutation({ preflight: guard.authorization,
    action: "parent.account.email_change.resend", resource: { parentUserId: guard.parent.session.sub },
    mutate: () => resendEmailChange(guard.parent.session.sub) });
  if (!issued) {
    return NextResponse.json({ error: "NO_PENDING_REQUEST" }, { status: 404 });
  }

  return NextResponse.json({
    expiresAt: issued.expiresAt,
    verificationUrl: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/email-change/callback?token=${issued.token}`,
  });
}
