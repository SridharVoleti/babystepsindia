import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ROUTE_AUTHORIZATION } from "@/lib/authorization/route-actions";
import { LEARNER_LAUNCHER_API_CONTRACTS } from "@/lib/learner-home/api-contracts";

const source = fs.readFileSync("src/lib/learner-home/refresh-controller.ts", "utf8");

describe("UL-003 frozen refresh architecture", () => {
  it("declares the four V49 launcher contracts and canonical internal actions", () => {
    expect(Object.values(LEARNER_LAUNCHER_API_CONTRACTS).map((contract) => contract.id))
      .toEqual(["API-UL-001", "API-UL-002", "API-UL-009", "API-UL-010"]);
    const resolve = (path: string) => API_ROUTE_AUTHORIZATION.find((rule) => rule.pattern.test(path))?.methods.POST;
    expect(resolve("/v1/internal/learner-launcher/invalidate")).toBe("service.launcher.invalidate");
    expect(resolve("/v1/internal/learner-launcher/reconcile-freshness"))
      .toBe("service.launcher.reconcile_freshness");
  });

  it("contains no continuous polling, heartbeat, persistent connection or realtime subscription", () => {
    expect(source).not.toMatch(/setInterval|WebSocket|EventSource|Supabase\s+Realtime|backgroundSync|heartbeat/i);
    expect(source).toContain("scheduleBoundary");
    expect(source).toContain("this.boundaryTimer = null");
  });

  it("keeps same-browser messages metadata-only", () => {
    expect(source).toContain("contextGeneration");
    expect(source).toContain("sourceVersion");
    expect(source).not.toMatch(/accessToken|resumeCredential|paymentMethod|progressSummary/);
  });
});
