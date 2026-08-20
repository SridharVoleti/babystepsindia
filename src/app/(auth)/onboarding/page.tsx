import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOnboardingParent } from "@/lib/auth/guards";
import { getOnboardingProfile } from "@/lib/db/parent-profile-repo";
import { ParentOnboardingForm } from "@/components/onboarding/parent-onboarding-form";

export const metadata: Metadata = { title: "Complete your profile — Baby Steps" };

export default async function OnboardingPage() {
  const { session, profile } = await requireOnboardingParent();

  // Alt flow: "Profile already complete: redirect to the next incomplete
  // onboarding step." No further onboarding step exists yet, so /account.
  if (profile.onboarding_status !== "profile_pending") {
    redirect("/account");
  }

  const view = (await getOnboardingProfile(session.sub, session.email))!;

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">
        Complete your profile
      </h1>
      <p className="mb-6 text-center text-sm text-chakra-500">
        Just a mobile number so we can reach you — no verification call or
        text required.
      </p>
      <ParentOnboardingForm initialProfile={view} />
    </>
  );
}
