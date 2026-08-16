import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminApi: vi.fn<() => Promise<{ ok: true; session: { sub: string; email: string }; principal: object } |
    { ok: false; response: unknown }>>(async () => ({
    ok: true,
    session: { sub: "admin-1", email: "admin@example.com" },
    principal: {},
  })),
  requireReauth: vi.fn<() => Response | null>(() => null),
  checkRateLimit: vi.fn(() => true),
}));

vi.mock("@/lib/auth/admin-api-guard", () => ({
  requireAdminApi: mocks.requireAdminApi,
  requireReauth: mocks.requireReauth,
}));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";
import { computeCanonicalStateHash, validateProgressIntegrity } from "@/lib/progress-integrity/service";
import { GET as getIncident } from "@/app/v1/admin/progress-integrity-incidents/[incidentId]/route";
import { POST as postIncidentAction } from "@/app/v1/admin/progress-integrity-incidents/[incidentId]/action/route";
import { GET as getHealth } from "@/app/v1/admin/apps/[appId]/progress-integrity-health/route";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";

const now = new Date("2026-08-10T10:00:00.000Z");
const appId = "app-1";
const environment = "production";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireReauth.mockReturnValue(null);
  mocks.checkRateLimit.mockReturnValue(true);
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
  const adminId = ensureBootstrapPlatformAdmin(now);
  mocks.requireAdminApi.mockResolvedValue({ ok: true, session: { sub: adminId, email: "admin@example.com" }, principal: {} });
});

async function corruptIncidentFixture() {
  const { user } = await sqliteAuthAdapter.signUp(`pr004route-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09").learner;
  registerProgressSchema({ appId, releaseId: "release-1", schemaVersion: 1,
    schemaJson: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }), now });
  const state = JSON.stringify({ level: "l1" });
  const badHash = computeCanonicalStateHash({ learnerId: learner.id, appId, environment, progressVersion: 1,
    schemaVersion: 1, serializedState: "not-the-real-state" });
  getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,progress_version,
    state_hash,updated_at) values(?,?,1,?,1,?,?)`).run(learner.id, appId, state, badHash, now.toISOString());
  const validation = validateProgressIntegrity({ learnerId: learner.id, appId, environment, reason: "read", now });
  return { learner, incidentId: validation.incidentId! };
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("PR-004 GET /v1/admin/progress-integrity-incidents/[incidentId]", () => {
  it("returns the safe incident view for an admin with the exact permission", async () => {
    const { incidentId } = await corruptIncidentFixture();
    const response = await getIncident(new Request("http://localhost"), { params: { incidentId } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.classification).toBe("unreadable_corrupt");
    expect(body.status).toBe("open");
  });

  it("returns 404 for an unknown incident", async () => {
    const response = await getIncident(new Request("http://localhost"), { params: { incidentId: "missing" } });
    expect(response.status).toBe(404);
  });

  it("returns the guard's response when the admin lacks the permission", async () => {
    mocks.requireAdminApi.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }) });
    const response = await getIncident(new Request("http://localhost"), { params: { incidentId: "x" } });
    expect(response.status).toBe(403);
  });
});

describe("PR-004 POST /v1/admin/progress-integrity-incidents/[incidentId]/action", () => {
  it("applies revalidate with a valid body and reauth", async () => {
    const { incidentId } = await corruptIncidentFixture();
    const response = await postIncidentAction(
      jsonRequest("http://localhost", { action: "revalidate", expectedVersion: 1, idempotencyKey: "k1", currentPassword: "x" }),
      { params: { incidentId } },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBe("applied");
    expect(body.resultCode).toBe("REVALIDATION_STILL_BLOCKED");
  });

  it("rejects reauth failure before touching the incident", async () => {
    const { incidentId } = await corruptIncidentFixture();
    mocks.requireReauth.mockReturnValueOnce(NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 }));
    const response = await postIncidentAction(
      jsonRequest("http://localhost", { action: "revalidate", expectedVersion: 1, idempotencyKey: "k1", currentPassword: "wrong" }),
      { params: { incidentId } },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "REAUTHENTICATION_REQUIRED" });
  });

  it("rate-limits repeated action calls", async () => {
    const { incidentId } = await corruptIncidentFixture();
    mocks.checkRateLimit.mockReturnValueOnce(false);
    const response = await postIncidentAction(
      jsonRequest("http://localhost", { action: "revalidate", expectedVersion: 1, idempotencyKey: "k1", currentPassword: "x" }),
      { params: { incidentId } },
    );
    expect(response.status).toBe(429);
  });

  it("rejects an unknown action name before reaching the service", async () => {
    const { incidentId } = await corruptIncidentFixture();
    const response = await postIncidentAction(
      jsonRequest("http://localhost", { action: "delete_progress", expectedVersion: 1, idempotencyKey: "k1", currentPassword: "x" }),
      { params: { incidentId } },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "INVALID_REQUEST" });
  });

  it("maps PROGRESS_INTEGRITY_INCIDENT_VERSION_CONFLICT to 409", async () => {
    const { incidentId } = await corruptIncidentFixture();
    const response = await postIncidentAction(
      jsonRequest("http://localhost", { action: "revalidate", expectedVersion: 999, idempotencyKey: "k1", currentPassword: "x" }),
      { params: { incidentId } },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "PROGRESS_INTEGRITY_INCIDENT_VERSION_CONFLICT" });
  });
});

describe("PR-004 GET /v1/admin/apps/[appId]/progress-integrity-health", () => {
  it("returns aggregate health counts", async () => {
    await corruptIncidentFixture();
    const response = await getHealth(new Request(`http://localhost?environment=${environment}`), { params: { appId } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.openIncidentCount).toBe(1);
    expect(body.countsByStatus.open).toBe(1);
  });
});
