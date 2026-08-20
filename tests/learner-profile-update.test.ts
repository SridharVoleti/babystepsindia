import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import {
  LearnerCreationError,
  createLearner,
  getOwnedLearner,
  updateLearner,
} from "@/lib/db/learner-repo";

beforeEach(() => useInMemoryDb());

async function setup(email = "parent@example.com") {
  const { user } = await sqliteAuthAdapter.signUp(email, "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='learner_pending' where id=?").run(user.id);
  const created = await createLearner(user.id, {
    displayName: "AARAV",
    dateOfBirth: "2018-04-03",
    idempotencyKey: "10000000-0000-4000-8000-000000000001",
  }, "2026-08-04");
  return { user, learner: created.learner };
}

describe("LP-002 learner profile correction", () => {
  it("corrects a name without changing permanent identity and increments version once", async () => {
    const { user, learner } = await setup();
    const result = await updateLearner(user.id, learner.id, {
      displayName: "Aarav Rao",
      expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000001",
    }, "2026-08-04");

    expect(result).toMatchObject({
      changedFields: ["displayName"],
      noOp: false,
      learner: { id: learner.id, ownerParentId: user.id, displayName: "Aarav Rao", version: 2 },
    });
  });

  it("allows capitalization-only correction but treats cleaned equality as a no-op", async () => {
    const { user, learner } = await setup();
    const changed = await updateLearner(user.id, learner.id, {
      displayName: "Aarav",
      expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000002",
    }, "2026-08-04");
    expect(changed.learner.version).toBe(2);

    const eventCount = () => (getDb().prepare(
      "select count(*) n from account_events where event_type='learner_profile_changed'",
    ).get() as { n: number }).n;
    const before = eventCount();
    const noOp = await updateLearner(user.id, learner.id, {
      displayName: "  Aarav  ",
      expectedVersion: 2,
      idempotencyKey: "20000000-0000-4000-8000-000000000003",
    }, "2026-08-04");
    expect(noOp).toMatchObject({ noOp: true, changedFields: [], learner: { version: 2 } });
    expect(eventCount()).toBe(before);
  });

  it("rejects a stale version and leaves the learner unchanged", async () => {
    const { user, learner } = await setup();
    await updateLearner(user.id, learner.id, {
      dateOfBirth: "1980-01-01",
      expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000004",
    }, "2026-08-04");

    await expect(updateLearner(user.id, learner.id, {
      displayName: "Stale overwrite",
      expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000005",
    }, "2026-08-04")).rejects.toThrowError(new LearnerCreationError("LEARNER_VERSION_CONFLICT"));
    expect((await getOwnedLearner(user.id, learner.id, "2026-08-04")).displayName).toBe("AARAV");
  });

  it("replays an identical completed update and rejects conflicting key reuse", async () => {
    const { user, learner } = await setup();
    const input = {
      dateOfBirth: "1980-01-01",
      expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000006",
    };
    const first = await updateLearner(user.id, learner.id, input, "2026-08-04");
    const replay = await updateLearner(user.id, learner.id, input, "2026-08-05");
    expect(replay).toEqual(first);

    await expect(updateLearner(user.id, learner.id, {
      displayName: "Different",
      expectedVersion: 2,
      idempotencyKey: input.idempotencyKey,
    }, "2026-08-05")).rejects.toThrowError(new LearnerCreationError("IDEMPOTENCY_KEY_REUSED"));
  });

  it("changes and removes approved avatars while rejecting unavailable avatars", async () => {
    const { user, learner } = await setup();
    getDb().prepare("insert into approved_avatars(id,label,active) values ('fox','Fox',1),('old','Old',0)").run();
    const changed = await updateLearner(user.id, learner.id, {
      avatarId: "fox", expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000007",
    }, "2026-08-04");
    expect(changed.learner.avatarId).toBe("fox");
    const removed = await updateLearner(user.id, learner.id, {
      avatarId: null, expectedVersion: 2,
      idempotencyKey: "20000000-0000-4000-8000-000000000008",
    }, "2026-08-04");
    expect(removed.learner.avatarId).toBeNull();
    await expect(updateLearner(user.id, learner.id, {
      avatarId: "old", expectedVersion: 3,
      idempotencyKey: "20000000-0000-4000-8000-000000000009",
    }, "2026-08-04")).rejects.toThrowError(new LearnerCreationError("AVATAR_NOT_AVAILABLE"));
  });

  it("hides learner existence from unrelated parents and denies inactive owners first", async () => {
    const { user, learner } = await setup();
    const { user: other } = await sqliteAuthAdapter.signUp("other@example.com", "CorrectHorse1!");
    await expect(getOwnedLearner(other.id, learner.id, "2026-08-04")).rejects.toThrowError(
      new LearnerCreationError("LEARNER_NOT_FOUND"),
    );
    getDb().prepare("update profiles set account_status='deleted' where id=?").run(user.id);
    await expect(getOwnedLearner(user.id, learner.id, "2026-08-04")).rejects.toThrowError(
      new LearnerCreationError("ACCOUNT_DELETED"),
    );
  });

  it("writes one safe audit event without raw name or DOB values", async () => {
    const { user, learner } = await setup();
    await updateLearner(user.id, learner.id, {
      displayName: "Private Name", dateOfBirth: "1975-02-03", expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000010",
    }, "2026-08-04");
    const event = getDb().prepare(
      "select metadata from account_events where event_type='learner_profile_changed'",
    ).get() as { metadata: string };
    expect(JSON.parse(event.metadata)).toEqual({
      learnerId: learner.id,
      changedFields: ["displayName", "dateOfBirth"],
      previousVersion: 1,
      newVersion: 2,
    });
    expect(event.metadata).not.toContain("Private Name");
    expect(event.metadata).not.toContain("1975-02-03");
  });

  it("rejects another owned learner's normalized name without mutation", async () => {
    const { user, learner } = await setup();
    await createLearner(user.id, {
      displayName: "Mira", dateOfBirth: "2019-01-01",
      idempotencyKey: "10000000-0000-4000-8000-000000000002",
    }, "2026-08-04");
    await expect(updateLearner(user.id, learner.id, {
      displayName: "  MIRA ", expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000011",
    }, "2026-08-04")).rejects.toThrowError(new LearnerCreationError("LEARNER_NAME_ALREADY_EXISTS"));
    expect(await getOwnedLearner(user.id, learner.id, "2026-08-04")).toMatchObject({
      displayName: "AARAV", version: 1,
    });
  });

  it("rolls back learner, version, idempotency, and event state when audit insertion fails", async () => {
    const { user, learner } = await setup();
    getDb().exec("drop table account_events");
    await expect(updateLearner(user.id, learner.id, {
      displayName: "Should Roll Back", expectedVersion: 1,
      idempotencyKey: "20000000-0000-4000-8000-000000000012",
    }, "2026-08-04")).rejects.toThrow();
    const row = getDb().prepare("select display_name, version from learners where id=?").get(learner.id) as {
      display_name: string; version: number;
    };
    expect(row).toEqual({ display_name: "AARAV", version: 1 });
    expect((getDb().prepare("select count(*) n from learner_profile_update_requests").get() as { n: number }).n)
      .toBe(0);
  });
});
