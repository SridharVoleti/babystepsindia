import fs from "node:fs";
import { describe, expect, it } from "vitest";

const schemaSource = fs.readFileSync("src/lib/db/schema.sql", "utf8");
const consentSource = fs.readFileSync("src/lib/db/consent.ts", "utf8");

describe("PC-002 frozen architecture", () => {
  it("no per-app/per-provider consent table exists — consent_records is the one canonical consent table", () => {
    expect(schemaSource).not.toMatch(/create table if not exists\s+(app_consent|consent_apps|per_app_consent|provider_consent)\b/i);
  });

  it("no per-app consent route exists anywhere under /v1", () => {
    expect(fs.existsSync("src/app/v1/parent/consent/apps")).toBe(false);
    expect(fs.existsSync("src/app/v1/billing/apps-consent")).toBe(false);
  });

  it("the processing-envelope check is parent-scoped, never app-scoped — the same grant covers every subscribed app", () => {
    expect(consentSource).not.toMatch(/hasCurrentProcessingEnvelopeConsent\([^)]*appId/i);
  });
});
