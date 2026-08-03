import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { sqliteParentProfileStore } from "@/lib/db/parent-profile-store";
import { ensureParentProfile } from "@/lib/auth/parent-profile";

// IA-001 recovery contract: authenticated, verified-email only; the user
// ID always comes from the session, never from the request body; safe to
// call repeatedly (AT-IA-001-03); never reactivates a suspended/deleted
// profile (find() returns it as-is, insert() only fires when missing).
//
// Deliberately narrower than api-guard.ts's requireApiParent(): the CBS
// contract for this endpoint only rejects EMAIL_NOT_VERIFIED, not account
// status — it's identity bootstrap, not protected parent/learner data
// access, so a suspended parent can still safely call it (and won't be
// reactivated by it).
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const authUser = await sqliteAuthAdapter.getUserById(session.sub);
  if (!authUser?.emailVerified) {
    return NextResponse.json({ error: "EMAIL_NOT_VERIFIED" }, { status: 403 });
  }

  const { profile } = await ensureParentProfile(sqliteParentProfileStore, session.sub);

  return NextResponse.json({ profile, onboardingStatus: profile.onboarding_status });
}
