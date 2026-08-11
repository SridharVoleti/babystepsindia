import { randomUUID } from "node:crypto";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import {
  beginDeploymentOperation,
  checkDeploymentIdempotency,
  completeDeploymentOperation,
} from "@/lib/deployment-pipeline/idempotency";
import { getRelease } from "@/lib/deployment-release/service";
import { getLatestDeployment } from "@/lib/deployment-staging/service";
import { approveProduction } from "@/lib/deployment-production/service";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";

// AR-002 session 2, business rules 50-60: the real pre-scheduled
// app-specific production window. AU-001 built an earlier, narrower
// admin-notice scaffold (src/lib/authorization/deployment-service.ts,
// operating on app_deployment_launch_controls only, keyed by an existing
// deploymentId rather than a release-to-be-promoted) that is intentionally
// left untouched here — its own acceptance suite
// (tests/au-001.acceptance.test.ts AC44) locks its five actions and
// mutateDeployment's implementation in place. This module is the
// authoritative one: it is what approveProduction (deployment-production/
// service.ts) now requires a window from, and it is the one that projects
// drain/window-end timing onto the currently published
// app_deployment_launch_controls row so the existing dispatch-block read
// path (src/lib/app-launch/deployment.ts::resolveTrustedDeployment) keeps
// working unchanged — same "derived projection" pattern session 1 used for
// publish.
export const LEAD_TIME_MS = 60 * 60 * 1000;
const NON_FINAL_STATUSES = ["scheduled", "draining", "executing", "extended_safe_block"] as const;

type WindowRow = {
  id: string;
  app_id: string;
  release_id: string;
  starts_at: string;
  ends_at: string;
  drain_starts_at: string;
  status: "scheduled" | "draining" | "executing" | "completed" | "cancelled" | "failed" | "extended_safe_block";
  failure_code: string | null;
  created_by_admin_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type DeploymentWindowView = {
  id: string;
  appId: string;
  releaseId: string;
  startsAt: string;
  endsAt: string;
  drainStartsAt: string;
  status: WindowRow["status"];
  failureCode: string | null;
  createdByAdminId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

function toView(row: WindowRow): DeploymentWindowView {
  return {
    id: row.id,
    appId: row.app_id,
    releaseId: row.release_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    drainStartsAt: row.drain_starts_at,
    status: row.status,
    failureCode: row.failure_code,
    createdByAdminId: row.created_by_admin_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function requireActiveApp(appId: string) {
  try {
    return assertAppOperational(appId);
  } catch (error) {
    if (error instanceof AppRegistryError) throw new DeploymentPipelineError(error.code);
    throw error;
  }
}

function row(windowId: string): WindowRow | undefined {
  return getDb().prepare("select * from app_deployment_windows where id = ?").get(windowId) as WindowRow | undefined;
}

export function getWindow(windowId: string): DeploymentWindowView | null {
  const found = row(windowId);
  return found ? toView(found) : null;
}

export function listWindows(appId: string): DeploymentWindowView[] {
  const rows = getDb()
    .prepare("select * from app_deployment_windows where app_id = ? order by created_at desc")
    .all(appId) as WindowRow[];
  return rows.map(toView);
}

function activeWindow(appId: string): WindowRow | undefined {
  return getDb()
    .prepare(
      `select * from app_deployment_windows where app_id = ? and status in (${NON_FINAL_STATUSES.map(() => "?").join(",")})
       order by created_at desc limit 1`,
    )
    .get(appId, ...NON_FINAL_STATUSES) as WindowRow | undefined;
}

// Session 1's production-publish upserts one app_deployment_launch_controls
// row per new deployment_id, keeping the currently published row's status
// 'published' until superseded. Drain/window-end timing lives on that
// currently published row — that's what resolveTrustedDeployment reads for
// an already-started session's dispatch, and what a future session-start
// path (not yet built — see README) would read for AC39/52's new-start
// block.
function projectOntoPublishedDeployment(appId: string, environment: string, drainStartsAt: string | null, endsAt: string | null, now: string) {
  // Every historical deployment keeps its own 'published' row in
  // app_deployment_launch_controls forever (a superseding publish only
  // ever inserts a new row, never flips an older one — see
  // deployment-production/service.ts) so an existing session bound to an
  // older deployment stays dispatchable after a newer release ships (AC25).
  // Drain/window timing must therefore target only the one deployment_id
  // the current publication pointer actually names, not every row that
  // happens to still say 'published'.
  const db = getDb();
  const publication = db
    .prepare("select current_published_deployment_id from app_environment_publications where app_id = ? and environment = ?")
    .get(appId, environment) as { current_published_deployment_id: string | null } | undefined;
  if (!publication?.current_published_deployment_id) return;
  db.prepare(
    "update app_deployment_launch_controls set drain_starts_at = ?, deployment_window_ends_at = ?, version = version + 1, updated_at = ? where deployment_id = ?",
  ).run(drainStartsAt, endsAt, now, publication.current_published_deployment_id);
}

function requireVerifiedStagedRelease(appId: string, releaseId: string) {
  const release = getRelease(releaseId);
  if (!release || release.appId !== appId) throw new DeploymentPipelineError("RELEASE_NOT_FOUND");
  if (release.status !== "verified") throw new DeploymentPipelineError("RELEASE_NOT_VERIFIED");
  const staging = getLatestDeployment(appId, releaseId, "staging");
  if (!staging || staging.status !== "published") throw new DeploymentPipelineError("RELEASE_NOT_VERIFIED");
}

export type ScheduleWindowInput = {
  appId: string;
  releaseId: string;
  startsAt: Date;
  endsAt: Date;
  adminUserId: string;
  idempotencyKey: string;
};

// AT-AR-002-38: production promotion requires a window scheduled at least
// 60 minutes ahead (rule 51). Only one non-final window per app at a time
// (enforced here in-transaction and by the partial unique index as a
// last-resort DB guarantee).
export function scheduleDeploymentWindow(input: ScheduleWindowInput, now: Date): DeploymentWindowView {
  requireActiveApp(input.appId);
  requireVerifiedStagedRelease(input.appId, input.releaseId);
  if (input.endsAt.getTime() <= input.startsAt.getTime()) throw new DeploymentPipelineError("INVALID_REQUEST");
  if (input.startsAt.getTime() - now.getTime() < LEAD_TIME_MS) {
    throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_LEAD_TIME_REQUIRED");
  }

  const hash = computeRequestHash({
    appId: input.appId,
    releaseId: input.releaseId,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
  });
  const cached = checkDeploymentIdempotency<DeploymentWindowView>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  const db = getDb();
  const run = db.transaction(() => {
    beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      operation: "schedule_window",
      hash,
    });
    if (activeWindow(input.appId)) throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_CONFLICT");

    const id = randomUUID();
    const nowIso = now.toISOString();
    const startsAtIso = input.startsAt.toISOString();
    const endsAtIso = input.endsAt.toISOString();
    const drainStartsAt = new Date(input.startsAt.getTime() - LEAD_TIME_MS).toISOString();
    db.prepare(
      `insert into app_deployment_windows
       (id, app_id, release_id, starts_at, ends_at, drain_starts_at, status, created_by_admin_id, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'scheduled', ?, 1, ?, ?)`,
    ).run(id, input.appId, input.releaseId, startsAtIso, endsAtIso, drainStartsAt, input.adminUserId, nowIso, nowIso);

    projectOntoPublishedDeployment(input.appId, "production", drainStartsAt, endsAtIso, nowIso);

    const view = toView(row(id)!);
    completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: view });
    return view;
  });
  return run();
}

export type RescheduleWindowInput = {
  windowId: string;
  startsAt: Date;
  endsAt: Date;
  expectedVersion: number;
  adminUserId: string;
  idempotencyKey: string;
};

export function rescheduleDeploymentWindow(input: RescheduleWindowInput, now: Date): DeploymentWindowView {
  const existing = row(input.windowId);
  if (!existing) throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_FOUND");
  requireActiveApp(existing.app_id);
  if (existing.status !== "scheduled") throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");
  if (input.endsAt.getTime() <= input.startsAt.getTime()) throw new DeploymentPipelineError("INVALID_REQUEST");
  if (input.startsAt.getTime() - now.getTime() < LEAD_TIME_MS) {
    throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_LEAD_TIME_REQUIRED");
  }

  const hash = computeRequestHash({
    windowId: input.windowId,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
    expectedVersion: input.expectedVersion,
  });
  const cached = checkDeploymentIdempotency<DeploymentWindowView>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  const db = getDb();
  const run = db.transaction(() => {
    beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: existing.app_id,
      idempotencyKey: input.idempotencyKey,
      operation: "reschedule_window",
      hash,
    });
    const current = row(input.windowId)!;
    if (current.version !== input.expectedVersion) throw new DeploymentPipelineError("DEPLOYMENT_VERSION_CONFLICT");
    if (current.status !== "scheduled") throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");

    const nowIso = now.toISOString();
    const startsAtIso = input.startsAt.toISOString();
    const endsAtIso = input.endsAt.toISOString();
    const drainStartsAt = new Date(input.startsAt.getTime() - LEAD_TIME_MS).toISOString();
    db.prepare(
      `update app_deployment_windows set starts_at = ?, ends_at = ?, drain_starts_at = ?, version = version + 1, updated_at = ?
       where id = ? and version = ?`,
    ).run(startsAtIso, endsAtIso, drainStartsAt, nowIso, input.windowId, input.expectedVersion);

    projectOntoPublishedDeployment(current.app_id, "production", drainStartsAt, endsAtIso, nowIso);

    const view = toView(row(input.windowId)!);
    completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: view });
    return view;
  });
  return run();
}

export type CancelWindowInput
 = { windowId: string; expectedVersion: number; adminUserId: string; idempotencyKey: string };

export function cancelDeploymentWindow(input: CancelWindowInput, now: Date): DeploymentWindowView {
  const existing = row(input.windowId);
  if (!existing) throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_FOUND");
  requireActiveApp(existing.app_id);
  if (existing.status !== "scheduled" && existing.status !== "draining") {
    throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");
  }

  const hash = computeRequestHash({ windowId: input.windowId, expectedVersion: input.expectedVersion, action: "cancel" });
  const cached = checkDeploymentIdempotency<DeploymentWindowView>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  const db = getDb();
  const run = db.transaction(() => {
    beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: existing.app_id,
      idempotencyKey: input.idempotencyKey,
      operation: "cancel_window",
      hash,
    });
    const current = row(input.windowId)!;
    if (current.version !== input.expectedVersion) throw new DeploymentPipelineError("DEPLOYMENT_VERSION_CONFLICT");
    if (current.status !== "scheduled" && current.status !== "draining") {
      throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");
    }

    const nowIso = now.toISOString();
    db.prepare(
      "update app_deployment_windows set status = 'cancelled', completed_at = ?, version = version + 1, updated_at = ? where id = ? and version = ?",
    ).run(nowIso, nowIso, input.windowId, input.expectedVersion);
    projectOntoPublishedDeployment(current.app_id, "production", null, null, nowIso);

    const view = toView(row(input.windowId)!);
    completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: view });
    return view;
  });
  return run();
}

// AT-AR-002-41/42 (business rules 55, 58): at starts_at the pipeline must
// confirm zero starting/active/disconnected sessions for the app before
// deploying; if any remain, it postpones without deploying. If the window
// overruns ends_at without a completed publish, blocking stays fail-closed
// (extended_safe_block) rather than lapsing back to unblocked. This is the
// scheduled entry point — same "restart-safe, state lives in the row, not
// memory" shape as SC-003's sweepExpiredStartReservations.
export async function sweepDeploymentWindows(now: Date, provider: DeploymentProvider): Promise<void> {
  const due = getDb()
    .prepare(
      `select * from app_deployment_windows where status in ('scheduled','draining','executing','extended_safe_block')
       and starts_at <= ? order by starts_at asc`,
    )
    .all(now.toISOString()) as WindowRow[];
  for (const current of due) {
    await processDueWindow(current, now, provider);
  }
}

async function processDueWindow(current: WindowRow, now: Date, provider: DeploymentProvider) {
  const db = getDb();
  const overrun = now.getTime() >= new Date(current.ends_at).getTime();

  const reserved = db
    .prepare(
      `select 1 from learner_sessions where app_id = ? and deployment_environment = 'production'
       and status in ('starting','active','disconnected','resumable') limit 1`,
    )
    .get(current.app_id);
  if (reserved) {
    db.prepare("update app_deployment_windows set status = ?, failure_code = ?, version = version + 1, updated_at = ? where id = ? and version = ?")
      .run(overrun ? "extended_safe_block" : "draining", "DEPLOYMENT_SESSIONS_ACTIVE", now.toISOString(), current.id, current.version);
    return;
  }

  db.prepare("update app_deployment_windows set status = 'executing', version = version + 1, updated_at = ? where id = ? and version = ?")
    .run(now.toISOString(), current.id, current.version);

  try {
    // approveProduction itself marks the window 'completed' on success
    // (deployment-production/service.ts) — that keeps a manual admin
    // approval via the approve-production route equally authoritative,
    // rather than only the sweep knowing how to close out a window.
    await approveProduction(
      {
        appId: current.app_id,
        releaseId: current.release_id,
        adminUserId: current.created_by_admin_id,
        // Stable per-window key: a retried sweep tick for the same window
        // before its status changes returns the cached result rather than
        // re-attempting the provider call.
        idempotencyKey: `window-${current.id}`,
        deploymentWindowId: current.id,
      },
      provider,
      now,
    );
  } catch (error) {
    const code = error instanceof DeploymentPipelineError ? error.code : "PRODUCTION_VALIDATION_FAILED";
    db.prepare("update app_deployment_windows set status = ?, failure_code = ?, version = version + 1, updated_at = ? where id = ?")
      .run(overrun ? "extended_safe_block" : "failed", code, now.toISOString(), current.id);
  }
}
