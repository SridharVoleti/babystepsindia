// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateLearnerMode, AuthorizationModeError } from "@/lib/authorization/modes";
import {
  recordTrustedPasskeyVerification,
} from "@/lib/authorization/passkey-verification";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { selectLearner } from "@/lib/learning-session/gateway";

const now = new Date("2026-08-05T10:00:00.000Z");

beforeEach(() => useInMemoryDb());

async function fixture() {
  const { user } = await sqliteAuthAdapter.signUp("receipt-parent@example.com", "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
  const learner = (await createLearner(user.id, {
    displayName: "Asha",
    dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID(),
  }, "2026-08-05")).learner;
  selectLearner("parent-session-1", user.id, learner.id, "2026-08-06T00:00:00.000Z");
  return { user, learner };
}

describe("AU-002 trusted passkey verification receipts", () => {
  it("AT-AU-002-04 activates only from an exact, unexpired server verification receipt", async () => {
    const { user, learner } = await fixture();
    const receipt = recordTrustedPasskeyVerification({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      credentialId: "credential-1",
      verifiedAt: now,
      expiresAt: new Date("2026-08-05T10:01:00.000Z"),
    });

    expect(await activateLearnerMode({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      verificationReceiptId: receipt.id,
      expiresAt: new Date("2026-08-05T11:00:00.000Z"),
      now,
    })).toMatchObject({ mode: "learner_mode", learnerId: learner.id, credentialId: "credential-1" });
  });

  it("AT-AU-002-04 rejects receipt replay and mismatched device authority", async () => {
    const { user, learner } = await fixture();
    const receipt = recordTrustedPasskeyVerification({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      credentialId: "credential-1",
      verifiedAt: now,
      expiresAt: new Date("2026-08-05T10:01:00.000Z"),
    });
    const input = {
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      verificationReceiptId: receipt.id,
      expiresAt: new Date("2026-08-05T11:00:00.000Z"),
      now,
    };

    await expect(activateLearnerMode({ ...input, deviceSessionId: "forged-device" }))
      .rejects.toThrowError(new AuthorizationModeError("LEARNER_PROFILE_LOCKED"));
    await activateLearnerMode(input);
    await expect(activateLearnerMode(input))
      .rejects.toThrowError(new AuthorizationModeError("LEARNER_PROFILE_LOCKED"));
  });

  it("AT-AU-002-02 rejects an already-expired learner context before consuming passkey evidence", async () => {
    const { user, learner } = await fixture();
    const receipt = recordTrustedPasskeyVerification({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      credentialId: "credential-1",
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(activateLearnerMode({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      verificationReceiptId: receipt.id,
      expiresAt: new Date(now.getTime() - 1),
      now,
    })).rejects.toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));

    expect(getDb().prepare(
      "select consumed_at from learner_mode_unlock_receipts where id=?",
    ).get(receipt.id)).toMatchObject({ consumed_at: null });
    expect(getDb().prepare("select count(*) n from learner_unlock_contexts").get())
      .toMatchObject({ n: 0 });
  });
});
