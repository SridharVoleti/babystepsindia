import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
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
export function getOnboardingProfile(userId: string, email: string): OnboardingProfileView | null {
  const row = getDb().prepare("select * from profiles where id = ?").get(userId) as
    | Profile
    | undefined;
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
// better-sqlite3's db.transaction() rolls back all of it if any statement
// throws. Only advances profile_pending -> learner_pending; a later call
// (e.g. changing the phone number after onboarding) never regresses an
// already-further-along status.
export function completeParentOnboarding(userId: string, value: ValidatedOnboarding): Profile {
  const db = getDb();

  const run = db.transaction(() => {
    const before = db.prepare("select * from profiles where id = ?").get(userId) as
      | Profile
      | undefined;
    if (!before) throw new Error("PARENT_PROFILE_NOT_FOUND");

    db.prepare(
      `update profiles set
         display_name = ?,
         phone_e164 = ?,
         phone_country_code = ?,
         locale = ?,
         timezone = ?,
         onboarding_status = case when onboarding_status = 'profile_pending' then 'learner_pending' else onboarding_status end,
         updated_at = datetime('now')
       where id = ?`,
    ).run(
      value.displayName,
      value.phoneE164,
      value.phoneCountryCode,
      value.locale,
      value.timezone,
      userId,
    );

    recordConsent(userId, "terms_of_service");
    recordConsent(userId, "privacy_policy");
    recordProcessingEnvelopeConsent(userId);

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
      db.prepare(
        "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, 'parent_profile_changed', ?)",
      ).run(randomUUID(), userId, JSON.stringify({ changedFields }));
    }
  });
  run();

  return db.prepare("select * from profiles where id = ?").get(userId) as Profile;
}
