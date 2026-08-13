import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentAttention: vi.fn(),
  composeParentAttentionBadge: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/parent-attention/service", () => ({
  composeParentAttention: mocks.composeParentAttention,
  composeParentAttentionBadge: mocks.composeParentAttentionBadge,
}));

import { GET as attentionList } from "@/app/v1/parent/attention/route";
import { GET as attentionSummary } from "@/app/v1/parent/attention/summary/route";

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
