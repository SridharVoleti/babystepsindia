// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { enterLearnerModeDirectly, AuthorizationModeError } from "@/lib/authorization/modes";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { selectLearner } from "@/lib/learning-session/gateway";

const now = new Date("2026-09-14T10:00:00.000Z");

beforeEach(() => useInMemoryDb());

async function fixture() {
  const { user } = await sqliteAuthAdapter.signUp("direct-enter-parent@example.com", "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
  const learner = (await createLearner(user.id, {
    displayName: "Asha",
    dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID(),
  }, "2026-09-14")).learner;
  await selectLearner("parent-session-1", user.id, learner.id, "2026-09-15T00:00:00.000Z");
  return { user, learner };
}

describe("learner mode direct entry (no passkey required)", () => {
  it("activates learner mode for an owned, selected learner with no passkey involved", async () => {
    const { user, learner } = await fixture();
    const context = await enterLearnerModeDirectly({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      expiresAt: new Date("2026-09-14T11:00:00.000Z"),
      now,
    });
    expect(context).toMatchObject({ mode: "learner_mode", learnerId: learner.id });
  });

  it("rejects a learner the parent does not own", async () => {
    const { user } = await fixture();
    const { user: otherParent } = await sqliteAuthAdapter.signUp("other-parent@example.com", "CorrectHorse1!");
    const otherLearner = (await createLearner(otherParent.id, {
      displayName: "Ravi",
      dateOfBirth: "2019-01-01",
      idempotencyKey: crypto.randomUUID(),
    }, "2026-09-14")).learner;

    await expect(enterLearnerModeDirectly({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: otherLearner.id,
      expiresAt: new Date("2026-09-14T11:00:00.000Z"),
      now,
    })).rejects.toThrowError(new AuthorizationModeError("RESOURCE_NOT_FOUND"));
  });

  it("still fails closed without a live learner_selection_contexts row", async () => {
    const { user } = await sqliteAuthAdapter.signUp("no-selection-parent@example.com", "CorrectHorse1!");
    getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
    const learner = (await createLearner(user.id, {
      displayName: "Kiran",
      dateOfBirth: "2018-06-01",
      idempotencyKey: crypto.randomUUID(),
    }, "2026-09-14")).learner;

    await expect(enterLearnerModeDirectly({
      parentUserId: user.id,
      parentSessionId: "parent-session-1",
      deviceSessionId: "device-1",
      learnerId: learner.id,
      expiresAt: new Date("2026-09-14T11:00:00.000Z"),
      now,
    })).rejects.toThrowError(new AuthorizationModeError("RESOURCE_NOT_FOUND"));
  });
});
