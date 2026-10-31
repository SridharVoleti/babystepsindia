import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { check, EMAIL, PASSWORD, loginThroughForm } from "./helpers";

setup("Sign in as the test parent (setup for all signed-in tests)", async ({ page }) => {
  await check("Credentials are configured in .env.e2e.local", async () => {
    expect(EMAIL, "E2E_EMAIL").not.toBe("");
    expect(PASSWORD, "E2E_PASSWORD").not.toBe("");
  });
  await loginThroughForm(page);
  mkdirSync("e2e/.auth", { recursive: true });
  await page.context().storageState({ path: "e2e/.auth/parent.json" });
});
