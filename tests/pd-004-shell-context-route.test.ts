import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  composeParentShellContext: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/parent-shell/service", () => ({ composeParentShellContext: mocks.composeParentShellContext }));

import { GET as shellContext } from "@/app/v1/parent/shell-context/route";

const guardOk = {
  ok: true,
  parent: { session: { sub: "parent-1", sid: "session-1", did: "device-1" } },
  authorization: { modeGeneration: 3 },
};

const sampleContext = {
  shellVersion: "v1",
  composedAt: "t",
  modeGeneration: 3,
  navItems: [{ key: "home", href: "/account", label: "Home" }],
  attentionSummary: { composedAt: "t", version: "v1", actionRequiredCount: 0, attentionCount: 0, infoCount: 0, hasItems: false, preview: [] },
  capabilityHints: { canManageBilling: true, canManageLearners: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
});

describe("GET /v1/parent/shell-context — AT-PD-004-01/02/07/08 (API-PD-006)", () => {
  it("passes through guard denial", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await shellContext(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("derives the parent and authoritative modeGeneration from the session, and returns the composed context", async () => {
    mocks.composeParentShellContext.mockReturnValue(sampleContext);
    const response = await shellContext(new Request("http://x"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.shell_context.read");
    expect(mocks.composeParentShellContext).toHaveBeenCalledWith("parent-1", 3, expect.any(Date));
    expect(response.headers.get("ETag")).toBe('"v1"');
    const body = await response.json();
    expect(body).toMatchObject({ shellVersion: "v1", modeGeneration: 3, navItems: expect.any(Array) });
  });

  it("returns 304 when the request ETag matches the shellVersion", async () => {
    mocks.composeParentShellContext.mockReturnValue(sampleContext);
    const response = await shellContext(new Request("http://x", { headers: { "if-none-match": '"v1"' } }));
    expect(response.status).toBe(304);
  });

  it("AT-PD-004-08: still returns 200 with nav/mode intact when attentionSummary is omitted (degraded)", async () => {
    mocks.composeParentShellContext.mockReturnValue({ ...sampleContext, attentionSummary: undefined });
    const response = await shellContext(new Request("http://x"));
    const body = await response.json();
    expect(body.attentionSummary).toBeUndefined();
    expect(body.navItems.length).toBeGreaterThan(0);
    expect(body.modeGeneration).toBe(3);
  });
});
