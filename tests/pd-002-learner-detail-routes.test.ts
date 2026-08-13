import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentLearnerDetail: vi.fn(),
  composeParentAppDetail: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/parent-learner-detail/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parent-learner-detail/service")>("@/lib/parent-learner-detail/service");
  return { ...actual, composeParentLearnerDetail: mocks.composeParentLearnerDetail, composeParentAppDetail: mocks.composeParentAppDetail };
});

import { GET as learnerDetail } from "@/app/v1/parent/learners/[learnerId]/route";
import { GET as appDetail } from "@/app/v1/parent/learners/[learnerId]/apps/[appId]/route";
import { ParentLearnerDetailError } from "@/lib/parent-learner-detail/service";

const guardOk = { ok: true, parent: { session: { sub: "parent-1", sid: "session-1", did: "device-1" } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
});

describe("GET /v1/parent/learners/[learnerId]", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await learnerDetail(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response).toBe(denied.response);
  });

  it("authorizes with the learner-scoped resource and returns the composed detail", async () => {
    mocks.composeParentLearnerDetail.mockReturnValue({ learnerId: "learner-1", displayName: "Asha", current: [], past: [] });
    const response = await learnerDetail(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.learner.detail.read", { learnerId: "learner-1" });
    expect(mocks.composeParentLearnerDetail).toHaveBeenCalledWith("parent-1", "learner-1", expect.any(Date));
    const body = await response.json();
    expect(body).toMatchObject({ learnerId: "learner-1" });
  });

  it("maps RESOURCE_NOT_FOUND to 404", async () => {
    mocks.composeParentLearnerDetail.mockImplementation(() => { throw new ParentLearnerDetailError("RESOURCE_NOT_FOUND"); });
    const response = await learnerDetail(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response.status).toBe(404);
  });
});

describe("GET /v1/parent/learners/[learnerId]/apps/[appId]", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await appDetail(new Request("http://x"), { params: { learnerId: "learner-1", appId: "app-1" } });
    expect(response).toBe(denied.response);
  });

  it("returns the composed single-app detail", async () => {
    mocks.composeParentAppDetail.mockReturnValue({ appId: "app-1", appName: "App", scope: "current",
      current: {}, past: null, recentAchievements: [], journeyHref: "/x", attention: [] });
    const response = await appDetail(new Request("http://x"), { params: { learnerId: "learner-1", appId: "app-1" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.learner.app_detail.read", { learnerId: "learner-1" });
    expect(mocks.composeParentAppDetail).toHaveBeenCalledWith("parent-1", "learner-1", "app-1", expect.any(Date));
    const body = await response.json();
    expect(body).toMatchObject({ appId: "app-1", scope: "current" });
  });

  it("maps RESOURCE_NOT_FOUND to 404", async () => {
    mocks.composeParentAppDetail.mockImplementation(() => { throw new ParentLearnerDetailError("RESOURCE_NOT_FOUND"); });
    const response = await appDetail(new Request("http://x"), { params: { learnerId: "learner-1", appId: "app-1" } });
    expect(response.status).toBe(404);
  });
});
