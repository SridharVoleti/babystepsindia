import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { validateOnboarding, type OnboardingInput } from "@/lib/parent-profile/onboarding-validation";
import { completeParentOnboarding, getOnboardingProfile } from "@/lib/db/parent-profile-repo";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";

const RATE_LIMIT_ATTEMPTS = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

// IA-002: a verified, active parent may read/update only their own
// profile. Email always comes from the authenticated session (guard.context
// .user.email) — it is never read from the request body, so a client
// cannot change it through this endpoint (AC7/AT-IA-002-07).
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.profile.read");
  if (!guard.ok) return guard.response;

  const view = await getOnboardingProfile(guard.parent.session.sub, guard.parent.user.email);
  if (!view) {
    return NextResponse.json({ error: "PARENT_PROFILE_NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json(view);
}

export async function PATCH(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.profile.update");
  if (!guard.ok) return guard.response;

  if (
    !checkRateLimit(`profile-update:${guard.parent.session.sub}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)
  ) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const body = rawBody as Partial<Record<keyof OnboardingInput, unknown>> & Record<string, unknown>;
  const excludedFields = [
    "address",
    "postalAddress",
    "postal_address",
    "dateOfBirth",
    "date_of_birth",
    "parentDateOfBirth",
    "parent_date_of_birth",
    "legalName",
    "legal_name",
  ];
  if (excludedFields.some((field) => Object.hasOwn(body, field))) {
    return NextResponse.json({ error: "UNEXPECTED_PROFILE_FIELD" }, { status: 400 });
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
    await withLockedEndUserMutation({ preflight: guard.authorization, action: "parent.profile.update",
      resource: { parentUserId: guard.parent.session.sub },
      mutate: () => completeParentOnboarding(guard.parent.session.sub, validation.value) });
  } catch {
    return NextResponse.json({ error: "SAVE_FAILED" }, { status: 500 });
  }

  const view = (await getOnboardingProfile(guard.parent.session.sub, guard.parent.user.email))!;
  return NextResponse.json(view);
}
