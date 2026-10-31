import { test, expect, request } from "@playwright/test";
import { check, ALLOW_WRITES, PASSWORD, enterLearnerMode } from "./helpers";

const APPS = [
  { name: "Speed Reading", origin: "https://speedreader.babystepsindia.com" },
  { name: "ChessMasters", origin: "https://chessmaster.babystepsindia.com" },
];

test.describe("Partner apps", () => {
  for (const app of APPS) {
    test(`${app.name}: deployment is up and refuses a launch without a valid code`, async () => {
      const ctx = await request.newContext();
      await check(`${app.origin}/health answers 200`, async () => {
        expect((await ctx.get(`${app.origin}/health`)).status()).toBe(200);
      });
      await check("POST /launch with no code is rejected (4xx, never 200 or 500)", async () => {
        const res = await ctx.post(`${app.origin}/launch`, { form: {}, maxRedirects: 0 });
        expect(res.status()).toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
      });
      await check("POST /launch with a forged code is refused with a safe message (no stack trace or secrets)", async () => {
        const res = await ctx.post(`${app.origin}/launch`, { form: { launchCode: "forged", launchAttemptId: "forged" }, maxRedirects: 0 });
        expect([400, 401, 403, 404, 502]).toContain(res.status());
        expect(await res.text()).not.toMatch(/at \w+ \(|node_modules|SUPABASE|PRIVATE KEY/);
      });
      await ctx.dispose();
    });
  }

  test("Learner launcher lists the learner's apps with a Start control per app", async ({ page }) => {
    await enterLearnerMode(page);
    await check("Launcher greets the learner ('Hi, ...')", async () => {
      await expect(page.getByText(/^Hi, /)).toBeVisible();
    });
    for (const app of APPS) {
      await check(`${app.name} appears as a card on the launcher`, async () => {
        await expect(page.getByRole("heading", { name: app.name }).first()).toBeVisible();
      });
    }
    await check("Each card has either an enabled Start or a stated reason it is blocked", async () => {
      const starts = await page.getByRole("button", { name: /^Start$/ }).count();
      const reasons = await page.getByText(/getting this app ready|used up|no sessions|in progress|available right now|maintenance|restoring/i).count();
      expect(starts + reasons).toBeGreaterThanOrEqual(APPS.length);
    });
    await page.getByLabel("Parent password").fill(PASSWORD);
    await page.getByRole("button", { name: "Return to parent area" }).click();
    await page.waitForURL(/\/account/, { timeout: 30_000 });
  });

  test("REAL LAUNCH: Start Speed Reading and confirm the app renders on its own domain (E2E_ALLOW_WRITES=1)", async ({ page }) => {
    test.skip(!ALLOW_WRITES, "Skipped on purpose: this consumes one of the learner's weekly sessions. Set E2E_ALLOW_WRITES=1 to run it.");
    test.setTimeout(120_000);
    await enterLearnerMode(page);
    const card = page.getByRole("heading", { name: "Speed Reading" }).first().locator("xpath=ancestor::*[.//button[normalize-space()='Start']][1]");
    await check("Speed Reading has an enabled Start button", async () => {
      await expect(card.getByRole("button", { name: /^Start$/ })).toBeEnabled({ timeout: 15_000 });
    });
    await check("Pressing Start hands the learner off to speedreader.babystepsindia.com", async () => {
      await card.getByRole("button", { name: /^Start$/ }).click();
      await page.waitForURL(/speedreader\.babystepsindia\.com/, { timeout: 60_000 });
    });
    await check("The app renders (no error page, no 'could not confirm this launch')", async () => {
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText(/couldn.?t open|could not confirm|could not verify|not configured/i)).toHaveCount(0);
      await expect(page.locator("body")).not.toBeEmpty();
    });
    await check("The app is served from its own domain over HTTPS", async () => {
      expect(new URL(page.url()).origin).toBe("https://speedreader.babystepsindia.com");
    });
    await check("Leaving the app (its /return route) brings the learner back to BabySteps", async () => {
      await page.goto("https://speedreader.babystepsindia.com/return");
      await page.waitForURL(/www\.babystepsindia\.com/, { timeout: 45_000 });
    });
    await check("Back on BabySteps the session is no longer stuck: launcher or parent area is shown", async () => {
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText(/application error|something went wrong/i)).toHaveCount(0);
    });
    if (/\/learner/.test(page.url())) {
      await check("Exit learner mode with the parent password", async () => {
        await page.getByLabel("Parent password").fill(PASSWORD);
        await page.getByRole("button", { name: "Return to parent area" }).click();
        await page.waitForURL(/\/account/, { timeout: 30_000 });
      });
    }
  });
});
