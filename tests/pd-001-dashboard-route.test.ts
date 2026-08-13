import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentDashboard: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/parent-dashboard/service", () => ({ composeParentDashboard: mocks.composeParentDashboard }));

import { GET as dashboard } from "@/app/v1/parent/dashboard/route";

const guardOk = { ok: true, parent: { session: { sub: "parent-1", sid: "session-1", did: "device-1" } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
});

describe("GET /v1/parent/dashboard", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await dashboard(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("derives the parent from the session, never a query parameter", async () => {
    mocks.composeParentDashboard.mockReturnValue({ composedAt: "t", version: "v1", learners: [], partialErrors: {} });
    const response = await dashboard(new Request("http://x?parentId=someone-else"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.dashboard.read");
    expect(mocks.composeParentDashboard).toHaveBeenCalledWith("parent-1", expect.any(Date));
    expect(response.headers.get("ETag")).toBe('"v1"');
  });

  it("returns 304 when the request ETag matches", async () => {
    mocks.composeParentDashboard.mockReturnValue({ composedAt: "t", version: "v1", learners: [], partialErrors: {} });
    const response = await dashboard(new Request("http://x", { headers: { "if-none-match": '"v1"' } }));
    expect(response.status).toBe(304);
  });
});
