import { beforeEach, describe, expect, it, vi } from "vitest";

// AT-NT-002-01/02/13/48 (auth/learner-mode denial via the shared guard mock,
// no query-param leakage) live here; the composition-logic ACs (05-50) live
// in tests/nt-002-communication-history.test.ts against the real composer.
const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentCommunicationHistory: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/notification-history/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notification-history/service")>("@/lib/notification-history/service");
  return { ...actual, composeParentCommunicationHistory: mocks.composeParentCommunicationHistory };
});

import { GET as communicationHistory } from "@/app/v1/parent/communication-history/route";
import { ParentCommunicationHistoryRequestError } from "@/lib/notification-history/service";

const guardOk = { ok: true, parent: { session: { sub: "parent-1", sid: "session-1", did: "device-1" } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
});

describe("GET /v1/parent/communication-history — API-NT-006", () => {
  it("AT-NT-002-02: passes through guard denial (e.g. learner_mode)", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await communicationHistory(new Request("http://x"));
    expect(response).toBe(denied.response);
    expect(mocks.composeParentCommunicationHistory).not.toHaveBeenCalled();
  });

  it("AT-NT-002-01/11-12: derives the parent from the session (never a query parameter) and returns the frozen shape", async () => {
    mocks.composeParentCommunicationHistory.mockReturnValue({
      historyVersion: "v1", retentionMonths: 13, items: [], nextCursor: null,
    });
    const response = await communicationHistory(new Request("http://x?parentId=someone-else"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.notification_history.read");
    expect(mocks.composeParentCommunicationHistory).toHaveBeenCalledWith("parent-1", expect.anything(), expect.any(Date));
    const body = await response.json();
    expect(body).toEqual({ historyVersion: "v1", retentionMonths: 13, items: [], nextCursor: null });
    expect(response.headers.get("ETag")).toBe('"v1"');
  });

  it("parses category/learnerId/cursor/limit from the query string", async () => {
    mocks.composeParentCommunicationHistory.mockReturnValue({ historyVersion: "v1", retentionMonths: 13, items: [], nextCursor: null });
    await communicationHistory(new Request("http://x?category=billing&learnerId=learner-1&cursor=abc&limit=10"));
    expect(mocks.composeParentCommunicationHistory).toHaveBeenCalledWith("parent-1",
      { category: "billing", learnerId: "learner-1", cursor: "abc", limit: "10" }, expect.any(Date));
  });

  it("maps a request validation error to a safe 400", async () => {
    mocks.composeParentCommunicationHistory.mockImplementation(() => { throw new ParentCommunicationHistoryRequestError("INVALID_CATEGORY"); });
    const response = await communicationHistory(new Request("http://x?category=bogus"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("INVALID_CATEGORY");
  });

  it("returns 304 when the request ETag matches", async () => {
    mocks.composeParentCommunicationHistory.mockReturnValue({ historyVersion: "v1", retentionMonths: 13, items: [], nextCursor: null });
    const response = await communicationHistory(new Request("http://x", { headers: { "if-none-match": '"v1"' } }));
    expect(response.status).toBe(304);
  });
});
