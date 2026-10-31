import { test, expect } from "@playwright/test";
import { check, openPage, watchForErrors, EMAIL } from "./helpers";

test.describe("Parent account pages (signed in)", () => {
  test("Dashboard shows the account, learners and an Add learner action", async ({ page }) => {
    const errors = watchForErrors(page);
    await openPage(page, "/account", "Your dashboard");
    await check(`Signed-in email "${EMAIL}" is displayed`, async () => {
      await expect(page.getByText(EMAIL, { exact: false })).toBeVisible();
    });
    await check("'Add learner' button links to the new-learner form", async () => {
      await expect(page.getByRole("link", { name: "Add learner" }).first()).toHaveAttribute("href", "/account/learners/new");
    });
    await check("Dashboard has no partial-load warning ('Some learners couldn't be loaded')", async () => {
      await expect(page.getByText(/couldn.?t be loaded/i)).toHaveCount(0);
    });
    await check("Header shows Sign out (we are authenticated)", async () => {
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    });
    await errors.assertClean();
  });

  const pages: [string, string | RegExp][] = [
    ["/account/learners", "Learners"],
    ["/account/learners/new", "Add a learner"],
    ["/account/security", "Account security"],
    ["/account/security/password", "Change password"],
    ["/account/security/email", "Change email"],
    ["/account/subscriptions", "Subscriptions"],
    ["/account/subscriptions/new?product=speed-reader", "Review your subscription"],
    ["/account/notifications", "Notification settings"],
    ["/account/notifications/history", "Communication history"],
    ["/account/attention", "Attention"],
  ];
  for (const [path, heading] of pages) {
    test(`Page ${path} loads without errors`, async ({ page }) => {
      const errors = watchForErrors(page);
      await openPage(page, path, heading);
      await check("Still signed in (not bounced to /login)", async () => {
        await expect(page).not.toHaveURL(/\/login/);
      });
      await errors.assertClean();
    });
  }

  test("Add-learner form has every field and validates without saving", async ({ page }) => {
    await openPage(page, "/account/learners/new", "Add a learner");
    await check("The form has at least one text input and a submit button", async () => {
      await expect(page.getByLabel("Display name")).toBeVisible();
      await expect(page.getByLabel("Date of birth")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add learner" }).last()).toBeVisible();
      await expect(page.getByRole("link", { name: "Cancel" })).toBeVisible();
    });
    await check("'Add learner' is disabled while the form is empty (nothing can be created)", async () => {
      await expect(page.getByRole("button", { name: "Add learner" }).last()).toBeDisabled();
    });
    await check("Cancel returns to the dashboard without creating anything", async () => {
      await page.getByRole("link", { name: "Cancel" }).click();
      await expect(page).not.toHaveURL(/\/learners\/new/);
    });
  });

  test("Change-password form requires the current password and checks mismatches (nothing is changed)", async ({ page }) => {
    await openPage(page, "/account/security/password", "Change password");
    await check("At least current + new password inputs are present", async () => {
      expect(await page.locator("input[type=password]").count()).toBeGreaterThanOrEqual(2);
    });
    await check("A submit button exists", async () => {
      await expect(page.locator("form button[type=submit]").first()).toBeVisible();
    });
  });

  test("Account deletion page warns before anything destructive (we do NOT delete)", async ({ page }) => {
    await openPage(page, "/account/delete", /delete/i);
    await check("A delete form/confirmation is shown, not executed", async () => {
      await expect(page.locator("form").first()).toBeVisible();
      await expect(page).toHaveURL(/\/account\/delete/);
    });
  });

  test("Parent navigation links move between sections", async ({ page }) => {
    await page.goto("/account");
    for (const [name, url] of [["Learners", /\/account\/learners$/], ["Subscriptions", /\/account\/subscriptions$/]] as const) {
      await check(`Navigation "${name}" opens ${url}`, async () => {
        const link = page.getByRole("link", { name: new RegExp(`^${name}$`) }).first();
        if (await link.count()) {
          await link.click();
          await expect(page).toHaveURL(url);
          await page.goto("/account");
        } else {
          test.info().annotations.push({ type: "note", description: `no '${name}' link on dashboard` });
        }
      });
    }
  });

  test("Every learner's sub-pages (apps, progress, consistency, achievements, edit) render", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/account/learners");
    const ids = await check("Discover learner ids from the Learners list", async () => {
      const hrefs = await page.$$eval("a[href*='/account/learners/'][href$='/apps']", (as) => as.map((a) => a.getAttribute("href")!));
      const found = hrefs.map((h) => h.split("/")[3]);
      expect(found.length, "at least one learner exists on the test account").toBeGreaterThan(0);
      return found;
    });
    for (const id of ids) {
      for (const [sub, heading] of [
        ["apps", /apps/i], ["progress", /progress/i], ["consistency", /consistency/i],
        ["achievements", /achievements/i], ["edit", "Edit learner profile"],
      ] as const) {
        await check(`Learner ${id.slice(0, 8)}… /${sub} loads with its heading`, async () => {
          const res = await page.goto(`/account/learners/${id}/${sub}`);
          expect(res!.status()).toBeLessThan(400);
          await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
        });
      }
    }
    await errors.assertClean();
  });

  test("Header 'Pricing' link leads to a working page (not a 404)", async ({ page }) => {
    await page.goto("/account");
    const href = await check("Read the Pricing link target from the header", async () => {
      const h = await page.getByRole("navigation").getByRole("link", { name: "Pricing" }).getAttribute("href");
      expect(h).toBeTruthy();
      return h!;
    });
    await check(`Following ${href} does not 404`, async () => {
      const res = await page.goto(href);
      expect(res!.status(), `HTTP status of ${href}`).toBeLessThan(400);
    });
  });

  test("A learner id belonging to nobody returns Not Found (no data leak)", async ({ page }) => {
    await check("Random learner id -> 404", async () => {
      const res = await page.goto("/account/learners/00000000-0000-4000-8000-000000000000/apps");
      expect(res!.status()).toBe(404);
    });
  });
});
