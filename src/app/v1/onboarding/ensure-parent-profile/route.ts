import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { sqliteParentProfileStore } from "@/lib/db/parent-profile-store";
import { ensureParentProfile } from "@/lib/auth/parent-profile";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";

// IA-001 recovery contract: authenticated, verified-email only; the user ID
// always comes from the signed session, never from the request body. Recovery
// is idempotent and never reactivates a suspended or deleted profile.
//
// Bootstrap authentication is checked before profile recovery so a genuinely
// missing row can be repaired. The normal account-status and AU-002 mode
// boundary is then applied before any profile data is returned.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const authUser = await sqliteAuthAdapter.getUserById(session.sub);
  if (!authUser?.emailVerified) {
    return NextResponse.json({ error: "EMAIL_NOT_VERIFIED" }, { status: 403 });
  }

  const { profile } = await ensureParentProfile(sqliteParentProfileStore, session.sub);
  const guard = await requireEndUserAuthorization(
    request,
    "parent.onboarding.ensure",
    { parentUserId: session.sub },
  );
  if (!guard.ok) return guard.response;

  return NextResponse.json({ profile, onboardingStatus: profile.onboarding_status });
}
