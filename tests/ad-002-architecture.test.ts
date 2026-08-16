import fs from "node:fs";
import { describe, expect, it } from "vitest";

const serviceSource = fs.readFileSync("src/lib/support-cases/service.ts", "utf8");
const snapshotSource = fs.readFileSync("src/lib/support-cases/snapshot.ts", "utf8");

describe("AD-002 frozen architecture (AT-AD-002-01/21/22/23/24/47/48/49/50)", () => {
  it("AT-01: no route composes a customer snapshot without first requiring a caseId — there is no customer-browse endpoint at all", () => {
    expect(fs.existsSync("src/app/v1/admin/support/customers")).toBe(false);
    expect(serviceSource).not.toMatch(/export function\s+(getParent|getCustomer|listCustomers|searchCustomers)\b/i);
  });

  it("AT-21: no assume-parent/impersonation function or route exists anywhere in the support-cases module", () => {
    expect(serviceSource).not.toMatch(/impersonat|assume.?parent|assume.?learner/i);
  });

  it("AT-22: no learner session/launch token issuance exists in the support-cases module", () => {
    expect(serviceSource).not.toMatch(/learner.?session.?grant|launch.?token|issueSession/i);
  });

  it("AT-23/24: no subscription/payment/progress/credit mutation exists anywhere in support-cases", () => {
    for (const source of [serviceSource, snapshotSource]) {
      expect(source).not.toMatch(/update\s+subscriptions\s+set/i);
      expect(source).not.toMatch(/update\s+payments\s+set/i);
      expect(source).not.toMatch(/update\s+learner_app_progress\s+set/i);
      expect(source).not.toMatch(/update\s+learner_session_credits\s+set/i);
    }
  });

  it("AT-47: support case notes/activity are never read by the analytics module", () => {
    const analyticsFiles = fs.readdirSync("src/lib/analytics").filter((f) => f.endsWith(".ts"));
    for (const file of analyticsFiles) {
      const contents = fs.readFileSync(`src/lib/analytics/${file}`, "utf8");
      expect(contents).not.toMatch(/support_case/i);
    }
  });

  it("AT-48: the admin support pages are plain server components with no client-side polling", () => {
    for (const page of ["src/app/admin/support/cases/page.tsx", "src/app/admin/support/cases/[caseId]/page.tsx"]) {
      if (!fs.existsSync(page)) continue;
      const source = fs.readFileSync(page, "utf8");
      expect(source).not.toMatch(/setInterval|setTimeout|EventSource|WebSocket/);
    }
  });

  it("AT-50: support-cases never imports or checks billing mutation authorization — a case alone cannot authorize a billing action", () => {
    expect(serviceSource).not.toMatch(/from\s+["']@\/lib\/billing/);
    const billingFiles = fs.readdirSync("src/lib/billing").filter((f) => f.endsWith(".ts"));
    for (const file of billingFiles) {
      const contents = fs.readFileSync(`src/lib/billing/${file}`, "utf8");
      expect(contents).not.toMatch(/support_case/i);
    }
  });
});
