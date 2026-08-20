import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { POLICY_VERSION, hasCurrentConsent, recordConsent } from "@/lib/db/consent";

beforeEach(() => {
  useInMemoryDb();
});

describe("recordConsent", () => {
  it("records the consent type, version, and timestamp for the user", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    await recordConsent(user.id, "terms_of_service");
    await recordConsent(user.id, "privacy_policy");

    const rows = getDb()
      .prepare(
        "select consent_type, policy_version, granted, granted_at from consent_records where parent_user_id = ? order by consent_type",
      )
      .all(user.id) as {
      consent_type: string;
      policy_version: string;
      granted: number;
      granted_at: string;
    }[];

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.consent_type)).toEqual(["privacy_policy", "terms_of_service"]);
    expect(rows.every((r) => r.policy_version === POLICY_VERSION)).toBe(true);
    expect(rows.every((r) => r.granted === 1)).toBe(true);
    expect(rows.every((r) => !!r.granted_at)).toBe(true);
  });

  it("is idempotent for the same user/type/version — no duplicate rows (AC13/AT-IA-002-08)", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    await recordConsent(user.id, "terms_of_service");
    await recordConsent(user.id, "terms_of_service");
    await recordConsent(user.id, "terms_of_service");

    const count = (
      getDb()
        .prepare(
          "select count(*) as n from consent_records where parent_user_id = ? and consent_type = ?",
        )
        .get(user.id, "terms_of_service") as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("preserves the original acceptance timestamp on an already-granted duplicate", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    await recordConsent(user.id, "terms_of_service");
    getDb()
      .prepare(
        "update consent_records set granted_at = '2026-01-02 03:04:05' where parent_user_id = ? and consent_type = 'terms_of_service'",
      )
      .run(user.id);

    await recordConsent(user.id, "terms_of_service");

    const row = getDb()
      .prepare(
        "select granted_at from consent_records where parent_user_id = ? and consent_type = 'terms_of_service'",
      )
      .get(user.id) as { granted_at: string };
    expect(row.granted_at).toBe("2026-01-02 03:04:05");
  });

  it("allows a different policy version to be recorded as a separate row", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    await recordConsent(user.id, "terms_of_service", "1.0");
    await recordConsent(user.id, "terms_of_service", "2.0");

    const count = (
      getDb()
        .prepare(
          "select count(*) as n from consent_records where parent_user_id = ? and consent_type = ?",
        )
        .get(user.id, "terms_of_service") as { n: number }
    ).n;
    expect(count).toBe(2);
  });
});

describe("hasCurrentConsent", () => {
  it("is false before consent is recorded and true after", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    expect(await hasCurrentConsent(user.id, "terms_of_service")).toBe(false);
    await recordConsent(user.id, "terms_of_service");
    expect(await hasCurrentConsent(user.id, "terms_of_service")).toBe(true);
  });

  it("is false for a policy version that hasn't been accepted", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    await recordConsent(user.id, "terms_of_service", "1.0");
    expect(await hasCurrentConsent(user.id, "terms_of_service", "2.0")).toBe(false);
  });
});
