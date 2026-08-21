// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";

const auth = vi.hoisted(() => ({ parentId: "" }));
vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: vi.fn(async () => ({ ok: true, parent: {
    session: { sub: auth.parentId }, user: { email: "parent@example.com" }, authorization: {},
  } })),
}));

import { GET, POST } from "@/app/v1/learners/route";
import { GET as GET_CONTEXT } from "@/app/v1/learner-context/[learnerId]/route";

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
  auth.parentId = user.id;
  getDb().prepare("update profiles set onboarding_status='learner_pending' where id=?").run(user.id);
});

describe("LP-001 frozen collection API", () => {
  it("creates, replays, lists, and returns DOB-free minimal context", async () => {
    const body = { displayName: "Asha", dateOfBirth: "2018-02-10", idempotencyKey: crypto.randomUUID() };
    const first = await POST(new Request("http://test/v1/learners", { method: "POST", body: JSON.stringify(body) }));
    const replay = await POST(new Request("http://test/v1/learners", { method: "POST", body: JSON.stringify(body) }));
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const created = await first.json();
    expect((await replay.json()).learner.id).toBe(created.learner.id);

    const listed = await (await GET(new Request("http://test/v1/learners"))).json();
    expect(listed.learners).toHaveLength(1);
    expect(listed.learners[0]).not.toHaveProperty("ownerParentId");

    const contextResponse = await GET_CONTEXT(new Request("http://test"), { params: { learnerId: created.learner.id } });
    const context = await contextResponse.json();
    expect(context).not.toHaveProperty("dateOfBirth");
    expect(context).toMatchObject({ id: created.learner.id, displayName: "Asha", ageYears: expect.any(Number) });
  });

  it("rejects denied server-owned fields", async () => {
    const response = await POST(new Request("http://test/v1/learners", { method: "POST", body: JSON.stringify({
      displayName: "Asha", dateOfBirth: "2018-02-10", idempotencyKey: crypto.randomUUID(), ownerParentId: "attacker",
    }) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "UNEXPECTED_FIELD" });
  });
});
