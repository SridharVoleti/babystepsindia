import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeLearnerHome: vi.fn(),
  generateUiCapabilityHints: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/learner-home/service", () => ({ composeLearnerHome: mocks.composeLearnerHome }));
vi.mock("@/lib/authorization/ui-capabilities", () => ({ generateUiCapabilityHints: mocks.generateUiCapabilityHints }));

import { GET as learnerHome } from "@/app/v1/learner-home/route";

const guardOk = { ok: true, parent: { session: { sub: "parent-1" } },
  authorization: { mode: "learner_mode", learnerId: "learner-1", contextVersion: 7 }, principal: { id: "principal-1" } };
const home = { learnerId: "learner-1", launcherVersion: "v1", serverTime: "2026-08-11T00:00:00.000Z",
  composedAt: "2026-08-11T00:00:00.000Z", nextRecheckAt: null, cacheMaxAgeSeconds: 60,
  selectedLearnerContextVersion: 7, activeSession: null, cards: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
  mocks.composeLearnerHome.mockReturnValue(home);
  mocks.generateUiCapabilityHints.mockReturnValue({ policyVersion: "v1", policyDigest: "d1", actions: [], issuedAt: "now", expiresAt: "later" });
});

describe("GET /v1/learner-home", () => {
  it("passes through the guard's denial response unchanged when unauthorized", async () => {
    const denied = { ok: false, response: new Response(JSON.stringify({ error: "LEARNER_PROFILE_LOCKED" }), { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await learnerHome(new Request("http://x/v1/learner-home"));
    expect(response).toBe(denied.response);
    expect(mocks.composeLearnerHome).not.toHaveBeenCalled();
  });

  it("authorizes with the learner.home.read action and no resource scope (server-derives the learner itself)", async () => {
    await learnerHome(new Request("http://x/v1/learner-home"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "learner.home.read");
  });

  it("sources the learnerId only from the guard's authorization context, never the request", async () => {
    await learnerHome(new Request("http://x/v1/learner-home?learnerId=someone-elses-id"));
    expect(mocks.composeLearnerHome).toHaveBeenCalledWith("learner-1", "production", expect.any(Date), 7);
  });

  it("returns the composed home plus capability hints with a private conditional-cache header", async () => {
    const response = await learnerHome(new Request("http://x/v1/learner-home"));
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toBe('"v1.7"');
    const body = await response.json();
    expect(body).toMatchObject({ learnerId: "learner-1", launcherVersion: "v1", capabilities: { policyVersion: "v1" } });
  });

  it("returns 304 only for the exact current learner-context validator", async () => {
    const response = await learnerHome(new Request("http://x/v1/learner-home", {
      headers: { "If-None-Match": '"v1.7"', "X-Launcher-Refresh-Reason": "visibility_return" },
    }));
    expect(response.status).toBe(304);
    expect(response.headers.get("X-Launcher-Context-Version")).toBe("7");
    expect(response.headers.get("X-Launcher-Refresh-Reason")).toBe("visibility_return");
  });

  it("does not reuse an ETag from another learner-context generation", async () => {
    const response = await learnerHome(new Request("http://x/v1/learner-home", {
      headers: { "If-None-Match": '"v1.6"' },
    }));
    expect(response.status).toBe(200);
  });
});
