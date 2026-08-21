import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { POLICY_VERSION, PROCESSING_ENVELOPE_VERSION } from "@/lib/db/consent";
import type { ConsentType, Profile } from "@/lib/db/types";
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

async function upsertConsent(
  tx: ReturnType<typeof resolveDbClient>, parentUserId: string, consentType: ConsentType,
  policyVersion: string, now: string,
) {
  await tx.run(
    `insert into consent_records
       (id, parent_user_id, consent_type, policy_version, granted, granted_at, revoked_at)
     values (?, ?, ?, ?, ?, ?, null)
     on conflict (parent_user_id, consent_type, policy_version)
     do update set granted = excluded.granted, granted_at = excluded.granted_at, revoked_at = null
     where consent_records.granted = false or consent_records.revoked_at is not null`,
    [randomUUID(), parentUserId, consentType, policyVersion, true, now],
  );
}

export async function completeParentOnboarding(userId: string, value: ValidatedOnboarding): Promise<Profile> {
  return resolveDbClient().transaction(async (tx) => {
    const before = await tx.get<Profile>("select * from profiles where id = ?", [userId]);
    if (!before) throw new Error("PARENT_PROFILE_NOT_FOUND");

    const now = new Date().toISOString();
    await tx.run(
      `update profiles set
         display_name = ?, phone_e164 = ?, phone_country_code = ?, locale = ?, timezone = ?,
         onboarding_status = case when onboarding_status = 'profile_pending' then 'learner_pending' else onboarding_status end,
         updated_at = ?
       where id = ?`,
      [value.displayName, value.phoneE164, value.phoneCountryCode, value.locale, value.timezone, now, userId],
    );

    await upsertConsent(tx, userId, "terms_of_service", POLICY_VERSION, now);
    await upsertConsent(tx, userId, "privacy_policy", POLICY_VERSION, now);
    await upsertConsent(tx, userId, "processing_envelope", PROCESSING_ENVELOPE_VERSION, now);

    const changedFields: string[] = [];
    if (before.display_name !== value.displayName) changedFields.push("displayName");
    if (before.phone_e164 !== value.phoneE164 || before.phone_country_code !== value.phoneCountryCode) changedFields.push("phone");
    if (before.locale !== value.locale) changedFields.push("locale");
    if (before.timezone !== value.timezone) changedFields.push("timezone");
    if (before.onboarding_status === "profile_pending") changedFields.push("onboardingStatus");
    if (changedFields.length > 0) {
      await tx.run(
        "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, 'parent_profile_changed', ?)",
        [randomUUID(), userId, JSON.stringify({ changedFields })],
      );
    }

    const profile = await tx.get<Profile>("select * from profiles where id = ?", [userId]);
    if (!profile) throw new Error("PARENT_PROFILE_NOT_FOUND");
    return profile;
  });
}
