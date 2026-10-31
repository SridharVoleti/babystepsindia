import { test, expect } from "@playwright/test";
import { check, openPage, watchForErrors } from "./helpers";

// Checkout is verified up to - and never including - the payment provider. Nothing is bought.
test.describe("Billing and checkout (signed in)", () => {
  test("Checkout review page shows learner, exact price, renewal consent and a guarded pay button", async ({ page }) => {
    const errors = watchForErrors(page);
    await openPage(page, "/account/subscriptions/new?product=speed-reader", "Review your subscription");
    await check("Learner selector lists the parent's learners", async () => {
      const options = await page.locator("#learner option").allTextContents();
      expect(options.length, "at least one learner").toBeGreaterThan(0);
    });
    await check("Summary names the selected learner ('This subscription is for ...')", async () => {
      await expect(page.getByText(/This subscription is for /).first()).toBeVisible();
    });
    await check("Exact price is shown in rupees with a billing interval", async () => {
      await expect(page.getByText(/₹\s?[\d,]+(\.\d+)?\s+every/)).toBeVisible();
    });
    await check("Product name and included apps are stated", async () => {
      await expect(page.getByText(/includes /)).toBeVisible();
    });
    await check("Auto-renew consent checkbox is present and explained", async () => {
      await expect(page.getByLabel("Automatically renew this subscription")).toBeVisible();
      await expect(page.getByText(/authorize recurring charges/i)).toBeVisible();
    });
    await check("'Continue to payment' is DISABLED until the confirmation is ticked", async () => {
      await expect(page.getByRole("button", { name: "Continue to payment" })).toBeDisabled();
    });
    await check("Ticking the confirmation enables the button (we do NOT press it)", async () => {
      await page.getByLabel("I confirm the learner and product shown above.").check();
      await expect(page.getByRole("button", { name: "Continue to payment" })).toBeEnabled();
    });
    await errors.assertClean();
  });

  test("Checkout for an unknown or missing product is a clean 404, not a crash", async ({ page }) => {
    await check("?product=does-not-exist gives 404", async () => {
      const res = await page.goto("/account/subscriptions/new?product=does-not-exist");
      expect(res!.status()).toBe(404);
    });
    await check("No product param gives 404 (never a 500)", async () => {
      const res = await page.goto("/account/subscriptions/new");
      expect(res!.status()).toBe(404);
    });
  });

  test("Subscriptions page lists each subscription with learner, status and renewal controls", async ({ page }) => {
    const errors = watchForErrors(page);
    await openPage(page, "/account/subscriptions", "Subscriptions");
    await check("Either subscriptions are listed or an explicit empty state is shown", async () => {
      const cards = await page.locator("article").count();
      if (cards === 0) await expect(page.getByText("No subscriptions yet.")).toBeVisible();
    });
    await check("Every subscription card names the learner it is 'For ...'", async () => {
      for (const card of await page.locator("article").all()) await expect(card.getByText(/^For /)).toBeVisible();
    });
    await check("Every active subscription shows its Auto-renewal state and a dated line", async () => {
      for (const card of await page.locator("article").all()) {
        if (await card.getByText("active", { exact: true }).count()) {
          await expect(card.getByText(/Auto-renewal:/)).toBeVisible();
          await expect(card.getByText(/paid period ending|Subscription ends on/)).toBeVisible();
        }
      }
    });
    await errors.assertClean();
  });

  test("Payment hand-off page rejects an unknown reference without a server error", async ({ page }) => {
    await check("/billing/provider-handoff/<bogus> is below 500", async () => {
      const res = await page.goto("/billing/provider-handoff/e2e-not-a-real-ref");
      expect(res!.status()).toBeLessThan(500);
    });
  });
});
