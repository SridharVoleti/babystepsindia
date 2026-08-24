import { getDb } from "@/lib/db/client";
import { resolveDbClient } from "@/lib/db-client";
import { AppLaunchError, type TrustedDeployment } from "@/lib/app-launch/service";

type DeploymentRow = {
  deployment_id: string; app_id: string; release_id: string; environment: string;
  immutable_origin: string; launch_path: string; compatibility_status: string;
  drain_starts_at: string | null; deployment_window_ends_at: string | null; status: string;
};

export function resolveTrustedDeployment(sessionId: string, now: Date): TrustedDeployment {
  const session = getDb().prepare(
    `select app_id,deployment_id,release_id,deployment_environment,deployment_origin,launch_path
     from learner_sessions where id=?`,
  ).get(sessionId) as Record<string, string | null> | undefined;
  if (!session?.deployment_id) throw new AppLaunchError("SESSION_DEPLOYMENT_MISMATCH");
  const row = getDb().prepare("select * from app_deployment_launch_controls where deployment_id=?")
    .get(session.deployment_id) as DeploymentRow | undefined;
  if (!row || row.app_id !== session.app_id || row.release_id !== session.release_id ||
      row.environment !== session.deployment_environment || row.immutable_origin !== session.deployment_origin ||
      row.launch_path !== session.launch_path) throw new AppLaunchError("SESSION_DEPLOYMENT_MISMATCH");
  const inWindow = row.status === "draining" || row.status === "deploying" ||
    (!!row.drain_starts_at && now >= new Date(row.drain_starts_at) &&
      (!row.deployment_window_ends_at || now < new Date(row.deployment_window_ends_at)));
  return { deploymentId: row.deployment_id, releaseId: row.release_id, environment: row.environment,
    origin: row.immutable_origin, launchPath: row.launch_path,
    compatibilityPassed: row.compatibility_status === "passed",
    dispatchBlocked: inWindow || row.status !== "published" };
}

export async function resolveTrustedDeploymentForProduction(sessionId: string, now: Date): Promise<TrustedDeployment> {
  const db = resolveDbClient();
  const session = await db.get<Record<string, string | null>>(
    `select app_id,deployment_id,release_id,deployment_environment,deployment_origin,launch_path from learner_sessions where id=?`,
    [sessionId]);
  if (!session?.deployment_id) throw new AppLaunchError("SESSION_DEPLOYMENT_MISMATCH");
  const row = await db.get<DeploymentRow>("select * from app_deployment_launch_controls where deployment_id=?", [session.deployment_id]);
  if (!row || row.app_id !== session.app_id || row.release_id !== session.release_id ||
      row.environment !== session.deployment_environment || row.immutable_origin !== session.deployment_origin ||
      row.launch_path !== session.launch_path) throw new AppLaunchError("SESSION_DEPLOYMENT_MISMATCH");
  return { deploymentId: row.deployment_id, releaseId: row.release_id, environment: row.environment,
    origin: row.immutable_origin, launchPath: row.launch_path, compatibilityPassed: row.compatibility_status === "passed",
    dispatchBlocked: row.status !== "published" || (Boolean(row.drain_starts_at) && now >= new Date(row.drain_starts_at!)) ||
      (Boolean(row.deployment_window_ends_at) && now >= new Date(row.deployment_window_ends_at!)) };
}
