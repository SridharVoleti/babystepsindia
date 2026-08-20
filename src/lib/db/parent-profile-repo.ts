import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { recordConsent, recordProcessingEnvelopeConsent, POLICY_VERSION } from "@/lib/db/consent";
import type { Profile } from "@/lib/db/types";
import type { ValidatedOnboarding } from "@/lib/parent-profile/onboarding-validation";

export type OnboardingProfileView = {
  email: string;
  displayName: string | null;
  phoneE164: string | null;
  phoneCountryCode: string | null;
  onboardingStatus: Profile["onboarding_status"];
  locale: string;
  timezone: string;
  currentPolicyVersions: { termsOfService: string; privacyPolicy: string };
};

// GET /v1/parent/profile: read-only view for the onboarding screen. Email
// always comes from the caller (the authenticated Supabase/adapter user),
// never from this table — profiles has no email column (AC7).
export async function getOnboardingProfile(userId: string, email: string): Promise<OnboardingProfileView | null> {
  const row = await resolveDbClient().get<Profile>("select * from profiles where id = ?", [userId]);
  if (!row) return null;

  return {
    email,
    displayName: row.display_name,
    phoneE164: row.phone_e164,
    phoneCountryCode: row.phone_country_code,
    onboardingStatus: row.onboarding_status,
    locale: row.locale,
    timezone: row.timezone,
    currentPolicyVersions: { termsOfService: POLICY_VERSION, privacyPolicy: POLICY_VERSION },
  };
}

// PATCH /v1/parent/profile: updates the profile, records both consents,
// and advances onboarding_status in one transaction (AC9/AT-IA-002-09) —
// rolls back all of it if any statement throws. Only advances
// profile_pending -> learner_pending; a later call (e.g. changing the phone
// number after onboarding) never regresses an already-further-along status.
export async function completeParentOnboarding(userId: string, value: ValidatedOnboarding): Promise<Profile> {
  await resolveDbClient().transaction(async (db: DbClient) => {
    const before = await db.get<Profile>("select * from profiles where id = ?", [userId]);
    if (!before) throw new Error("PARENT_PROFILE_NOT_FOUND");

    await db.run(
      `update profiles set
         display_name = ?,
         phone_e164 = ?,
         phone_country_code = ?,
         locale = ?,
         timezone = ?,
         onboarding_status = case when onboarding_status = 'profile_pending' then 'learner_pending' else onboarding_status end,
         updated_at = ?
       where id = ?`,
      [
        value.displayName,
        value.phoneE164,
        value.phoneCountryCode,
        value.locale,
        value.timezone,
        new Date().toISOString(),
        userId,
      ],
    );

    await recordConsent(userId, "terms_of_service");
    await recordConsent(userId, "privacy_policy");
    await recordProcessingEnvelopeConsent(userId);

    const changedFields: string[] = [];
    if (before.display_name !== value.displayName) changedFields.push("displayName");
    if (
      before.phone_e164 !== value.phoneE164 ||
      before.phone_country_code !== value.phoneCountryCode
    ) {
      changedFields.push("phone");
    }
    if (before.locale !== value.locale) changedFields.push("locale");
    if (before.timezone !== value.timezone) changedFields.push("timezone");
    if (before.onboarding_status === "profile_pending") changedFields.push("onboardingStatus");

    if (changedFields.length > 0) {
      await db.run(
        "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, 'parent_profile_changed', ?)",
        [randomUUID(), userId, JSON.stringify({ changedFields })],
      );
    }
  });

  return (await resolveDbClient().get<Profile>("select * from profiles where id = ?", [userId]))!;
}
