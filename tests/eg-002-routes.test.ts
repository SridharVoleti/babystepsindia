import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  requireInternalService: vi.fn(),
  listConsistency: vi.fn(),
  applyStandardSessionConsistency: vi.fn(),
  finalizeConsistencyWeek: vi.fn(),
  reconcileConsistency: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/auth/internal-service-guard", () => ({
  requireInternalService: mocks.requireInternalService,
}));
vi.mock("@/lib/consistency/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/consistency/service")>(),
  listConsistency: mocks.listConsistency,
  applyStandardSessionConsistency: mocks.applyStandardSessionConsistency,
  finalizeConsistencyWeek: mocks.finalizeConsistencyWeek,
  reconcileConsistency: mocks.reconcileConsistency,
}));

import { GET as learnerConsistency } from "@/app/v1/learner-consistency/route";
import { GET as parentConsistency } from "@/app/v1/parent/learners/[learnerId]/consistency/route";
import { POST as standardSessionCommitted } from
  "@/app/v1/internal/learner-consistency/standard-session-committed/route";
import { POST as finalizeWeek } from "@/app/v1/internal/learner-consistency/finalize-week/route";
import { POST as reconcile } from "@/app/v1/internal/learner-consistency/reconcile/route";

const learnerGuard = { ok: true, authorization: { learnerId: "learner-1", mode: "learner_mode" } };
const parentGuard = { ok: true, authorization: { mode: "parent_management" } };
const serviceGuard = { ok: true, principal: { id: "service-1" } };

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(learnerGuard);
  mocks.requireInternalService.mockResolvedValue(serviceGuard);
  mocks.listConsistency.mockReturnValue({ apps: [], history: [], nextCursor: null });
  mocks.applyStandardSessionConsistency.mockReturnValue({ currentWeekProgress: 1, target: 2 });
  mocks.finalizeConsistencyWeek.mockReturnValue({ completed: 0, reset: 0, neutral: 0,
    outOfScope: 0, nextCursor: null });
  mocks.reconcileConsistency.mockReturnValue({ healthy: 0, repaired: 0, conflict: 0,
    error: 0, nextCursor: null });
});

describe("EG-002 read routes", () => {
  it("API-EG-007 derives the learner from learner_mode and returns private no-store data", async () => {
    const response = await learnerConsistency(new Request(
      "http://x/v1/learner-consistency?learnerId=sibling&appId=app-1&limit=12"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "learner.consistency.read");
    expect(mocks.listConsistency).toHaveBeenCalledWith(expect.objectContaining({
      learnerId: "learner-1", appId: "app-1", limit: 12,
    }));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("API-EG-008 requires direct parent ownership of the path learner", async () => {
    mocks.requireEndUserAuthorization.mockResolvedValue(parentGuard);
    await parentConsistency(new Request("http://x/v1/parent/learners/learner-2/consistency"),
      { params: { learnerId: "learner-2" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.learner.consistency.read", { learnerId: "learner-2" });
    expect(mocks.listConsistency).toHaveBeenCalledWith(expect.objectContaining({ learnerId: "learner-2" }));
  });
});

describe("EG-002 internal mutation routes", () => {
  it("API-EG-009 uses only the session-domain principal and authoritative source identifiers", async () => {
    const response = await standardSessionCommitted(jsonRequest("http://x", {
      sourceSessionId: "session-1", weeklyUsageVersion: 7, eventId: "standard-session:session-1",
    }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "consistency-session-domain");
    expect(mocks.applyStandardSessionConsistency).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "session-1", weeklyUsageVersion: 7, principalId: "service-1",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("API-EG-009 rejects browser-supplied learner/app/count fields", async () => {
    const response = await standardSessionCommitted(jsonRequest("http://x", {
      sourceSessionId: "session-1", weeklyUsageVersion: 7, eventId: "standard-session:session-1",
      learnerId: "learner-2", qualifyingCount: 2,
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "CONSISTENCY_REQUEST_INVALID" });
    expect(mocks.applyStandardSessionConsistency).not.toHaveBeenCalled();
  });

  it("API-EG-010 is bounded and restricted to the consistency scheduler", async () => {
    await finalizeWeek(jsonRequest("http://x", { weeklyKey: "2026-W33", cursor: "after",
      limit: 50, runIdempotencyKey: "finalize-1" }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "consistency-scheduler");
    expect(mocks.finalizeConsistencyWeek).toHaveBeenCalledWith(expect.objectContaining({
      weeklyKey: "2026-W33", cursor: "after", limit: 50, principalId: "service-1",
    }));
  });

  it("API-EG-011 is bounded and restricted to the reconciliation principal", async () => {
    await reconcile(jsonRequest("http://x", { learnerId: "learner-1", appId: "app-1",
      fromWeek: "2026-W30", toWeek: "2026-W33", limit: 25, runIdempotencyKey: "repair-1" }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "consistency-reconciliation");
    expect(mocks.reconcileConsistency).toHaveBeenCalledWith(expect.objectContaining({
      learnerId: "learner-1", appId: "app-1", fromWeek: "2026-W30", toWeek: "2026-W33",
      limit: 25, principalId: "service-1",
    }));
  });
});
