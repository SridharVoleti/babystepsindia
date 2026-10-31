import { test, expect, request } from "@playwright/test";
import { check } from "./helpers";

test.describe("Security boundaries (signed in as a PARENT)", () => {
  test("A parent session does NOT grant access to the admin area", async ({ page }) => {
    for (const path of ["/admin", "/admin/apps", "/admin/learners", "/admin/grant"]) {
      await check(`${path} is closed to a parent (redirects to staff login)`, async () => {
        await page.goto(path);
        await expect(page).toHaveURL(/\/staff\/login/);
      });
    }
  });

  test("Internal and v1 APIs refuse unauthenticated callers", async ({ baseURL }) => {
    const anon = await request.newContext({ baseURL });
    for (const [method, path] of [
      ["GET", "/v1/admin/apps"], ["POST", "/v1/internal/app-launch/exchange"],
    ] as const) {
      await check(`${method} ${path} without credentials is rejected (401/403/redirect, never 200)`, async () => {
        const res = await anon.fetch(path, { method, maxRedirects: 0, data: method === "POST" ? {} : undefined });
        expect([301, 302, 303, 307, 308, 401, 403]).toContain(res.status());
      });
    }
    await anon.dispose();
  });

  const headerTests: [string, (h: Record<string, string>) => void][] = [
    ["Strict-Transport-Security (HSTS) is set", (h) => expect(h["strict-transport-security"]).toMatch(/max-age=\d+/)],
    ["X-Content-Type-Options is 'nosniff'", (h) => expect(h["x-content-type-options"]).toBe("nosniff")],
    ["Clickjacking protection (X-Frame-Options or CSP frame-ancestors) is set", (h) =>
      expect(`${h["x-frame-options"] ?? ""} ${h["content-security-policy"] ?? ""}`).toMatch(/deny|sameorigin|frame-ancestors/i)],
    ["Referrer-Policy is set", (h) => expect(h["referrer-policy"]).toBeTruthy()],
    ["'X-Powered-By' does not advertise the framework", (h) => expect(h["x-powered-by"]).toBeUndefined()],
  ];
  for (const [title, assertion] of headerTests) {
    test(`Home page header: ${title}`, async ({ page }) => {
      const res = await page.goto("/");
      await check(title, async () => assertion(res!.headers()));
    });
  }

  test("Page source contains no obvious secrets and is served over HTTPS", async ({ page }) => {
    await page.goto("/");
    await check("Served over HTTPS", async () => { expect(page.url().startsWith("https://")).toBe(true); });
    await check("Page source contains no service keys / private keys / bootstrap secrets", async () => {
      expect(await page.content()).not.toMatch(/SUPABASE_SERVICE|PRIVATE KEY|BOOTSTRAP_SECRET|sk_live_/);
    });
  });

  test("HTTP request to the plain-http origin is upgraded to HTTPS", async ({ baseURL }) => {
    test.skip(!baseURL?.startsWith("https://"), "Only meaningful against the https production site");
    await check("http:// redirects to https://", async () => {
      const ctx = await request.newContext();
      const res = await ctx.get(baseURL!.replace("https://", "http://"), { maxRedirects: 0 });
      expect([301, 302, 307, 308]).toContain(res.status());
      expect(res.headers()["location"]).toMatch(/^https:\/\//);
      await ctx.dispose();
    });
  });
});
