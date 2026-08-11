import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  listPastApps: vi.fn(),
  resolveSubscribeAgainContinuation: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/learner-home/past-apps", () => ({
  listPastApps: mocks.listPastApps,
  LearnerHomeError: class LearnerHomeError extends Error { constructor(public code: string) { super(code); } },
}));
vi.mock("@/lib/learner-home/subscribe-again", () => ({ resolveSubscribeAgainContinuation: mocks.resolveSubscribeAgainContinuation }));

import { GET as pastApps } from "@/app/v1/parent/learners/[learnerId]/past-apps/route";
import { POST as subscribeAgain } from "@/app/v1/parent/learners/[learnerId]/past-apps/[appId]/subscribe-again/route";
import { LearnerHomeError } from "@/lib/learner-home/past-apps";

const guardOk = { ok: true, parent: { session: { sub: "parent-1", sid: "session-1", did: "device-1" } },
  authorization: { mode: "parent_management" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
});

describe("GET /v1/parent/learners/[learnerId]/past-apps", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await pastApps(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response).toBe(denied.response);
  });

  it("authorizes with the learner-scoped resource and returns the composed list", async () => {
    mocks.listPastApps.mockReturnValue([{ appId: "app-1" }]);
    const response = await pastApps(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.learner.past_apps.read", { learnerId: "learner-1" });
    expect(mocks.listPastApps).toHaveBeenCalledWith("parent-1", "learner-1", expect.any(Date));
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toMatch(/^"[a-f0-9]{32}"$/);
    const body = await response.json();
    expect(body).toMatchObject({ learnerId: "learner-1", pastApps: [{ appId: "app-1" }] });
    expect(body.version).toMatch(/^[a-f0-9]{32}$/);
  });

  it("maps a RESOURCE_NOT_FOUND service error to 404", async () => {
    mocks.listPastApps.mockImplementation(() => { throw new LearnerHomeError("RESOURCE_NOT_FOUND"); });
    const response = await pastApps(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response.status).toBe(404);
  });
});

describe("POST /v1/parent/learners/[learnerId]/past-apps/[appId]/subscribe-again", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await subscribeAgain(new Request("http://x", { method: "POST" }), { params: { learnerId: "learner-1", appId: "app-1" } });
    expect(response).toBe(denied.response);
  });

  it("authorizes with the sensitive subscribe-again action and returns the continuation payload", async () => {
    mocks.resolveSubscribeAgainContinuation.mockReturnValue({ eligible: true, productId: "p-1" });
    const response = await subscribeAgain(new Request("http://x", { method: "POST" }), { params: { learnerId: "learner-1", appId: "app-1" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.learner.subscribe_again.create", { learnerId: "learner-1" });
    expect(mocks.resolveSubscribeAgainContinuation).toHaveBeenCalledWith("parent-1", "learner-1", "app-1", expect.any(Date));
    const body = await response.json();
    expect(body).toEqual({ eligible: true, productId: "p-1" });
  });
});
