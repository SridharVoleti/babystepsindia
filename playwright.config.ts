import { defineConfig, devices } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";

// Tiny .env loader so the suite needs no extra dependency.
const envFile = ".env.e2e.local";
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const headless = process.env.E2E_HEADLESS === "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1, // one browser at a time so the run is watchable and ordered
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["./e2e/live-reporter.ts"], ["html", { outputFolder: "e2e-report", open: "never" }]],
  outputDir: "e2e-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://www.babystepsindia.com",
    headless,
    viewport: { width: 1360, height: 860 },
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? 350) },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "public", testMatch: /1\d-.*\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } },
    // Runs after the public tests so their login/sign-out cannot invalidate the shared session.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "signed-in",
      testMatch: /[2-9]\d-.*\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 }, storageState: "e2e/.auth/parent.json" },
    },
  ],
});
