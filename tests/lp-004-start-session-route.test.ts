import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  withLockedEndUserMutation: vi.fn(),
  getPublishedDeployment: vi.fn(),
  startLearnerSession: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/authorization/locked-mutation", () => ({
  withLockedEndUserMutation: mocks.withLockedEndUserMutation,
}));
vi.mock("@/lib/deployment-production/service", () => ({
  getPublishedDeployment: mocks.getPublishedDeployment,
}));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/learning-session/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/learning-session/gateway")>()),
  startLearnerSession: mocks.startLearnerSession,
}));

import { POST } from "@/app/v1/learner-sessions/route";
import { LearnerSessionError } from "@/lib/learning-session/gateway";

const DEPLOYMENT = {
  deploymentId: "deployment-1", releaseId: "release-1", environment: "production",
  origin: "https://chess.example", launchPath: "/launch", compatibilityPassed: true, dispatchBlocked: false,
};

function post(body: unknown) {
  return new Request("http://x/v1/learner-sessions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue({
    ok: true,
    parent: { session: { sid: "parent-session-1", sub: "parent-1", did: "device-1" } },
    authorization: {
      parentUserId: "parent-1", parentSessionId: "parent-session-1", deviceSessionId: "device-1",
      mode: "learner_mode", learnerId: "learner-1", modeGeneration: 3,
    },
  });
  mocks.checkRateLimit.mockReturnValue(true);
  mocks.getPublishedDeployment.mockResolvedValue(DEPLOYMENT);
  mocks.withLockedEndUserMutation.mockImplementation(async (input: { mutate: () => unknown }) => input.mutate());
  mocks.startLearnerSession.mockResolvedValue({
    sessionId: "session-1", learnerId: "learner-1", appId: "chess-masters", status: "starting",
    source: "normal", sessionToken: "token", resumeCredential: "cred",
  });
});

describe("LP-004 POST /v1/learner-sessions", () => {
  it("creates a session and passes the resolved deployment + synthesized schedule authorization", async () => {
    const response = await POST(post({ appId: "chess-masters", idempotencyKey: "idem-1" }));

    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request), "learner.session.start");
    expect(mocks.getPublishedDeployment).toHaveBeenCalledWith("chess-masters", "production", expect.any(Date));
    expect(mocks.startLearnerSession).toHaveBeenCalledWith(expect.objectContaining({
      actorSessionId: "parent-session-1", parentUserId: "parent-1",
      selectedLearnerId: "learner-1", learnerId: "learner-1", appId: "chess-masters",
      deviceSessionId: "device-1", scheduleAuthorized: true,
      scheduleAuthorizationId: "launcher:learner-1:chess-masters",
      idempotencyKey: "idem-1", fundingSource: undefined, creditId: undefined, deployment: DEPLOYMENT,
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ sessionId: "session-1", status: "starting" });
  });

  it("forwards a technical-credit start with its credit id", async () => {
    await POST(post({ appId: "chess-masters", idempotencyKey: "idem-2",
      fundingSource: "technical_credit", creditId: "credit-9" }));
    expect(mocks.startLearnerSession).toHaveBeenCalledWith(expect.objectContaining({
      fundingSource: "technical_credit", creditId: "credit-9",
    }));
  });

  it("401s without a parent session id", async () => {
    mocks.requireEndUserAuthorization.mockResolvedValue({
      ok: true, parent: { session: { sid: null, sub: "parent-1", did: "device-1" } },
      authorization: { learnerId: "learner-1", deviceSessionId: "device-1" },
    });
    expect((await POST(post({ appId: "chess-masters", idempotencyKey: "x" }))).status).toBe(401);
  });

  it("403s when learner mode is not active", async () => {
    mocks.requireEndUserAuthorization.mockResolvedValue({
      ok: true, parent: { session: { sid: "s", sub: "p", did: "d" } },
      authorization: { mode: "parent_management", deviceSessionId: "d" },
    });
    expect((await POST(post({ appId: "chess-masters", idempotencyKey: "x" }))).status).toBe(403);
  });

  it("409s when the app has no published production deployment", async () => {
    mocks.getPublishedDeployment.mockResolvedValue(null);
    const response = await POST(post({ appId: "chess-masters", idempotencyKey: "x" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "APP_NOT_PUBLISHED" });
    expect(mocks.startLearnerSession).not.toHaveBeenCalled();
  });

  it.each([
    { appId: "chess-masters" },
    { appId: "chess-masters", idempotencyKey: "x", surprise: 1 },
    { appId: "", idempotencyKey: "x" },
    { appId: "chess-masters", idempotencyKey: "x", fundingSource: "bogus" },
    { appId: "chess-masters", idempotencyKey: "x", fundingSource: "technical_credit" },
    { appId: "chess-masters", idempotencyKey: "x", creditId: "c" },
  ])("400s on invalid body %j", async (body) => {
    expect((await POST(post(body))).status).toBe(400);
  });

  it("maps a gateway LearnerSessionError through lifecycleError", async () => {
    mocks.startLearnerSession.mockRejectedValue(new LearnerSessionError("WEEKLY_SESSION_LIMIT_REACHED"));
    const response = await POST(post({ appId: "chess-masters", idempotencyKey: "x" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "WEEKLY_SESSION_LIMIT_REACHED" });
  });

  it("429s when rate limited", async () => {
    mocks.checkRateLimit.mockReturnValue(false);
    expect((await POST(post({ appId: "chess-masters", idempotencyKey: "x" }))).status).toBe(429);
  });
});
