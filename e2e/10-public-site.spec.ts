import { test, expect } from "@playwright/test";
import { check, openPage, watchForErrors } from "./helpers";

test.describe("Public site (signed out)", () => {
  test("Home page renders hero, navigation, apps and footer", async ({ page }) => {
    const errors = watchForErrors(page);
    await check("Open /", async () => {
      const res = await page.goto("/");
      expect(res!.status()).toBe(200);
    });
    await check("Page title mentions Baby Steps / Babysteps", async () => {
      await expect(page).toHaveTitle(/baby ?steps/i);
    });
    await check("Hero headline (h1) is visible", async () => {
      await expect(page.locator("h1").first()).toBeVisible();
    });
    for (const link of ["Apps", "How It Works", "For Parents", "Pricing", "About Us"]) {
      await check(`Header nav link "${link}" is visible`, async () => {
        await expect(page.getByRole("navigation").getByRole("link", { name: link })).toBeVisible();
      });
    }
    await check("Signed-out header offers Log in and Create Account", async () => {
      await expect(page.getByRole("link", { name: "Log in" }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: /Create Account/ }).first()).toBeVisible();
    });
    await check("No 'Sign out' button is shown when signed out", async () => {
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    });
    await check("Every image on the page loaded (no broken images)", async () => {
      await page.waitForLoadState("networkidle");
      const broken = await page.$$eval("img", (imgs) =>
        imgs.filter((i) => i.complete === false || (i.complete && i.naturalWidth === 0)).map((i) => i.currentSrc || i.src));
      expect(broken, `broken images: ${broken.join(", ")}`).toEqual([]);
    });
    await check("Footer is present", async () => {
      await expect(page.locator("footer").first()).toBeVisible();
    });
    await errors.assertClean();
  });

  test("Home page in-page anchors scroll to their sections", async ({ page }) => {
    await page.goto("/");
    for (const [name, id] of [["Apps", "products"], ["How It Works", "journey"], ["About Us", "about"]] as const) {
      await check(`"${name}" link jumps to #${id}`, async () => {
        await page.getByRole("navigation").getByRole("link", { name }).click();
        await expect(page).toHaveURL(new RegExp(`#${id}$`));
        await expect(page.locator(`#${id}`)).toBeVisible();
      });
    }
  });

  test("Sign-up page shows every required field", async ({ page }) => {
    await openPage(page, "/signup", /create|sign ?up|account/i);
    await check("Email field", async () => { await expect(page.getByLabel("Email")).toBeVisible(); });
    await check("Password and Confirm password fields", async () => {
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Confirm password")).toBeVisible();
    });
    await check("Terms and Privacy checkboxes are unchecked by default", async () => {
      await expect(page.locator("#acceptedTerms")).not.toBeChecked();
      await expect(page.locator("#acceptedPrivacy")).not.toBeChecked();
    });
    await check("Link back to Log in", async () => {
      await expect(page.getByRole("link", { name: /log in/i }).first()).toBeVisible();
    });
  });

  test("Sign-up rejects a weak or mismatched password before creating anything", async ({ page }) => {
    await page.goto("/signup");
    await check("Fill form with mismatched passwords and accept terms", async () => {
      await page.getByLabel("Email").fill("e2e-validation-only@example.invalid");
      await page.getByLabel("Password", { exact: true }).fill("Abcdef1!ghij");
      await page.getByLabel("Confirm password").fill("Different1!xyz");
      await page.locator("#acceptedTerms").check();
      await page.locator("#acceptedPrivacy").check();
    });
    await check("Submitting shows an error and does not leave /signup", async () => {
      await page.getByRole("button", { name: /create|sign ?up/i }).last().click();
      await expect(page.locator("p[role=alert]")).toBeVisible();
      await expect(page).toHaveURL(/\/signup/);
    });
  });

  test("Forgot-password page loads with an email field", async ({ page }) => {
    await openPage(page, "/reset-password", /reset|forgot|password/i);
    await check("Email input and a submit button exist", async () => {
      await expect(page.getByLabel("Email")).toBeVisible();
      await expect(page.getByRole("button").last()).toBeVisible();
    });
  });

  test("Unknown URL returns a proper 404 page, not a crash", async ({ page }) => {
    await check("GET /this-page-does-not-exist is 404", async () => {
      const res = await page.goto("/this-page-does-not-exist");
      expect(res!.status()).toBe(404);
    });
    await check("The 404 page is rendered (not a blank/white screen)", async () => {
      await expect(page.locator("body")).not.toBeEmpty();
    });
  });

  test("Staff login page is reachable and separate from the parent login", async ({ page }) => {
    await openPage(page, "/staff/login", /staff|log ?in|sign ?in/i);
    await check("Staff page is a different page from the parent login", async () => {
      expect(page.url()).toContain("/staff/login");
    });
  });
});
