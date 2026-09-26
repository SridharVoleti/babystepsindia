// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieToken: undefined as string | undefined,
  authenticateForMobile: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (name === "bs_session" && mocks.cookieToken ? { value: mocks.cookieToken } : undefined),
  }),
}));

import { getSessionFromRequest, signSession } from "@/lib/auth/session";

describe("getSessionFromRequest (mobile bearer tokens alongside the web cookie)", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "mobile-auth-test-secret-at-least-32-chars";
    mocks.cookieToken = undefined;
  });

  const payload = { sub: "parent-1", email: "parent@email.com", isAdmin: false, entitlements: [] as never };

  it("accepts the same signed session token as an Authorization: Bearer header", async () => {
    const token = await signSession(payload);
    const session = await getSessionFromRequest(
      new Request("http://x/v1/parent/dashboard", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(session?.sub).toBe("parent-1");
  });

  it("rejects a bearer token that wasn't signed with this deployment's secret", async () => {
    const token = await signSession(payload);
    process.env.AUTH_SECRET = "a-different-secret-that-is-also-32-chars-long";
    const session = await getSessionFromRequest(
      new Request("http://x", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(session).toBeNull();
  });

  it("falls back to the bs_session cookie when there's no bearer header (web behaviour unchanged)", async () => {
    mocks.cookieToken = await signSession(payload);
    expect((await getSessionFromRequest(new Request("http://x")))?.sub).toBe("parent-1");
    expect((await getSessionFromRequest(undefined))?.sub).toBe("parent-1");
  });

  it("returns null with neither a bearer header nor a cookie", async () => {
    expect(await getSessionFromRequest(new Request("http://x"))).toBeNull();
  });
});

describe("POST /v1/mobile/auth/login", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/auth/mobile-auth", () => ({ authenticateForMobile: mocks.authenticateForMobile }));
    mocks.authenticateForMobile.mockReset();
  });

  async function post(body: unknown) {
    const { POST } = await import("@/app/v1/mobile/auth/login/route");
    return POST(new Request("http://x/v1/mobile/auth/login", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
  }

  it("returns the bearer token, lifetime, parent id and canonical email on success", async () => {
    mocks.authenticateForMobile.mockResolvedValue({
      ok: true, accessToken: "tok", expiresIn: 604800, parentId: "parent-1", email: "parent@email.com",
    });
    const response = await post({ email: " Parent@Email.com ", password: "pw" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      accessToken: "tok", tokenType: "Bearer", expiresIn: 604800, parentId: "parent-1", email: "parent@email.com",
    });
    expect(mocks.authenticateForMobile).toHaveBeenCalledWith("Parent@Email.com", "pw");
  });

  it("maps bad credentials to a generic 401 that never reveals whether the email exists", async () => {
    mocks.authenticateForMobile.mockResolvedValue({ ok: false, error: "INVALID_CREDENTIALS" });
    const response = await post({ email: "parent@email.com", password: "wrong" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  it("maps the shared login rate limit to 429", async () => {
    mocks.authenticateForMobile.mockResolvedValue({ ok: false, error: "RATE_LIMITED" });
    expect((await post({ email: "parent@email.com", password: "pw" })).status).toBe(429);
  });

  it("rejects malformed bodies without attempting authentication", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ email: "parent@email.com" })).status).toBe(400);
    expect(mocks.authenticateForMobile).not.toHaveBeenCalled();
  });
});
