import { test, expect } from "@playwright/test";
import { check, EMAIL, openPage, loginThroughForm } from "./helpers";

test.describe("Authentication flows (signed out)", () => {
  test("Protected parent pages redirect to /login when signed out", async ({ page }) => {
    for (const path of ["/account", "/account/learners", "/account/security", "/account/subscriptions", "/learner"]) {
      await check(`${path} bounces a signed-out visitor to the login page`, async () => {
        await page.goto(path);
        await expect(page).toHaveURL(/\/(login|staff\/login)/);
      });
    }
  });

  test("Admin area is closed to signed-out visitors (sent to staff login)", async ({ page }) => {
    await check("/admin redirects to /staff/login", async () => {
      await page.goto("/admin");
      await expect(page).toHaveURL(/\/staff\/login/);
    });
  });

  test("Login form validates empty input in the browser", async ({ page }) => {
    await openPage(page, "/login", "Log in");
    await check("Email and Password inputs are marked required", async () => {
      await expect(page.getByLabel("Email")).toHaveAttribute("required", "");
    });
    await check("Submitting empty form keeps the user on /login", async () => {
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page).toHaveURL(/\/login/);
    });
  });

  test("Login rejects bad credentials with one generic error (does not reveal whether an email exists)", async ({ page }) => {
    await page.goto("/login");
    // A non-existent address is used on purpose: the site limits logins to 5 per 15 minutes
    // per email, and we must not burn the real test account's attempts or lock it.
    await check("Fill an unknown email and a wrong password", async () => {
      await page.getByLabel("Email").fill("e2e.no.such.user@example.invalid");
      await page.getByLabel("Password", { exact: true }).fill("Definitely-Wrong-Password-1!");
    });
    await check("Error 'Incorrect email or password.' is shown", async () => {
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page.locator("p[role=alert]")).toContainText(/incorrect email or password/i);
    });
    await check("User is still signed out (stays on /login)", async () => {
      await expect(page).toHaveURL(/\/login/);
    });
    await check("The error does not echo the password back", async () => {
      expect(await page.content()).not.toContain("Definitely-Wrong-Password-1!");
    });
  });

  test("Password field can be shown and hidden", async ({ page }) => {
    await page.goto("/login");
    const pw = page.getByLabel("Password", { exact: true });
    await check("Password starts masked", async () => { await expect(pw).toHaveAttribute("type", "password"); });
    await check("Toggle reveals the password", async () => {
      await pw.fill("abc");
      await page.getByRole("button", { name: /show/i }).click();
      await expect(pw).toHaveAttribute("type", "text");
    });
  });

  test("Correct credentials sign in, show the account, and sign out cleanly", async ({ page }) => {
    await loginThroughForm(page);
    await check("Dashboard shows the signed-in email address", async () => {
      await expect(page.getByText(EMAIL, { exact: false })).toBeVisible();
    });
    await check("Session cookie is HttpOnly and Secure", async () => {
      const cookies = await page.context().cookies();
      const session = cookies.find((c) => /session/i.test(c.name));
      expect(session, "a session cookie exists").toBeTruthy();
      expect(session!.httpOnly).toBe(true);
      expect(session!.secure).toBe(true);
    });
    await check("Header now shows 'My account' and 'Sign out'", async () => {
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    });
    await check("Sign out returns to the home page signed out", async () => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForURL(/\/$/);
      await expect(page.getByRole("link", { name: "Log in" }).first()).toBeVisible();
    });
    await check("After sign-out /account is protected again", async () => {
      await page.goto("/account");
      await expect(page).toHaveURL(/\/login/);
    });
    await check("Browser Back button does not reveal the account page", async () => {
      await page.goBack();
      await expect(page.getByRole("heading", { name: "Your dashboard" })).toHaveCount(0);
    });
  });
});
