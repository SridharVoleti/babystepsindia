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
  authorization: { mode: "learner_mode", learnerId: "learner-1" }, principal: { id: "principal-1" } };
const home = { learnerId: "learner-1", launcherVersion: "v1", activeSession: null, cards: [] };

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
    expect(mocks.composeLearnerHome).toHaveBeenCalledWith("learner-1", "production", expect.any(Date));
  });

  it("returns the composed home plus capability hints with a private no-store header", async () => {
    const response = await learnerHome(new Request("http://x/v1/learner-home"));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ learnerId: "learner-1", launcherVersion: "v1", capabilities: { policyVersion: "v1" } });
  });
});
