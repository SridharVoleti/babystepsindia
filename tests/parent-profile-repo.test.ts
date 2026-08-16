import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import {
  completeParentOnboarding,
  getOnboardingProfile,
} from "@/lib/db/parent-profile-repo";
import { POLICY_VERSION } from "@/lib/db/consent";

beforeEach(() => {
  useInMemoryDb();
});

const validValue = {
  displayName: "Asha Verma",
  phoneE164: "+919876543210",
  phoneCountryCode: "IN",
  locale: "en-IN",
  timezone: "Asia/Kolkata",
};

describe("getOnboardingProfile", () => {
  it("returns the profile, email, and current policy versions for a fresh signup", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    const view = getOnboardingProfile(user.id, user.email);
    expect(view).toEqual({
      email: "parent@example.com",
      displayName: null,
      phoneE164: null,
      phoneCountryCode: null,
      onboardingStatus: "profile_pending",
      locale: "en-IN",
      timezone: "Asia/Kolkata",
      currentPolicyVersions: { termsOfService: POLICY_VERSION, privacyPolicy: POLICY_VERSION },
    });
  });

  it("returns null when there is no profile row for the id", () => {
    expect(getOnboardingProfile("does-not-exist", "nobody@example.com")).toBeNull();
  });
});

describe("completeParentOnboarding", () => {
  it("updates the profile, advances onboarding_status, and records all three consents (AC2/AC4/AC9, PC-002 processing-envelope)", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    const profile = completeParentOnboarding(user.id, validValue);

    expect(profile.display_name).toBe("Asha Verma");
    expect(profile.phone_e164).toBe("+919876543210");
    expect(profile.phone_country_code).toBe("IN");
    expect(profile.onboarding_status).toBe("learner_pending");

    const consentCount = (
      getDb()
        .prepare("select count(*) as n from consent_records where parent_user_id = ?")
        .get(user.id) as { n: number }
    ).n;
    expect(consentCount).toBe(3);
  });

  it("stores a null display name without blocking completion (AC6)", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    const profile = completeParentOnboarding(user.id, { ...validValue, displayName: null });

    expect(profile.display_name).toBeNull();
    expect(profile.onboarding_status).toBe("learner_pending");
  });

  it("does not create a duplicate profile row or duplicate consent rows on repeated submission (AC13)", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    completeParentOnboarding(user.id, validValue);
    completeParentOnboarding(user.id, validValue);

    const profileCount = (
      getDb().prepare("select count(*) as n from profiles where id = ?").get(user.id) as {
        n: number;
      }
    ).n;
    const consentCount = (
      getDb()
        .prepare("select count(*) as n from consent_records where parent_user_id = ?")
        .get(user.id) as { n: number }
    ).n;
    expect(profileCount).toBe(1);
    expect(consentCount).toBe(3);
  });

  it("does not regress onboarding_status once past profile_pending (later phone change)", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    completeParentOnboarding(user.id, validValue);

    // Simulate having moved further along (e.g. learner created).
    getDb()
      .prepare("update profiles set onboarding_status = 'complete' where id = ?")
      .run(user.id);

    const profile = completeParentOnboarding(user.id, {
      ...validValue,
      phoneE164: "+919876500000",
    });

    expect(profile.onboarding_status).toBe("complete");
    expect(profile.phone_e164).toBe("+919876500000");
  });

  it("audits onboarding and later phone changes without storing the phone number", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    completeParentOnboarding(user.id, validValue);
    completeParentOnboarding(user.id, { ...validValue, phoneE164: "+919876500000" });

    const events = getDb()
      .prepare(
        "select event_type, metadata from account_events where parent_user_id = ? and event_type = 'parent_profile_changed' order by created_at, rowid",
      )
      .all(user.id) as Array<{ event_type: string; metadata: string }>;

    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0].metadata)).toEqual({
      changedFields: ["displayName", "phone", "onboardingStatus"],
    });
    expect(JSON.parse(events[1].metadata)).toEqual({ changedFields: ["phone"] });
    expect(JSON.stringify(events)).not.toContain("+919876");
  });

  it("rolls back the profile update if the consent write fails (AC9/AT-IA-002-09)", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const before = getDb()
      .prepare("select onboarding_status, phone_e164 from profiles where id = ?")
      .get(user.id) as { onboarding_status: string; phone_e164: string | null };

    getDb().exec("drop table consent_records");

    expect(() => completeParentOnboarding(user.id, validValue)).toThrow();

    getDb().exec(`
      create table consent_records (
        id text primary key,
        parent_user_id text not null references profiles(id) on delete cascade,
        consent_type text not null check (consent_type in ('terms_of_service','privacy_policy')),
        policy_version text not null,
        granted integer not null default 1,
        granted_at text not null default (datetime('now')),
        revoked_at text,
        unique (parent_user_id, consent_type, policy_version)
      )
    `);

    const after = getDb()
      .prepare("select onboarding_status, phone_e164 from profiles where id = ?")
      .get(user.id) as { onboarding_status: string; phone_e164: string | null };
    expect(after.onboarding_status).toBe(before.onboarding_status);
    expect(after.phone_e164).toBe(before.phone_e164);
  });
});
