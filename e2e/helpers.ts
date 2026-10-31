import { expect, test, type Page } from "@playwright/test";

export const EMAIL = process.env.E2E_EMAIL ?? "";
export const PASSWORD = process.env.E2E_PASSWORD ?? "";
export const ALLOW_WRITES = process.env.E2E_ALLOW_WRITES === "1";

/** One named, visible verification. Shows up live in the console as a ✔/✘ line. */
export async function check<T>(description: string, fn: () => Promise<T> | T): Promise<T> {
  return test.step(description, async () => await fn());
}

/** Navigate and verify the page really loaded: HTTP status < 400, no Next error overlay, heading present. */
export async function openPage(page: Page, path: string, heading: string | RegExp) {
  await check(`Open ${path}`, async () => {
    const res = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(res, "navigation produced a response").not.toBeNull();
    expect(res!.status(), `HTTP status for ${path}`).toBeLessThan(400);
  });
  await check(`Heading "${heading}" is visible`, async () => {
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  });
  await check("No application error message on the page", async () => {
    await expect(page.getByText(/application error|something went wrong|internal server error/i)).toHaveCount(0);
  });
}

/** Collect browser console errors and failed first-party requests for the duration of a test. */
export function watchForErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 500 && r.url().startsWith(process.env.E2E_BASE_URL ?? "https://www.babystepsindia.com")) {
      errors.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });
  return {
    async assertClean() {
      await check("No JavaScript errors or 5xx responses during this test", async () => {
        expect(errors, errors.join("\n")).toEqual([]);
      });
    },
  };
}

/**
 * Sign in through the real login form. The site allows 5 attempts per 15 minutes per email,
 * so a lockout is detected and reported plainly instead of timing out.
 */
export async function loginThroughForm(page: Page) {
  await page.goto("/login");
  await check("Fill email and password", async () => {
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  });
  await check("Submit and land on the parent dashboard (/account)", async () => {
    await page.getByRole("button", { name: "Log in" }).click();
    const outcome = await Promise.race([
      page.waitForURL("**/account", { timeout: 30_000 }).then(() => "ok" as const),
      page.locator("p[role=alert]").waitFor({ timeout: 30_000 }).then(() => "alert" as const),
    ]);
    if (outcome === "alert") {
      const msg = (await page.locator("p[role=alert]").innerText()).trim();
      throw new Error(/too many attempts/i.test(msg)
        ? `LOGIN RATE-LIMITED by the site (5 attempts / 15 min per email). Wait ~15 minutes and run again. Site said: "${msg}"`
        : `Login was rejected: "${msg}"`);
    }
    await expect(page.getByRole("heading", { name: "Your dashboard" })).toBeVisible();
  });
}

/** Enter learner mode for the first learner (or stay there if the session is already in it). */
export async function enterLearnerMode(page: Page) {
  await page.goto("/learner");
  if (!/\/learner$/.test(page.url())) {
    await page.goto("/account/learners");
    await page.getByRole("link", { name: "Open learner" }).first().click();
    await page.waitForURL("**/learner", { timeout: 30_000 });
  }
  await page.waitForLoadState("networkidle");
}
