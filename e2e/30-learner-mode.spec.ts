import { test, expect } from "@playwright/test";
import { check, ALLOW_WRITES, watchForErrors, PASSWORD } from "./helpers";

test.describe("Learner mode and app launcher", () => {
  test("Open a learner, see the launcher cards, then exit back to the parent account", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/account/learners");
    const unlockHref = await check("Find the first learner's 'Open learner' link", async () => {
      const a = page.getByRole("link", { name: "Open learner" }).first();
      await expect(a).toBeVisible();
      return (await a.getAttribute("href"))!;
    });
    await check("'Open learner' enters learner mode and lands on /learner", async () => {
      await page.goto(unlockHref);
      await page.waitForURL("**/learner", { timeout: 30_000 });
    });
    await check("Learner mode banner 'Baby Steps learning mode' is visible", async () => {
      await expect(page.getByText("Baby Steps learning mode")).toBeVisible();
    });
    await check("Learner launcher shows at least one app card or an explicit empty state", async () => {
      await page.waitForLoadState("networkidle");
      const cards = page.getByRole("button", { name: /^start|resume/i });
      const blocked = page.getByText(/getting this app ready|no sessions|isn.?t available|used up|in progress/i);
      const empty = page.getByText(/no apps|nothing here|not.*any apps/i);
      expect((await cards.count()) + (await blocked.count()) + (await empty.count())).toBeGreaterThan(0);
    });
    await check("No error banner on the launcher", async () => {
      await expect(page.getByText(/application error|something went wrong/i)).toHaveCount(0);
    });
    await check("Parent-only pages are closed while in learner mode (/account/security redirects away)", async () => {
      await page.goto("/account/security");
      await expect(page).not.toHaveURL(/\/account\/security$/);
    });
    await page.goto("/learner");
    await check("Leaving learner mode is guarded: 'Return to parent area' is disabled until a password is typed", async () => {
      await expect(page.getByRole("button", { name: "Return to parent area" })).toBeDisabled();
    });
    await check("A wrong parent password is refused and the learner stays in learner mode", async () => {
      await page.getByLabel("Parent password").fill("wrong-password-for-e2e");
      await page.getByRole("button", { name: "Return to parent area" }).click();
      await expect(page.getByText(/ask your parent to enter the current account password/i)).toBeVisible();
      await expect(page).toHaveURL(/\/learner$/);
    });
    await check("The correct parent password returns to the parent dashboard", async () => {
      await page.getByLabel("Parent password").fill(PASSWORD);
      await page.getByRole("button", { name: "Return to parent area" }).click();
      await page.waitForURL(/\/account/, { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "Your dashboard" })).toBeVisible();
    });
    await errors.assertClean();
  });

  test("Starting an app session (real launch) — only with E2E_ALLOW_WRITES=1", async ({ page }) => {
    test.skip(!ALLOW_WRITES, "Skipped on purpose: Start consumes a weekly session and creates a real learning session. Set E2E_ALLOW_WRITES=1 to include it.");
    await page.goto("/account/learners");
    await page.getByRole("link", { name: "Open learner" }).first().click();
    await page.waitForURL("**/learner");
    await check("Press Start on the first available app", async () => {
      await page.getByRole("button", { name: /^start/i }).first().click();
    });
    await check("The partner app opens (page leaves babystepsindia.com's launcher)", async () => {
      await page.waitForURL((u) => u.pathname !== "/learner", { timeout: 45_000 });
    });
  });
});
