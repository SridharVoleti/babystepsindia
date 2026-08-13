import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    requireInternalService: vi.fn(async () => ({ ok: true, principal: { id: "session-domain" } })),
    readCadenceCompletionContext: vi.fn(() => ({ eligible: true, weeklyKey: "2026-W33" })),
    authorizeProtectedAppApi: vi.fn(async () => ({ grantId: "grant", principalId: "principal",
      learnerSessionId: "session-2", learnerId: "learner", appId: "app-math" })),
    finalizeLearnerSession: vi.fn(() => { order.push("finalized"); return { sessionId: "session-2", status: "completed" }; }),
    finishSessionIntentionally: vi.fn(() => { order.push("finalized"); return { sessionId: "session-2", sessionStatus: "completed" }; }),
    composeCadenceCelebrationAfterCommit: vi.fn((_auth: unknown, _key: string, result: object) => {
      order.push("composed"); return { ...result, cadenceCelebrationContext: { eligible: true } };
    }),
  };
});

vi.mock("@/lib/auth/internal-service-guard", () => ({ requireInternalService: mocks.requireInternalService }));
vi.mock("@/lib/app-authorization/guard", () => ({ authorizeProtectedAppApi: mocks.authorizeProtectedAppApi }));
vi.mock("@/lib/cadence-celebration/service", () => ({
  readCadenceCompletionContext: mocks.readCadenceCompletionContext,
  composeCadenceCelebrationAfterCommit: mocks.composeCadenceCelebrationAfterCommit,
}));
vi.mock("@/lib/session-finalization/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-finalization/service")>()),
  finalizeLearnerSession: mocks.finalizeLearnerSession,
}));
vi.mock("@/lib/session-exit/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-exit/service")>()),
  finishSessionIntentionally: mocks.finishSessionIntentionally,
}));

import { GET as getContext } from "@/app/v1/internal/learner-consistency/[appId]/cadence-completion-context/route";
import { POST as completeSession } from "@/app/v1/internal/learner-sessions/[sessionId]/complete/route";
import { POST as finishSession } from "@/app/v1/internal/learner-sessions/[sessionId]/finish/route";

function post(body: unknown) {
  return new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
}

beforeEach(() => { vi.clearAllMocks(); mocks.order.length = 0; });

describe("EG-003 API-EG-013/014 routes", () => {
  it("serves the server-derived context through the exact session-domain role with no-store", async () => {
    const request = new Request("http://localhost/v1/internal/learner-consistency/app-math/cadence-completion-context?sessionId=session-2");
    const response = await getContext(request, { params: { appId: "app-math" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.requireInternalService).toHaveBeenCalledWith(request, "consistency-session-domain");
    expect(mocks.readCadenceCompletionContext).toHaveBeenCalledWith("app-math", "session-2");
    await expect(response.json()).resolves.toMatchObject({ eligible: true, weeklyKey: "2026-W33" });
  });

  it("rejects missing, repeated, or client-extended context queries", async () => {
    for (const query of ["", "?sessionId=a&sessionId=b", "?sessionId=a&learnerId=learner"]) {
      const response = await getContext(new Request(`http://localhost/context${query}`), { params: { appId: "app-math" } });
      expect(response.status).toBe(400);
    }
    expect(mocks.readCadenceCompletionContext).not.toHaveBeenCalled();
  });

  it("composes API-EG-014 only after direct finalization returns", async () => {
    const body = { expectedSessionVersion: 1, finalProgressVersion: 0, endReasonCode: "learner_finished",
      completionIdempotencyKey: "complete-2", reportedConnectedSeconds: 60 };
    const response = await completeSession(post(body), { params: { sessionId: "session-2" } });
    expect(response.status).toBe(200);
    expect(mocks.order).toEqual(["finalized", "composed"]);
    expect(mocks.composeCadenceCelebrationAfterCommit).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-math" }),
      "complete-2", expect.objectContaining({ status: "completed" }));
    await expect(response.json()).resolves.toHaveProperty("cadenceCelebrationContext.eligible", true);
  });

  it("also composes after the intentional Finish-now transaction commits", async () => {
    const body = { expectedSessionVersion: 1, finalProgressVersion: 0, reason: "intentional_finish",
      idempotencyKey: "finish-2" };
    const response = await finishSession(post(body), { params: { sessionId: "session-2" } });
    expect(response.status).toBe(200);
    expect(mocks.order).toEqual(["finalized", "composed"]);
    expect(mocks.composeCadenceCelebrationAfterCommit).toHaveBeenCalledWith(expect.anything(), "finish-2",
      expect.objectContaining({ sessionStatus: "completed" }));
  });
});
