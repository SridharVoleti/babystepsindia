import { describe, expect, it } from "vitest";
import { validateLearnerUpdateBody } from "@/lib/learner-profile/update-validation";

describe("LP-002 strict update contract", () => {
  it("accepts only editable fields plus concurrency metadata", () => {
    expect(validateLearnerUpdateBody({
      displayName: "Aarav",
      avatarId: null,
      expectedVersion: 2,
      idempotencyKey: "20000000-0000-4000-8000-000000000001",
    })).toEqual({ ok: true, value: {
      displayName: "Aarav",
      avatarId: null,
      expectedVersion: 2,
      idempotencyKey: "20000000-0000-4000-8000-000000000001",
    }});
  });

  it.each(["ownerParentId", "learnerId", "status", "progress", "subscription"])(
    "rejects protected or unknown field %s",
    (field) => expect(validateLearnerUpdateBody({
      displayName: "Aarav", expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000001", [field]: "x",
    })).toEqual({ ok: false, code: "FORBIDDEN_FIELD" }),
  );

  it("requires an editable field, a positive version, and UUID idempotency key", () => {
    expect(validateLearnerUpdateBody({ expectedVersion: 1, idempotencyKey: "20000000-0000-4000-8000-000000000001" }))
      .toEqual({ ok: false, code: "NO_CHANGES_SUBMITTED" });
    expect(validateLearnerUpdateBody({ displayName: "A", expectedVersion: 0, idempotencyKey: "bad" }))
      .toEqual({ ok: false, code: "EXPECTED_VERSION_INVALID" });
    expect(validateLearnerUpdateBody({ displayName: "A", expectedVersion: 1, idempotencyKey: "bad" }))
      .toEqual({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" });
  });
});
