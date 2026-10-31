import { test, expect } from "@playwright/test";
import { check, openPage } from "./helpers";

// The admin area needs a staff identity (password + passkey). The parent test account cannot
// enter it, so only its PUBLIC boundary can be verified here.
test.describe("Staff sign-in boundary (signed out)", () => {
  test("Staff sign-in page has its own fields and a recovery link", async ({ page }) => {
    await openPage(page, "/staff/login", "Staff sign in");
    await check("Staff email and password fields exist", async () => {
      await expect(page.locator("#staff-email")).toBeVisible();
      await expect(page.locator("#staff-password")).toBeVisible();
    });
    await check("'Recover account access' link points at /staff/recovery", async () => {
      await expect(page.getByRole("link", { name: "Recover account access" })).toHaveAttribute("href", "/staff/recovery");
    });
  });

  test("Staff sign-in refuses unknown credentials and stays out of /admin", async ({ page }) => {
    await page.goto("/staff/login");
    await check("Submit an unknown staff email and wrong password", async () => {
      await page.locator("#staff-email").fill("e2e.no.such.staff@example.invalid");
      await page.locator("#staff-password").fill("Wrong-Password-For-E2E-1!");
      await page.getByRole("button", { name: /sign in|continue|log in/i }).first().click();
    });
    await check("The user is still on /staff/login (not let in)", async () => {
      await page.waitForTimeout(2500);
      await expect(page).toHaveURL(/\/staff\/login/);
    });
    await check("/admin is still closed afterwards", async () => {
      await page.goto("/admin");
      await expect(page).toHaveURL(/\/staff\/login/);
    });
  });

  test("Staff recovery page loads", async ({ page }) => {
    await openPage(page, "/staff/recovery", /recover|recovery|access/i);
  });
});
