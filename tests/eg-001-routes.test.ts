import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeProtectedAppApi: vi.fn(),
  requireEndUserAuthorization: vi.fn(),
  createAchievement: vi.fn(),
  listAchievements: vi.fn(),
}));

vi.mock("@/lib/app-authorization/guard", () => ({
  authorizeProtectedAppApi: mocks.authorizeProtectedAppApi,
}));
vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/achievements/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/achievements/service")>(),
  createAchievement: mocks.createAchievement,
  listAchievements: mocks.listAchievements,
}));

import { POST as createRoute } from "@/app/v1/internal/learner-achievements/route";
import { GET as learnerFeedRoute } from "@/app/v1/learner-achievements/route";
import { GET as parentFeedRoute } from "@/app/v1/parent/learners/[learnerId]/achievements/route";

const appContext = { learnerId: "learner-1", appId: "app-1", releaseId: "release-1",
  learnerSessionId: "session-1", principalId: "principal-1" };
const learnerGuard = { ok: true, authorization: { learnerId: "learner-1", mode: "learner_mode" } };
const parentGuard = { ok: true, authorization: { mode: "parent_management" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeProtectedAppApi.mockResolvedValue(appContext);
  mocks.requireEndUserAuthorization.mockResolvedValue(learnerGuard);
  mocks.createAchievement.mockReturnValue({ created: true, achievement: { achievementId: "achievement-1" } });
  mocks.listAchievements.mockReturnValue({ achievements: [], nextCursor: null });
});

describe("EG-001 API authorization and scoping", () => {
  it("API-EG-001 requires the exact achievement.write app scope and returns 201 for a new record", async () => {
    const response = await createRoute(new Request("http://x/v1/internal/learner-achievements", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        achievementContractVersion: "1.0", appAchievementKey: "mastery", achievementInstanceKey: "mastery:1",
        title: "Mastery", category: "mastery", earnedAt: "2026-08-12T10:00:00Z",
        appAchievementModelVersion: "m1", sourceProgressVersion: 1, idempotencyKey: "idem-1",
      }),
    }));
    expect(mocks.authorizeProtectedAppApi).toHaveBeenCalledWith(expect.any(Request), "achievement.write");
    expect(mocks.createAchievement).toHaveBeenCalledWith(appContext, expect.objectContaining({
      achievementInstanceKey: "mastery:1",
    }), expect.any(Date));
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("API-EG-001 rejects undocumented input fields before persistence", async () => {
    const response = await createRoute(new Request("http://x/v1/internal/learner-achievements", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        achievementContractVersion: "1.0", appAchievementKey: "mastery", achievementInstanceKey: "mastery:1",
        title: "Mastery", category: "mastery", earnedAt: "2026-08-12T10:00:00Z",
        appAchievementModelVersion: "m1", sourceProgressVersion: 1, idempotencyKey: "idem-1", score: 999,
      }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.createAchievement).not.toHaveBeenCalled();
  });

  it("API-EG-003 derives the learner solely from the learner_mode guard", async () => {
    const response = await learnerFeedRoute(new Request(
      "http://x/v1/learner-achievements?learnerId=sibling&limit=20&category=mastery",
    ));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request), "learner.achievements.read");
    expect(mocks.listAchievements).toHaveBeenCalledWith(expect.objectContaining({
      learnerId: "learner-1", limit: 20, category: "mastery",
    }));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("API-EG-004 requires direct parent ownership before reading history", async () => {
    mocks.requireEndUserAuthorization.mockResolvedValue(parentGuard);
    await parentFeedRoute(new Request("http://x/v1/parent/learners/learner-2/achievements"),
      { params: { learnerId: "learner-2" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.learner.achievements.read", { learnerId: "learner-2" });
    expect(mocks.listAchievements).toHaveBeenCalledWith(expect.objectContaining({ learnerId: "learner-2" }));
  });

  it("passes authorization denials through without attempting a read", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await learnerFeedRoute(new Request("http://x/v1/learner-achievements"));
    expect(response).toBe(denied.response);
    expect(mocks.listAchievements).not.toHaveBeenCalled();
  });
});
