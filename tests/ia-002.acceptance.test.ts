// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relative: string) =>
  fs.readFileSync(path.join(process.cwd(), relative), "utf8");

const withoutComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*--.*$/gm, "");

function profilesDefinition(source: string): string {
  const match = source.match(/create table(?: if not exists)? profiles\s*\(([\s\S]*?)\n\);/i);
  expect(match, "profiles table definition must exist").not.toBeNull();
  return match![1];
}

describe("IA-002 acceptance reconciliation", () => {
  it("AT-IA-002-10 excludes parent date of birth, address, and legacy learner fields from profiles", () => {
    for (const file of ["src/lib/db/schema.sql", "supabase/migrations/0001_profiles.sql"]) {
      const profileColumns = profilesDefinition(readSource(file));
      expect(profileColumns, file).not.toMatch(
        /\b(?:date_of_birth|parent_date_of_birth|postal_address|class_level)\b/i,
      );
    }
  });

  it("AT-IA-002-05 has no SMS OTP flow or verified-phone persistence", () => {
    const implementation = [
      "src/app/v1/parent/profile/route.ts",
      "src/components/onboarding/parent-onboarding-form.tsx",
      "src/lib/db/parent-profile-repo.ts",
      "src/lib/db/schema.sql",
      "supabase/migrations/0009_ia002_parent_phone_consent.sql",
    ].map((file) => withoutComments(readSource(file))).join("\n");

    expect(implementation).not.toMatch(
      /\b(?:sendSms|sendOtp|verifyOtp|otp_code|otp_token|phone_verified|phone_verified_at)\b/i,
    );
  });

  it("routes Supabase profile writes through server validation instead of a browser update policy", () => {
    const baseline = withoutComments(readSource("supabase/migrations/0001_profiles.sql"));
    expect(baseline).not.toMatch(/on\s+profiles\s+for\s+update/i);
    expect(readSource("supabase/migrations/0037_ia002_remove_parent_learner_fields.sql"))
      .toContain('drop policy if exists "profiles are updatable by owner" on profiles');
  });
});
