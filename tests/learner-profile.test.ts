import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import {
  LearnerCreationError,
  createLearner,
  listOwnedLearners,
} from "@/lib/db/learner-repo";
import {
  calculateAge,
  normalizeLearnerName,
  validateDateOfBirth,
} from "@/lib/learner-profile/validation";

beforeEach(() => useInMemoryDb());

async function parent(email: string) {
  const { user } = await sqliteAuthAdapter.signUp(email, "CorrectHorse1!");
  getDb()
    .prepare("update profiles set onboarding_status = 'learner_pending' where id = ?")
    .run(user.id);
  return user;
}

describe("LP-001 learner validation", () => {
  it("normalizes Unicode, capitalization, and whitespace while preserving display form", () => {
    expect(normalizeLearnerName("  ＡARAV\t  Rao  ")).toEqual({
      displayName: "AARAV Rao",
      normalizedDisplayName: "aarav rao",
    });
  });

  it("rejects blank, control-character, and over-50-character names", () => {
    expect(() => normalizeLearnerName(" \t ")).toThrowError("DISPLAY_NAME_REQUIRED");
    expect(() => normalizeLearnerName("Aarav\u0000")).toThrowError("DISPLAY_NAME_INVALID");
    expect(() => normalizeLearnerName("a".repeat(51))).toThrowError("DISPLAY_NAME_INVALID");
  });

  it("accepts adult DOBs but rejects impossible and future calendar dates", () => {
    expect(validateDateOfBirth("1940-01-01", "2026-08-04")).toBe("1940-01-01");
    expect(() => validateDateOfBirth("2025-02-29", "2026-08-04")).toThrowError(
      "DATE_OF_BIRTH_INVALID",
    );
    expect(() => validateDateOfBirth("2027-01-01", "2026-08-04")).toThrowError(
      "DATE_OF_BIRTH_FUTURE",
    );
  });

  it("derives complete years and remaining months, including leap-day DOBs", () => {
    expect(calculateAge("2020-02-29", "2026-02-28")).toEqual({ ageYears: 5, ageMonths: 11 });
    expect(calculateAge("2020-02-29", "2026-03-01")).toEqual({ ageYears: 6, ageMonths: 0 });
  });
});

describe("LP-001 transactional learner creation", () => {
  it("derives ownership, creates no billing data, and completes first-learner onboarding", async () => {
    const user = await parent("parent@example.com");

    const result = createLearner(user.id, {
      displayName: " Asha ",
      dateOfBirth: "1985-06-15",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }, "2026-08-04");

    expect(result.learner).toMatchObject({
      ownerParentId: user.id,
      displayName: "Asha",
      dateOfBirth: "1985-06-15",
      ageYears: 41,
      ageMonths: 1,
      ageAsOfDate: "2026-08-04",
      version: 1,
    });
    expect(result.onboardingStatus).toBe("complete");
    expect(listOwnedLearners(user.id, "2026-08-04")).toHaveLength(1);
    expect((getDb().prepare("select count(*) n from subscriptions").get() as { n: number }).n).toBe(0);
  });

  it("returns the original learner for the same idempotent request", async () => {
    const user = await parent("retry@example.com");
    const input = {
      displayName: "Aarav",
      dateOfBirth: "2018-04-03",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    };
    const first = createLearner(user.id, input, "2026-08-04");
    const retry = createLearner(user.id, input, "2026-08-05");

    expect(retry.learner.id).toBe(first.learner.id);
    expect(listOwnedLearners(user.id, "2026-08-05")).toHaveLength(1);
  });

  it("rejects conflicting idempotency reuse and normalized duplicates per parent", async () => {
    const user = await parent("conflict@example.com");
    createLearner(user.id, {
      displayName: "Aarav Rao",
      dateOfBirth: "2018-04-03",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    }, "2026-08-04");

    expect(() => createLearner(user.id, {
      displayName: "Different",
      dateOfBirth: "2018-04-03",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    }, "2026-08-04")).toThrowError(new LearnerCreationError("IDEMPOTENCY_KEY_REUSED"));

    expect(() => createLearner(user.id, {
      displayName: "  AARAV   RAO ",
      dateOfBirth: "2019-01-01",
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
    }, "2026-08-04")).toThrowError(new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS"));
  });

  it("allows the same normalized name for a different parent", async () => {
    const firstParent = await parent("one@example.com");
    const secondParent = await parent("two@example.com");
    createLearner(firstParent.id, { displayName: "Aarav", dateOfBirth: "2018-01-01", idempotencyKey: "55555555-5555-4555-8555-555555555555" }, "2026-08-04");
    expect(() => createLearner(secondParent.id, { displayName: "aarav", dateOfBirth: "1980-01-01", idempotencyKey: "66666666-6666-4666-8666-666666666666" }, "2026-08-04")).not.toThrow();
  });
});
