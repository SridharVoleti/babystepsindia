import { NextResponse } from "next/server";
import { requireApiParent } from "@/lib/auth/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { validateOnboarding, type OnboardingInput } from "@/lib/parent-profile/onboarding-validation";
import { completeParentOnboarding, getOnboardingProfile } from "@/lib/db/parent-profile-repo";

const RATE_LIMIT_ATTEMPTS = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

// IA-002: a verified, active parent may read/update only their own
// profile. Email always comes from the authenticated session (guard.context
// .user.email) — it is never read from the request body, so a client
// cannot change it through this endpoint (AC7/AT-IA-002-07).
export async function GET() {
  const guard = await requireApiParent();
  if (!guard.ok) return guard.response;

  const view = getOnboardingProfile(guard.context.session.sub, guard.context.user.email);
  if (!view) {
    return NextResponse.json({ error: "PARENT_PROFILE_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json(view);
}

export async function PATCH(request: Request) {
  const guard = await requireApiParent();
  if (!guard.ok) return guard.response;

  if (
    !checkRateLimit(`profile-update:${guard.context.session.sub}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)
  ) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Partial<Record<keyof OnboardingInput, unknown>>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const validation = validateOnboarding({
    displayName: typeof body.displayName === "string" ? body.displayName : "",
    phoneCountryCode: typeof body.phoneCountryCode === "string" ? body.phoneCountryCode : "",
    mobileNumber: typeof body.mobileNumber === "string" ? body.mobileNumber : "",
    locale: typeof body.locale === "string" ? body.locale : undefined,
    timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    acceptedTermsVersion: typeof body.acceptedTermsVersion === "string" ? body.acceptedTermsVersion : "",
    acceptedPrivacyVersion:
      typeof body.acceptedPrivacyVersion === "string" ? body.acceptedPrivacyVersion : "",
  });

  if (!validation.ok) {
    return NextResponse.json({ error: validation.code, message: validation.error }, { status: 400 });
  }

  try {
    completeParentOnboarding(guard.context.session.sub, validation.value);
  } catch {
    return NextResponse.json({ error: "SAVE_FAILED" }, { status: 500 });
  }

  const view = getOnboardingProfile(guard.context.session.sub, guard.context.user.email)!;
  return NextResponse.json(view);
}
