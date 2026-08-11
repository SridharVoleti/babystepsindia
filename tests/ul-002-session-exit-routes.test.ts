import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeProtectedAppApi: vi.fn(async () => ({
    grantId: "grant-1", learnerSessionId: "session-1", learnerId: "learner-1", appId: "app-1",
    principalId: "principal-1", scopes: [], principal: {},
  })),
  getSessionExitState: vi.fn(() => ({ sessionId: "session-1", sessionStatus: "active", sessionVersion: 4,
    hardExpiresAt: "2026-08-11T11:00:00.000Z", lastAcknowledgedProgressVersion: 2,
    allowedActions: ["resume_later", "finish_now"] })),
  markSessionResumable: vi.fn(() => ({ sessionId: "session-1", sessionStatus: "resumable", sessionVersion: 5,
    hardExpiresAt: "2026-08-11T11:00:00.000Z", lastAcknowledgedProgressVersion: 2,
    allowedActions: ["resume", "finish_now"] })),
  finishSessionIntentionally: vi.fn(() => ({ sessionId: "session-1", sessionStatus: "completed", sessionVersion: 5,
    hardExpiresAt: "2026-08-11T11:00:00.000Z", lastAcknowledgedProgressVersion: 2, allowedActions: [] })),
}));

vi.mock("@/lib/app-authorization/guard", () => ({ authorizeProtectedAppApi: mocks.authorizeProtectedAppApi }));
vi.mock("@/lib/session-exit/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-exit/service")>()),
  getSessionExitState: mocks.getSessionExitState,
  markSessionResumable: mocks.markSessionResumable,
  finishSessionIntentionally: mocks.finishSessionIntentionally,
}));

import { GET as getExitState } from "@/app/v1/internal/learner-sessions/[sessionId]/exit-state/route";
import { POST as postMarkResumable } from "@/app/v1/internal/learner-sessions/[sessionId]/mark-resumable/route";
import { POST as postFinish } from "@/app/v1/internal/learner-sessions/[sessionId]/finish/route";
import { createSessionExitAppShellSdk } from "@/lib/session-exit/app-shell-sdk";

function post(body: unknown) {
  return new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
}

beforeEach(() => vi.clearAllMocks());

describe("UL-002 API contracts", () => {
  it("API-UL-006 returns no-store authoritative exit state through session.exit dual proof", async () => {
    const response = await getExitState(new Request("http://localhost"), { params: { sessionId: "session-1" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.authorizeProtectedAppApi).toHaveBeenCalledWith(expect.any(Request), "session.exit");
    await expect(response.json()).resolves.toMatchObject({ sessionStatus: "active",
      allowedActions: ["resume_later", "finish_now"] });
  });

  it("API-UL-007 accepts only version, acknowledged progress and idempotency metadata", async () => {
    const body = { expectedSessionVersion: 4, lastAcknowledgedProgressVersion: 2, idempotencyKey: "exit-1" };
    const response = await postMarkResumable(post(body), { params: { sessionId: "session-1" } });
    expect(response.status).toBe(200);
    expect(mocks.markSessionResumable).toHaveBeenCalledWith(expect.objectContaining({ learnerSessionId: "session-1" }), body,
      expect.any(Date));

    const invalid = await postMarkResumable(post({ ...body, currentState: { answer: "secret" } }),
      { params: { sessionId: "session-1" } });
    expect(invalid.status).toBe(400);
  });

  it("API-UL-008 requires the fixed intentional_finish reason and no raw progress", async () => {
    const body = { expectedSessionVersion: 4, finalProgressVersion: 2,
      reason: "intentional_finish", idempotencyKey: "finish-1" };
    const response = await postFinish(post(body), { params: { sessionId: "session-1" } });
    expect(response.status).toBe(200);
    expect(mocks.authorizeProtectedAppApi).toHaveBeenLastCalledWith(expect.any(Request), "session.complete");
    expect(mocks.finishSessionIntentionally).toHaveBeenCalledWith(expect.objectContaining({ learnerSessionId: "session-1" }),
      body, expect.any(Date));

    const invalid = await postFinish(post({ ...body, reason: "voluntary_early_exit" }),
      { params: { sessionId: "session-1" } });
    expect(invalid.status).toBe(400);
  });

  it("the app-shell SDK sends metadata-only requests and advances its authoritative session version", async () => {
    const transport = vi.fn(async (request: { path: string }) => ({
      sessionId: "session-1", sessionStatus: request.path.endsWith("finish") ? "completed" : "resumable",
      sessionVersion: request.path.endsWith("finish") ? 6 : 5,
      hardExpiresAt: "2026-08-11T11:00:00.000Z", lastAcknowledgedProgressVersion: 2, allowedActions: [],
    }));
    const sdk = createSessionExitAppShellSdk({ sessionId: "session-1", initialSessionVersion: 4, transport });
    await sdk.markResumable({ acknowledgedProgressVersion: 2, idempotencyKey: "resume-1" });
    expect(transport.mock.calls[0][0]).toEqual({ method: "POST",
      path: "/v1/internal/learner-sessions/session-1/mark-resumable",
      body: { expectedSessionVersion: 4, lastAcknowledgedProgressVersion: 2, idempotencyKey: "resume-1" } });
    await sdk.finishSession({ acknowledgedProgressVersion: 2, idempotencyKey: "finish-1" });
    expect(transport.mock.calls[1][0]).toEqual({ method: "POST",
      path: "/v1/internal/learner-sessions/session-1/finish",
      body: { expectedSessionVersion: 5, finalProgressVersion: 2, reason: "intentional_finish", idempotencyKey: "finish-1" } });
    expect(JSON.stringify(transport.mock.calls)).not.toContain("currentState");
  });
});
