import { randomUUID } from "node:crypto";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
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
// Configurable via DEPLOYMENT_WINDOW_LEAD_TIME_MINUTES so a pre-launch
// environment (no live sessions to protect yet) can shorten the lead time
// for faster iteration; unset/invalid falls back to the real 60-minute
// production safety window this rule exists for. Leave the env var unset
// once real learner sessions exist — the lead time IS the drain grace
// period an in-progress session gets before a production swap.
function resolveLeadTimeMs(): number {
  const minutes = Number(process.env.DEPLOYMENT_WINDOW_LEAD_TIME_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 60 * 1000;
}
export const LEAD_TIME_MS = resolveLeadTimeMs();
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

async function requireActiveApp(appId: string) {
  try {
    return await assertAppOperational(appId);
  } catch (error) {
    if (error instanceof AppRegistryError) throw new DeploymentPipelineError(error.code);
    throw error;
  }
}

async function row(windowId: string): Promise<WindowRow | undefined> {
  return resolveDbClient().get<WindowRow>("select * from app_deployment_windows where id = ?", [windowId]);
}

export async function getWindow(windowId: string): Promise<DeploymentWindowView | null> {
  const found = await row(windowId);
  return found ? toView(found) : null;
}

export async function listWindows(appId: string): Promise<DeploymentWindowView[]> {
  const rows = await resolveDbClient().all<WindowRow>(
    "select * from app_deployment_windows where app_id = ? order by created_at desc", [appId]);
  return rows.map(toView);
}

async function activeWindow(appId: string): Promise<WindowRow | undefined> {
  return resolveDbClient().get<WindowRow>(
    `select * from app_deployment_windows where app_id = ? and status in (${NON_FINAL_STATUSES.map(() => "?").join(",")})
     order by created_at desc limit 1`,
    [appId, ...NON_FINAL_STATUSES],
  );
}

// Session 1's production-publish upserts one app_deployment_launch_controls
// row per new deployment_id, keeping the currently published row's status
// 'published' until superseded. Drain/window-end timing lives on that
// currently published row — that's what resolveTrustedDeployment reads for
// an already-started session's dispatch, and what a future session-start
// path (not yet built — see README) would read for AC39/52's new-start
// block.
// Every historical deployment keeps its own 'published' row in
// app_deployment_launch_controls forever (a superseding publish only
// ever inserts a new row, never flips an older one — see
// deployment-production/service.ts) so an existing session bound to an
// older deployment stays dispatchable after a newer release ships (AC25).
// Drain/window timing must therefore target only the one deployment_id
// the current publication pointer actually names, not every row that
// happens to still say 'published'.
async function projectOntoPublishedDeployment(db: DbClient, appId: string, environment: string, drainStartsAt: string | null, endsAt: string | null, now: string) {
  const publication = await db.get<{ current_published_deployment_id: string | null }>(
    "select current_published_deployment_id from app_environment_publications where app_id = ? and environment = ?",
    [appId, environment],
  );
  if (!publication?.current_published_deployment_id) return;
  await db.run(
    "update app_deployment_launch_controls set drain_starts_at = ?, deployment_window_ends_at = ?, version = version + 1, updated_at = ? where deployment_id = ?",
    [drainStartsAt, endsAt, now, publication.current_published_deployment_id],
  );
}

async function requireVerifiedStagedRelease(appId: string, releaseId: string) {
  const release = await getRelease(releaseId);
  if (!release || release.appId !== appId) throw new DeploymentPipelineError("RELEASE_NOT_FOUND");
  if (release.status !== "verified") throw new DeploymentPipelineError("RELEASE_NOT_VERIFIED");
  const staging = await getLatestDeployment(appId, releaseId, "staging");
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
export async function scheduleDeploymentWindow(input: ScheduleWindowInput, now: Date): Promise<DeploymentWindowView> {
  await requireActiveApp(input.appId);
  await requireVerifiedStagedRelease(input.appId, input.releaseId);
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
  const cached = await checkDeploymentIdempotency<DeploymentWindowView>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  return resolveDbClient().transaction(async (db: DbClient) => {
    await beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      operation: "schedule_window",
      hash,
    });
    if (await activeWindow(input.appId)) throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_CONFLICT");

    const id = randomUUID();
    const nowIso = now.toISOString();
    const startsAtIso = input.startsAt.toISOString();
    const endsAtIso = input.endsAt.toISOString();
    const drainStartsAt = new Date(input.startsAt.getTime() - LEAD_TIME_MS).toISOString();
    await db.run(
      `insert into app_deployment_windows
       (id, app_id, release_id, starts_at, ends_at, drain_starts_at, status, created_by_admin_id, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'scheduled', ?, 1, ?, ?)`,
      [id, input.appId, input.releaseId, startsAtIso, endsAtIso, drainStartsAt, input.adminUserId, nowIso, nowIso],
    );

    await projectOntoPublishedDeployment(db, input.appId, "production", drainStartsAt, endsAtIso, nowIso);

    const view = toView((await row(id))!);
    await completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: view });
    return view;
  });
}

export type RescheduleWindowInput = {
  windowId: string;
  startsAt: Date;
  endsAt: Date;
  expectedVersion: number;
  adminUserId: string;
  idempotencyKey: string;
};

export async function rescheduleDeploymentWindow(input: RescheduleWindowInput, now: Date): Promise<DeploymentWindowView> {
  const existing = await row(input.windowId);
  if (!existing) throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_FOUND");
  await requireActiveApp(existing.app_id);
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
  const cached = await checkDeploymentIdempotency<DeploymentWindowView>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  return resolveDbClient().transaction(async (db: DbClient) => {
    await beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: existing.app_id,
      idempotencyKey: input.idempotencyKey,
      operation: "reschedule_window",
      hash,
    });
    const current = (await row(input.windowId))!;
    if (current.version !== input.expectedVersion) throw new DeploymentPipelineError("DEPLOYMENT_VERSION_CONFLICT");
    if (current.status !== "scheduled") throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");

    const nowIso = now.toISOString();
    const startsAtIso = input.startsAt.toISOString();
    const endsAtIso = input.endsAt.toISOString();
    const drainStartsAt = new Date(input.startsAt.getTime() - LEAD_TIME_MS).toISOString();
    await db.run(
      `update app_deployment_windows set starts_at = ?, ends_at = ?, drain_starts_at = ?, version = version + 1, updated_at = ?
       where id = ? and version = ?`,
      [startsAtIso, endsAtIso, drainStartsAt, nowIso, input.windowId, input.expectedVersion],
    );

    await projectOntoPublishedDeployment(db, current.app_id, "production", drainStartsAt, endsAtIso, nowIso);

    const view = toView((await row(input.windowId))!);
    await completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: view });
    return view;
  });
}

export type CancelWindowInput
 = { windowId: string; expectedVersion: number; adminUserId: string; idempotencyKey: string };

export async function cancelDeploymentWindow(input: CancelWindowInput, now: Date): Promise<DeploymentWindowView> {
  const existing = await row(input.windowId);
  if (!existing) throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_FOUND");
  await requireActiveApp(existing.app_id);
  if (existing.status !== "scheduled" && existing.status !== "draining") {
    throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");
  }

  const hash = computeRequestHash({ windowId: input.windowId, expectedVersion: input.expectedVersion, action: "cancel" });
  const cached = await checkDeploymentIdempotency<DeploymentWindowView>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  return resolveDbClient().transaction(async (db: DbClient) => {
    await beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: existing.app_id,
      idempotencyKey: input.idempotencyKey,
      operation: "cancel_window",
      hash,
    });
    const current = (await row(input.windowId))!;
    if (current.version !== input.expectedVersion) throw new DeploymentPipelineError("DEPLOYMENT_VERSION_CONFLICT");
    if (current.status !== "scheduled" && current.status !== "draining") {
      throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");
    }

    const nowIso = now.toISOString();
    await db.run(
      "update app_deployment_windows set status = 'cancelled', completed_at = ?, version = version + 1, updated_at = ? where id = ? and version = ?",
      [nowIso, nowIso, input.windowId, input.expectedVersion],
    );
    await projectOntoPublishedDeployment(db, current.app_id, "production", null, null, nowIso);

    const view = toView((await row(input.windowId))!);
    await completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: view });
    return view;
  });
}

// AT-AR-002-41/42 (business rules 55, 58): at starts_at the pipeline must
// confirm zero starting/active/disconnected sessions for the app before
// deploying; if any remain, it postpones without deploying. If the window
// overruns ends_at without a completed publish, blocking stays fail-closed
// (extended_safe_block) rather than lapsing back to unblocked. This is the
// scheduled entry point — same "restart-safe, state lives in the row, not
// memory" shape as SC-003's sweepExpiredStartReservations.
export async function sweepDeploymentWindows(now: Date, provider: DeploymentProvider): Promise<void> {
  const due = await resolveDbClient().all<WindowRow>(
    `select * from app_deployment_windows where status in ('scheduled','draining','executing','extended_safe_block')
     and starts_at <= ? order by starts_at asc`,
    [now.toISOString()],
  );
  for (const current of due) {
    await processDueWindow(current, now, provider);
  }
}

async function processDueWindow(current: WindowRow, now: Date, provider: DeploymentProvider) {
  const db = resolveDbClient();
  const overrun = now.getTime() >= new Date(current.ends_at).getTime();

  const reserved = await db.get(
    `select 1 from learner_sessions where app_id = ? and deployment_environment = 'production'
     and status in ('starting','active','disconnected','resumable') limit 1`,
    [current.app_id],
  );
  if (reserved) {
    await db.run(
      "update app_deployment_windows set status = ?, failure_code = ?, version = version + 1, updated_at = ? where id = ? and version = ?",
      [overrun ? "extended_safe_block" : "draining", "DEPLOYMENT_SESSIONS_ACTIVE", now.toISOString(), current.id, current.version],
    );
    return;
  }

  await db.run(
    "update app_deployment_windows set status = 'executing', version = version + 1, updated_at = ? where id = ? and version = ?",
    [now.toISOString(), current.id, current.version],
  );

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
    await db.run(
      "update app_deployment_windows set status = ?, failure_code = ?, version = version + 1, updated_at = ? where id = ?",
      [overrun ? "extended_safe_block" : "failed", code, now.toISOString(), current.id],
    );
  }
}
