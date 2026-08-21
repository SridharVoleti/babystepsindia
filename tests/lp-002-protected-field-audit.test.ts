// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { createLearner } from "@/lib/db/learner-repo";
import { useInMemoryDb } from "@/lib/db/test-utils";

const auth = vi.hoisted(() => ({ parentId: "" }));
vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: vi.fn(async () => ({ ok: true, parent: {
    session: { sub: auth.parentId }, user: { email: "parent@example.com" }, authorization: {},
  } })),
}));

import { PATCH } from "@/app/v1/learners/[learnerId]/route";

describe("LP-002 protected-field rejection audit", () => {
  let learnerId: string;
  beforeEach(async () => {
    useInMemoryDb();
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    auth.parentId = user.id;
    learnerId = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-02-10",
      idempotencyKey: crypto.randomUUID() }, "2026-08-21").learner.id;
  });

  const protectedFields = [
    ["id", "identity"], ["learnerId", "identity"],
    ["ownerParentId", "ownership"], ["owner_parent_id", "ownership"],
    ["createdAt", "creation"], ["created_at", "creation"], ["version", "version"],
    ["progress", "educational_state"], ["subscription", "commercial_state"],
    ["entitlement", "commercial_state"], ["session", "session_state"], ["cadence", "cadence_state"],
  ] as const;

  it.each(protectedFields)("rejects and safely audits the %s category", async (field, category) => {
    const before = getDb().prepare("select * from learners where id=?").get(learnerId);
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({
      displayName: "Changed", expectedVersion: 1, idempotencyKey: crypto.randomUUID(), [field]: "raw-sensitive-attempt",
    }) }), { params: { learnerId } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "FORBIDDEN_FIELD" });
    expect(getDb().prepare("select * from learners where id=?").get(learnerId)).toEqual(before);
    expect(getDb().prepare("select count(*) n from account_events where event_type='learner_profile_changed'").get()).toMatchObject({ n: 0 });
    const event = getDb().prepare("select parent_user_id,metadata from account_events where event_type='learner_profile_mutation_rejected'").get() as
      { parent_user_id: string; metadata: string };
    expect(event.parent_user_id).toBe(auth.parentId);
    expect(JSON.parse(event.metadata)).toEqual({ learnerId, action: "parent.learner.manage", outcome: "rejected",
      errorCode: "FORBIDDEN_FIELD", protectedFieldCategory: category });
    expect(event.metadata).not.toContain("raw-sensitive-attempt");
  });

  it("still rejects when audit persistence fails", async () => {
    getDb().exec(`create trigger fail_rejection_audit before insert on account_events
      when new.event_type='learner_profile_mutation_rejected' begin select raise(abort,'audit unavailable'); end`);
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({
      displayName: "Changed", expectedVersion: 1, idempotencyKey: crypto.randomUUID(), ownerParentId: "secret",
    }) }), { params: { learnerId } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "FORBIDDEN_FIELD" });
    expect(getDb().prepare("select display_name,version from learners where id=?").get(learnerId))
      .toMatchObject({ display_name: "Asha", version: 1 });
  });

  it("gives a foreign parent the same response for real and unknown learner references", async () => {
    const { user: foreign } = await sqliteAuthAdapter.signUp("foreign@example.com", "CorrectHorse1!");
    auth.parentId = foreign.id;
    const request = (target: string) => PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({
      displayName: "Changed", expectedVersion: 1, idempotencyKey: crypto.randomUUID(), progress: "secret",
    }) }), { params: { learnerId: target } });
    const real = await request(learnerId);
    const unknown = await request(crypto.randomUUID());
    expect([real.status, unknown.status]).toEqual([400, 400]);
    expect(await real.json()).toEqual(await unknown.json());
    expect(getDb().prepare("select display_name,version from learners where id=?").get(learnerId))
      .toMatchObject({ display_name: "Asha", version: 1 });
  });
});
