import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentShellContext: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/parent-shell/service", () => ({ composeParentShellContext: mocks.composeParentShellContext }));

import { GET as shellContext } from "@/app/v1/parent/shell-context/route";

const guardOk = { ok: true, parent: { session: { sub: "parent-1", sid: "session-1", did: "device-1" } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
});

describe("GET /v1/parent/shell-context", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await shellContext(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("derives the parent from the session and returns the composed context", async () => {
    mocks.composeParentShellContext.mockReturnValue({ composedAt: "t", version: "v1",
      attentionBadge: { composedAt: "t", version: "v1", actionRequiredCount: 0, attentionCount: 0, hasItems: false, preview: [] } });
    const response = await shellContext(new Request("http://x"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.shell_context.read");
    expect(mocks.composeParentShellContext).toHaveBeenCalledWith("parent-1", expect.any(Date));
    expect(response.headers.get("ETag")).toBe('"v1"');
  });

  it("returns 304 when the request ETag matches", async () => {
    mocks.composeParentShellContext.mockReturnValue({ composedAt: "t", version: "v1",
      attentionBadge: { composedAt: "t", version: "v1", actionRequiredCount: 0, attentionCount: 0, hasItems: false, preview: [] } });
    const response = await shellContext(new Request("http://x", { headers: { "if-none-match": '"v1"' } }));
    expect(response.status).toBe(304);
  });
});
