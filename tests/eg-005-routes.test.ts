import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  requireInternalService: vi.fn(),
  authorizeProtectedAppApi: vi.fn(),
  evaluateAccessForLauncher: vi.fn(),
  listJourney: vi.fn(),
  createJourneyMilestone: vi.fn(),
  reconcileJourney: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/auth/internal-service-guard", () => ({
  requireInternalService: mocks.requireInternalService,
}));
vi.mock("@/lib/app-authorization/guard", () => ({
  authorizeProtectedAppApi: mocks.authorizeProtectedAppApi,
}));
vi.mock("@/lib/entitlement-access/launcher-cache", () => ({
  evaluateAccessForLauncher: mocks.evaluateAccessForLauncher,
}));
vi.mock("@/lib/journey/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/journey/service")>(),
  listJourney: mocks.listJourney,
  createJourneyMilestone: mocks.createJourneyMilestone,
  reconcileJourney: mocks.reconcileJourney,
}));

import { GET as learnerJourney } from "@/app/v1/learner-apps/[appId]/journey/route";
import { GET as parentJourney } from "@/app/v1/parent/learners/[learnerId]/apps/[appId]/journey/route";
import { POST as createMilestone } from "@/app/v1/internal/learner-journey/milestones/route";
import { POST as reconcileRetention } from "@/app/v1/internal/learner-journey/retention-reconcile/route";

function jsonRequest(body: unknown) {
  return new Request("http://x", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue({ ok: true,
    authorization: { learnerId: "learner-1", mode: "learner_mode" } });
  mocks.requireInternalService.mockResolvedValue({ ok: true, principal: { id: "retention-service" } });
  mocks.authorizeProtectedAppApi.mockResolvedValue({ learnerId: "learner-1", appId: "app-1",
    releaseId: "release-1", environment: "production" });
  mocks.evaluateAccessForLauncher.mockReturnValue({ allowed: true, state: "active" });
  mocks.listJourney.mockReturnValue({ appId: "app-1", events: [], nextCursor: null, order: "desc",
    retentionState: { state: "active", deleteAfter: null, retainedUntilDate: null } });
  mocks.createJourneyMilestone.mockReturnValue({ created: true, journeyEventId: "event-1",
    eventType: "milestone_reached", occurredAt: "2026-08-11T04:30:00.000Z" });
  mocks.reconcileJourney.mockReturnValue({ active: 1, pending: 0, purged: 0, repaired: 0,
    skipped: 0, nextCursor: null });
});

describe("EG-005 journey routes", () => {
  it("API-EG-018 derives the learner and requires current app access", async () => {
    const response = await learnerJourney(new Request("http://x/v1/learner-apps/app-1/journey?order=asc&limit=25"),
      { params: { appId: "app-1" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request), "learner.journey.read");
    expect(mocks.evaluateAccessForLauncher).toHaveBeenCalledWith(expect.objectContaining({
      learnerId: "learner-1", appId: "app-1", environment: "production",
    }));
    expect(mocks.listJourney).toHaveBeenCalledWith(expect.objectContaining({ learnerId: "learner-1",
      appId: "app-1", order: "asc", limit: 25 }));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("API-EG-018 does not expose an ended app to learner mode", async () => {
    mocks.evaluateAccessForLauncher.mockReturnValue({ allowed: false, state: "inactive" });
    const response = await learnerJourney(new Request("http://x/v1/learner-apps/app-1/journey"),
      { params: { appId: "app-1" } });
    expect(response.status).toBe(404);
    expect(mocks.listJourney).not.toHaveBeenCalled();
  });

  it("API-EG-019 uses direct parent ownership and exposes only the neutral retention deadline", async () => {
    mocks.requireEndUserAuthorization.mockResolvedValue({ ok: true,
      authorization: { mode: "parent_management" } });
    await parentJourney(new Request("http://x/v1/parent/learners/learner-2/apps/app-1/journey"),
      { params: { learnerId: "learner-2", appId: "app-1" } });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.learner.journey.read", { learnerId: "learner-2" });
    expect(mocks.listJourney).toHaveBeenCalledWith(expect.objectContaining({ learnerId: "learner-2",
      appId: "app-1", exposeRetentionDeadline: true }));
  });

  it("API-EG-020 requires the exact app scope and derives learner/app/release from the grant", async () => {
    const response = await createMilestone(jsonRequest({ appJourneyMilestoneKey: "belt",
      journeyInstanceKey: "green", title: "Green belt", occurredAt: "2026-08-11T04:30:00.000Z",
      basedOnProgressVersion: 7, idempotencyKey: "belt-green" }));
    expect(mocks.authorizeProtectedAppApi).toHaveBeenCalledWith(expect.any(Request), "journey.milestone.write");
    expect(mocks.createJourneyMilestone).toHaveBeenCalledWith({ learnerId: "learner-1", appId: "app-1",
      releaseId: "release-1", environment: "production" }, expect.objectContaining({
      appJourneyMilestoneKey: "belt", basedOnProgressVersion: 7,
    }), expect.any(Date));
    expect(response.status).toBe(201);
  });

  it("API-EG-020 rejects browser-supplied learner or app identity", async () => {
    const response = await createMilestone(jsonRequest({ appJourneyMilestoneKey: "belt",
      journeyInstanceKey: "green", title: "Green belt", occurredAt: "2026-08-11T04:30:00.000Z",
      basedOnProgressVersion: 7, idempotencyKey: "belt-green", learnerId: "sibling" }));
    expect(response.status).toBe(400);
    expect(mocks.createJourneyMilestone).not.toHaveBeenCalled();
  });

  it("API-EG-023 is bounded and restricted to the dedicated retention principal", async () => {
    const response = await reconcileRetention(jsonRequest({ mode: "purge", learnerId: "learner-1",
      cursor: "after", limit: 50, runIdempotencyKey: "purge-1" }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "journey-retention");
    expect(mocks.reconcileJourney).toHaveBeenCalledWith(expect.objectContaining({ mode: "purge",
      learnerId: "learner-1", cursor: "after", limit: 50, principalId: "retention-service",
      runIdempotencyKey: "purge-1" }));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

