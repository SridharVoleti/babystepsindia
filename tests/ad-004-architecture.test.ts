import fs from "node:fs";
import { describe, expect, it } from "vitest";

const serviceSource = fs.readFileSync("src/lib/operations-admin/service.ts", "utf8");
const contractsSource = fs.readFileSync("src/lib/operations-admin/contracts.ts", "utf8");

describe("AD-004 frozen architecture", () => {
  it("no generic SQL/JSON/env-var/URL editor exists anywhere in the operations-admin module", () => {
    for (const source of [serviceSource, contractsSource]) {
      expect(source).not.toMatch(/exec\s*\(|\.raw\s*\(|dangerouslySetInnerHTML/i);
      expect(source).not.toMatch(/process\.env\[[^\]]*(req|body|input|params)/i);
    }
    expect(fs.existsSync("src/app/admin/operations/sql")).toBe(false);
    expect(fs.existsSync("src/app/admin/operations/config")).toBe(false);
  });

  it("no provider secret (API key/token/credential value) is ever read, echoed, or stored by this module", () => {
    for (const source of [serviceSource, contractsSource]) {
      expect(source).not.toMatch(/api[_-]?key|client[_-]?secret|access[_-]?token|credential.?value/i);
    }
  });

  it("no AU-004 machine-credential admin UI or route exists — AD-004 only reserves the change types for future use", () => {
    expect(fs.existsSync("src/app/admin/machine-identity")).toBe(false);
    expect(fs.existsSync("src/app/v1/admin/machine-identity")).toBe(false);
    expect(contractsSource).toMatch(/machine_principal_change/);
    expect(contractsSource).toMatch(/machine_credential_change/);
  });

  it("the operations admin pages, if present, are plain server components with no client-side polling", () => {
    const candidates = [
      "src/app/admin/operations/page.tsx",
      "src/app/admin/operations/changes/page.tsx",
      "src/app/admin/operations/changes/[operationChangeId]/page.tsx",
    ];
    for (const page of candidates) {
      if (!fs.existsSync(page)) continue;
      const source = fs.readFileSync(page, "utf8");
      expect(source).not.toMatch(/setInterval|setTimeout|EventSource|WebSocket/);
    }
  });

  it("no dual-approval / second-signoff engine exists — a single accountable actor records the change and its outcome", () => {
    for (const source of [serviceSource, contractsSource]) {
      expect(source).not.toMatch(/approv(al|er)|co-sign|second.?signoff|dual.?control/i);
    }
  });

  it("the operations-admin module never composes a second billing, app-registry, deployment, or availability state machine of its own", () => {
    expect(serviceSource).not.toMatch(/update\s+subscriptions\s+set/i);
    expect(serviceSource).not.toMatch(/update\s+app_registry\s+set/i);
    expect(serviceSource).not.toMatch(/update\s+app_deployments\s+set/i);
    expect(serviceSource).not.toMatch(/update\s+app_availability\s+set/i);
  });
});
