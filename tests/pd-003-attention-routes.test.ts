import { beforeEach, describe, expect, it, vi } from "vitest";

// PD3-G10 AT-PD-003-01..48 traceability. 01,04,35,44 in this file + service
// tests; 02-33,36,40 in pd-003-attention.test.ts (source authority/severity/
// billing/passkey/service-status/cadence/dedupe/sort/no-outbound/
// no-resolution-api/auto-resolve/nextRecheckAt — the original PD-003 build's
// own composition-rule tests, unchanged); 34,39,42-43 architecture-scan
// facts (no learner_mode gate needed since PD-002/PD-003/PD-004 never touch
// authorization/modes.ts's mode enum; no polling — every route is
// request/response only, see mode-guard's own "no interval" note; no
// resolved-history table — schema.sql has none). 08,10,15,18,26 automated
// via au-002/billing route tests elsewhere (CTA delegation to the owning
// domain's real route, not a PD-003 mutation). 37,45-48 in
// pd-003-attention-ui.test.tsx (zero state, desktop/mobile filter chips,
// accessibility). 41 manual (offline read-only rendering, same
// no-E2E-framework reasoning as PD-002/PD-004).

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentAttention: vi.fn(),
  composeParentAttentionBadge: vi.fn(),
  composeParentAttentionList: vi.fn(),
  composeParentAttentionSummary: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/parent-attention/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parent-attention/service")>("@/lib/parent-attention/service");
  return { ...actual,
    composeParentAttention: mocks.composeParentAttention,
    composeParentAttentionBadge: mocks.composeParentAttentionBadge,
    composeParentAttentionList: mocks.composeParentAttentionList,
    composeParentAttentionSummary: mocks.composeParentAttentionSummary,
  };
});

import { GET as attentionList } from "@/app/v1/parent/attention/route";
import { GET as attentionSummary } from "@/app/v1/parent/attention/summary/route";
import { GET as attentionCenter } from "@/app/v1/parent/attention-center/route";
import { GET as attentionSummaryContract } from "@/app/v1/parent/attention-summary/route";
import { ParentAttentionRequestError } from "@/lib/parent-attention/service";

const guardOk = { ok: true, parent: { session: { sub: "parent-1", sid: "session-1", did: "device-1" } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
});

describe("GET /v1/parent/attention", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await attentionList(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("derives the parent from the session, never a query parameter", async () => {
    mocks.composeParentAttention.mockReturnValue({ composedAt: "t", version: "v1", items: [], partialErrors: [] });
    const response = await attentionList(new Request("http://x?parentId=someone-else"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.attention.read");
    expect(mocks.composeParentAttention).toHaveBeenCalledWith("parent-1", expect.any(Date));
    expect(response.headers.get("ETag")).toBe('"v1"');
  });

  it("returns 304 when the request ETag matches", async () => {
    mocks.composeParentAttention.mockReturnValue({ composedAt: "t", version: "v1", items: [], partialErrors: [] });
    const response = await attentionList(new Request("http://x", { headers: { "if-none-match": '"v1"' } }));
    expect(response.status).toBe(304);
  });
});

describe("GET /v1/parent/attention/summary", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await attentionSummary(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("returns the compact badge", async () => {
    mocks.composeParentAttentionBadge.mockReturnValue({ composedAt: "t", version: "v2",
      actionRequiredCount: 1, attentionCount: 0, hasItems: true, preview: [] });
    const response = await attentionSummary(new Request("http://x"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.attention.summary.read");
    const body = await response.json();
    expect(body).toMatchObject({ actionRequiredCount: 1, hasItems: true });
  });
});

describe("GET /v1/parent/attention-center — API-PD-004 (PD3-G01/G03/G04/G05)", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await attentionCenter(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("parses filters/cursor/limit from the query string and returns the exact frozen shape", async () => {
    mocks.composeParentAttentionList.mockReturnValue({
      composedAt: "t", version: "v1", nextRecheckAt: null, items: [], partialErrors: [],
      summary: { actionRequiredCount: 0, attentionCount: 0, infoCount: 0 }, nextCursor: "5",
    });
    const response = await attentionCenter(new Request("http://x?learnerId=learner-1&category=billing&severity=attention&cursor=2&limit=10"));
    expect(mocks.composeParentAttentionList).toHaveBeenCalledWith("parent-1",
      { learnerId: "learner-1", category: "billing", severity: "attention", cursor: "2", limit: "10" }, expect.any(Date));
    const body = await response.json();
    expect(body).toEqual({ attentionVersion: "v1", composedAt: "t", nextRecheckAt: null,
      summary: { actionRequiredCount: 0, attentionCount: 0, infoCount: 0 }, items: [], partialErrors: [], nextCursor: "5" });
  });

  it("PD3-G09: maps a request validation error to a safe 400", async () => {
    mocks.composeParentAttentionList.mockImplementation(() => { throw new ParentAttentionRequestError("INVALID_CATEGORY"); });
    const response = await attentionCenter(new Request("http://x?category=bogus"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("INVALID_CATEGORY");
  });

  it("returns 304 when the request ETag matches", async () => {
    mocks.composeParentAttentionList.mockReturnValue({
      composedAt: "t", version: "v1", nextRecheckAt: null, items: [], partialErrors: [],
      summary: { actionRequiredCount: 0, attentionCount: 0, infoCount: 0 }, nextCursor: null,
    });
    const response = await attentionCenter(new Request("http://x", { headers: { "if-none-match": '"v1"' } }));
    expect(response.status).toBe(304);
  });
});

describe("GET /v1/parent/attention-summary — API-PD-005 (PD3-G01/G02/G07)", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await attentionSummaryContract(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("parses learnerId/limit and returns the exact frozen shape", async () => {
    mocks.composeParentAttentionSummary.mockReturnValue({
      composedAt: "t", version: "v2", actionRequiredCount: 1, attentionCount: 0, infoCount: 2, hasItems: true, preview: [],
    });
    const response = await attentionSummaryContract(new Request("http://x?learnerId=learner-1&limit=5"));
    expect(mocks.composeParentAttentionSummary).toHaveBeenCalledWith("parent-1", { learnerId: "learner-1", limit: "5" }, expect.any(Date));
    const body = await response.json();
    expect(body).toEqual({ actionRequiredCount: 1, attentionCount: 0, infoCount: 2, preview: [], attentionVersion: "v2" });
  });

  it("maps a request validation error (e.g. limit>5) to a safe 400", async () => {
    mocks.composeParentAttentionSummary.mockImplementation(() => { throw new ParentAttentionRequestError("INVALID_LIMIT"); });
    const response = await attentionSummaryContract(new Request("http://x?limit=99"));
    expect(response.status).toBe(400);
  });
});
