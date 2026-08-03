import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { POLICY_VERSION, recordConsentAcceptance } from "@/lib/db/consent";

beforeEach(() => {
  useInMemoryDb();
});

describe("recordConsentAcceptance", () => {
  it("records the policy type, version, and timestamp for the user", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    recordConsentAcceptance(user.id, "terms");
    recordConsentAcceptance(user.id, "privacy");

    const rows = getDb()
      .prepare(
        "select policy_type, policy_version, accepted_at from consent_acceptances where user_id = ? order by policy_type",
      )
      .all(user.id) as { policy_type: string; policy_version: string; accepted_at: string }[];

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.policy_type)).toEqual(["privacy", "terms"]);
    expect(rows.every((r) => r.policy_version === POLICY_VERSION)).toBe(true);
    expect(rows.every((r) => !!r.accepted_at)).toBe(true);
  });
});
