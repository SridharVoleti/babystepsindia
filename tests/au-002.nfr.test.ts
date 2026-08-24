// @vitest-environment node
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import {
  activateLearnerMode,
  AuthorizationModeError,
  authorizeEndUserAction,
  buildAuthorizedLearnerQueryScope,
  deriveAuthorizationContext,
  registerAuthorizationActions,
  revokeLearnerContextsByCredential,
} from "@/lib/authorization/modes";
import { recordTrustedPasskeyVerification } from "@/lib/authorization/passkey-verification";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { selectLearner } from "@/lib/learning-session/gateway";

const now = new Date("2026-08-05T10:00:00.000Z");

beforeEach(() => useInMemoryDb());

async function fixture() {
  const { user } = await sqliteAuthAdapter.signUp("nfr-parent@example.com", "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
  const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-05")).learner;
  await selectLearner("parent-session-1", user.id, learner.id, "2026-08-06T00:00:00.000Z");
  return { user, learner };
}

function percentile95(samples: number[]) {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
}

describe("AU-002 non-functional requirements", () => {
  it("keeps in-process authorization p95 below 50 ms", async () => {
    const { user } = await fixture();
    const context = { parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", mode: "parent_management" as const, modeGeneration: 0 };
    const samples: number[] = [];
    for (let index = 0; index < 500; index++) {
      const start = performance.now();
      await authorizeEndUserAction(context, "parent.account.read", { parentUserId: user.id });
      samples.push(performance.now() - start);
    }
    expect(percentile95(samples)).toBeLessThan(50);
  });

  it("keeps typical authoritative context derivation p95 below 250 ms", async () => {
    const { user } = await fixture();
    const samples: number[] = [];
    for (let index = 0; index < 200; index++) {
      const start = performance.now();
      const context = await deriveAuthorizationContext({ parentUserId: user.id,
        parentSessionId: "parent-session-1", deviceSessionId: "device-1", now });
      await authorizeEndUserAction(context, "parent.account.read", { parentUserId: user.id });
      samples.push(performance.now() - start);
    }
    expect(percentile95(samples)).toBeLessThan(250);
  });

  it("makes credential invalidation effective within five seconds", async () => {
    const { user, learner } = await fixture();
    const receipt = await recordTrustedPasskeyVerification({ parentUserId: user.id,
      parentSessionId: "parent-session-1", deviceSessionId: "device-1", learnerId: learner.id,
      credentialId: "credential-1", verifiedAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    await activateLearnerMode({ parentUserId: user.id, parentSessionId: "parent-session-1", deviceSessionId: "device-1",
      learnerId: learner.id, verificationReceiptId: receipt.id, expiresAt: new Date(now.getTime() + 3_600_000), now });
    const start = performance.now();
    await revokeLearnerContextsByCredential("credential-1", now);
    await expect(await deriveAuthorizationContext({ parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", now })).rejects.toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  it("rolls back receipt consumption and context activation when transition audit fails", async () => {
    const { user, learner } = await fixture();
    const receipt = await recordTrustedPasskeyVerification({ parentUserId: user.id,
      parentSessionId: "parent-session-1", deviceSessionId: "device-1", learnerId: learner.id,
      credentialId: "credential-1", verifiedAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    getDb().exec(`create trigger fail_learner_mode_audit before insert on account_events
      when new.event_type='learner_mode_activated' begin select raise(abort,'injected'); end`);
    await expect(await activateLearnerMode({ parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", learnerId: learner.id, verificationReceiptId: receipt.id,
      expiresAt: new Date(now.getTime() + 3_600_000), now })).rejects.toThrow();
    expect(getDb().prepare("select consumed_at from learner_mode_unlock_receipts where id=?").get(receipt.id))
      .toMatchObject({ consumed_at: null });
    expect(getDb().prepare("select count(*) n from learner_unlock_contexts").get()).toMatchObject({ n: 0 });
  });

  it("builds authoritative learner scope before pagination or counting", async () => {
    const { user } = await fixture();
    const context = await deriveAuthorizationContext({ parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", now });
    expect(await buildAuthorizedLearnerQueryScope(context, "parent.learners.list"))
      .toEqual({ where: "owner_parent_id = ?", params: [user.id] });
  });

  it("fails closed when session or device context is unavailable", async () => {
    const { user } = await fixture();
    await expect(await deriveAuthorizationContext({ parentUserId: user.id, now }))
      .rejects.toThrowError(new AuthorizationModeError("AUTHORIZATION_CONTEXT_UNAVAILABLE"));
  });

  it("increments an action version when its authorization contract changes", async () => {
    await fixture();
    await registerAuthorizationActions();
    getDb().prepare("update authorization_actions set required_mode='learner_mode' where action_key='parent.account.read'").run();
    await registerAuthorizationActions();
    expect(getDb().prepare("select required_mode,version from authorization_actions where action_key='parent.account.read'").get())
      .toMatchObject({ required_mode: "parent_management", version: 2 });
  });

  it("does not create permanent authorization history for successful reads", async () => {
    const { user } = await fixture();
    const context = await deriveAuthorizationContext({ parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", now });
    const before = (getDb().prepare("select count(*) n from account_events").get() as { n: number }).n;
    for (let index = 0; index < 500; index++) await authorizeEndUserAction(context, "parent.account.read");
    expect(getDb().prepare("select count(*) n from account_events").get()).toMatchObject({ n: before });
  });
});
