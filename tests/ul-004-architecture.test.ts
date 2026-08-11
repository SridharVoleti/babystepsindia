// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ROUTE_AUTHORIZATION } from "@/lib/authorization/route-actions";
import { APP_AVAILABILITY_API_CONTRACTS } from "@/lib/learner-home/api-contracts";
import { supabaseTableAccess } from "@/lib/db/access-boundaries";

const availabilitySource = fs.readFileSync("src/lib/app-availability/service.ts", "utf8");
const gatewaySource = fs.readFileSync("src/lib/learning-session/gateway.ts", "utf8");
const migration = fs.readFileSync("supabase/migrations/0053_ul004_app_availability.sql", "utf8");

describe("UL-004 frozen architecture", () => {
  it("declares API-UL-011 through API-UL-015 and canonical authorization actions", () => {
    expect(Object.values(APP_AVAILABILITY_API_CONTRACTS).map((contract) => contract.id))
      .toEqual(["API-UL-011", "API-UL-012", "API-UL-013", "API-UL-014", "API-UL-015"]);
    const action = (method: string, path: string) => API_ROUTE_AUTHORIZATION
      .find((rule) => rule.pattern.test(path))?.methods[method];
    expect(action("GET", "/v1/internal/apps/app-1/availability")).toBe("service.app_availability.read");
    expect(action("GET", "/v1/admin/apps/app-1/availability")).toBe("admin.app_availability.read");
    expect(action("POST", "/v1/admin/apps/app-1/maintenance-windows")).toBe("admin.app_availability.manage");
    expect(action("PATCH", "/v1/admin/apps/app-1/maintenance-windows/window-1")).toBe("admin.app_availability.manage");
    expect(action("POST", "/v1/admin/apps/app-1/availability-transition")).toBe("admin.app_availability.manage");
  });

  it("checks availability before every Start funding or reservation mutation", () => {
    const gate = gatewaySource.indexOf("assertStartAvailability(");
    expect(gate).toBeGreaterThan(0);
    for (const mutation of ["releaseStartReservation(", "fundStandardSession(", "reserveTechnicalCredit(",
      "insert into session_start_requests", "insert into learner_sessions"]) {
      expect(gatewaySource.indexOf(mutation, gate)).toBeGreaterThan(gate);
    }
  });

  it("creates bounded operational tables with server-only access", () => {
    for (const table of ["app_launch_availability", "app_maintenance_windows",
      "app_availability_mutation_receipts", "app_availability_events"] as const) {
      expect(migration).toContain(`create table ${table}`);
      expect(supabaseTableAccess[table]).toBe("server_only");
    }
    expect(migration).not.toMatch(/learner_id|progress_json|payment_method|availability_sla|health_probe/i);
  });

  it("contains no continuous health polling, automatic restore, realtime, or retirement workflow", () => {
    expect(availabilitySource).not.toMatch(/setInterval|WebSocket|EventSource|Supabase\s+Realtime|healthProbe|autoRestore|retireApp/i);
    expect(availabilitySource).toContain("SAFE_START_SECONDS = 3_900");
  });
});
