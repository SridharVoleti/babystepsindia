import { beforeEach, describe, expect, it, vi } from "vitest";

// PD2-G08 AT-PD-002-01..50 traceability. 01-03,06-10 in this file (route
// contract/section/appId/errors); 04-05,11-16,19-39,41,48-50 in
// pd-002-learner-detail.test.ts (composer business rules — level/
// destination/motivation/cadence/integrity/streak/achievements/journey/
// availability/grace/subscribe-again/no-overall-score/no-sibling-compare/
// sort/foreign-scope/componentErrors/no-duplicate-store — most already
// covered by the original PD-002 build's own test suite, unchanged here).
// 17-18,20-22,40,42-47 are UI/manual (layout, accessibility, offline
// rendering) verified by hand in the original PD-002 browser-verification
// pass — no automated E2E framework exists in this repo (vitest +
// @testing-library/react only).

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentLearnerDetail: vi.fn(),
  composeParentAppDetail: vi.fn(),
  composeParentLearnerDetailContract: vi.fn(),
  listParentLearnerAppSelectors: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/parent-learner-detail/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parent-learner-detail/service")>("@/lib/parent-learner-detail/service");
  return { ...actual, composeParentLearnerDetail: mocks.composeParentLearnerDetail, composeParentAppDetail: mocks.composeParentAppDetail,
    composeParentLearnerDetailContract: mocks.composeParentLearnerDetailContract,
    listParentLearnerAppSelectors: mocks.listParentLearnerAppSelectors };
});

import { GET as learnerDetail } from "@/app/v1/parent/learners/[learnerId]/route";
import { GET as appDetail } from "@/app/v1/parent/learners/[learnerId]/apps/[appId]/route";
import { GET as detailContract } from "@/app/v1/parent/learners/[learnerId]/detail/route";
import { GET as appSelectors } from "@/app/v1/parent/learners/[learnerId]/apps/route";
import { ParentLearnerDetailError, ParentLearnerDetailStaleSelectionError } from "@/lib/parent-learner-detail/service";

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

describe("GET /v1/parent/learners/[learnerId]/detail — API-PD-002 (PD2-G01/G03/G04/G05, AT-PD-002-01/02/03)", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await detailContract(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response).toBe(denied.response);
  });

  it("defaults section to current and composes the exact frozen response shape", async () => {
    mocks.composeParentLearnerDetailContract.mockReturnValue({
      learner: { learnerId: "learner-1", displayName: "Asha" },
      header: { learnerId: "learner-1", displayName: "Asha", currentCount: 1, pastCount: 0 },
      selectors: { current: [], past: [] }, selectedAppDetail: null, componentErrors: [],
      detailVersion: "v1", composedAt: "t",
    });
    const response = await detailContract(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(mocks.composeParentLearnerDetailContract).toHaveBeenCalledWith(
      "parent-1", "learner-1", { section: "current", appId: undefined }, expect.any(Date));
    const body = await response.json();
    expect(body).toMatchObject({ learner: { learnerId: "learner-1" }, detailVersion: "v1" });
    expect(response.headers.get("ETag")).toBe('"v1"');
  });

  it("accepts an explicit section and appId query", async () => {
    mocks.composeParentLearnerDetailContract.mockReturnValue({
      learner: { learnerId: "learner-1", displayName: "Asha" },
      header: { learnerId: "learner-1", displayName: "Asha", currentCount: 0, pastCount: 1 },
      selectors: { current: [], past: [] }, selectedAppDetail: null, componentErrors: [],
      detailVersion: "v2", composedAt: "t",
    });
    await detailContract(new Request("http://x?section=past&appId=app-1"), { params: { learnerId: "learner-1" } });
    expect(mocks.composeParentLearnerDetailContract).toHaveBeenCalledWith(
      "parent-1", "learner-1", { section: "past", appId: "app-1" }, expect.any(Date));
  });

  it("rejects an invalid section value with a safe 400", async () => {
    const response = await detailContract(new Request("http://x?section=bogus"), { params: { learnerId: "learner-1" } });
    expect(response.status).toBe(400);
    expect(mocks.composeParentLearnerDetailContract).not.toHaveBeenCalled();
  });

  it("PD2-G04: maps a stale-selection error to 409", async () => {
    mocks.composeParentLearnerDetailContract.mockImplementation(() => { throw new ParentLearnerDetailStaleSelectionError(); });
    const response = await detailContract(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("STALE_SELECTION");
  });

  it("maps RESOURCE_NOT_FOUND to 404", async () => {
    mocks.composeParentLearnerDetailContract.mockImplementation(() => { throw new ParentLearnerDetailError("RESOURCE_NOT_FOUND"); });
    const response = await detailContract(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response.status).toBe(404);
  });

  it("returns 304 when the request ETag matches the detailVersion", async () => {
    mocks.composeParentLearnerDetailContract.mockReturnValue({
      learner: { learnerId: "learner-1", displayName: "Asha" },
      header: { learnerId: "learner-1", displayName: "Asha", currentCount: 0, pastCount: 0 },
      selectors: { current: [], past: [] }, selectedAppDetail: null, componentErrors: [],
      detailVersion: "v3", composedAt: "t",
    });
    const response = await detailContract(new Request("http://x", { headers: { "if-none-match": '"v3"' } }),
      { params: { learnerId: "learner-1" } });
    expect(response.status).toBe(304);
  });
});

describe("GET /v1/parent/learners/[learnerId]/apps — API-PD-003 (PD2-G02)", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await appSelectors(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response).toBe(denied.response);
  });

  it("returns the compact current/past selectors", async () => {
    mocks.listParentLearnerAppSelectors.mockReturnValue({
      currentApps: [{ appId: "app-1", appName: "App 1" }], pastApps: [], compositionVersion: "cv1",
    });
    const response = await appSelectors(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(mocks.listParentLearnerAppSelectors).toHaveBeenCalledWith("parent-1", "learner-1", expect.any(Date));
    const body = await response.json();
    expect(body).toEqual({ currentApps: [{ appId: "app-1", appName: "App 1" }], pastApps: [], compositionVersion: "cv1" });
    expect(response.headers.get("ETag")).toBe('"cv1"');
  });

  it("maps RESOURCE_NOT_FOUND to 404", async () => {
    mocks.listParentLearnerAppSelectors.mockImplementation(() => { throw new ParentLearnerDetailError("RESOURCE_NOT_FOUND"); });
    const response = await appSelectors(new Request("http://x"), { params: { learnerId: "learner-1" } });
    expect(response.status).toBe(404);
  });
});
