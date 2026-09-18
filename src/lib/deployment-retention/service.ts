import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";

// AR-002 session 2, business rules 40-41, AT-AR-002-33/34: detailed build
// logs, provider webhook payloads, preview deployments, and repeated
// validation responses are temporary; Babysteps retains only the current
// published deployment, the previous healthy rollback target, a verified
// release awaiting approval, a failed release under open investigation,
// and compact audit metadata. Everything this purges is already a compact
// row (no detailed logs are stored in this schema at all — see README),
// so purging is about row count/age, not payload size.
const DEPLOYMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WEBHOOK_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const OPERATION_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

export type PurgeResult = {
  deploymentsPurged: number;
  windowsPurged: number;
  webhookReceiptsPurged: number;
  operationRequestsPurged: number;
};

export async function purgeDeploymentArtifacts(now: Date = new Date()): Promise<PurgeResult> {
  const deploymentCutoff = new Date(now.getTime() - DEPLOYMENT_RETENTION_MS).toISOString();
  const webhookCutoff = new Date(now.getTime() - WEBHOOK_RECEIPT_RETENTION_MS).toISOString();
  const operationCutoff = new Date(now.getTime() - OPERATION_REQUEST_RETENTION_MS).toISOString();

  return resolveDbClient().transaction(async (db: DbClient) => {
    // Rule 41: never purge whatever a publication pointer still names,
    // regardless of age or status, and never purge a failed deployment
    // under an open investigation_hold (rule 40's "detailed... responses
    // are temporary" explicitly excludes anything still being looked at).
    const retainedDeploymentIds = new Set(
      (
        await db.all<{ id: string }>(
          `select current_published_deployment_id as id from app_environment_publications where current_published_deployment_id is not null
           union
           select previous_healthy_deployment_id as id from app_environment_publications where previous_healthy_deployment_id is not null`,
        )
      ).map((row) => row.id),
    );

    const purgeableDeployments = (
      await db.all<{ id: string }>(
        `select id from app_deployments
         where status in ('superseded', 'failed', 'rolled_back')
           and investigation_hold = false
           and coalesce(superseded_at, ended_at, started_at) < ?`,
        [deploymentCutoff],
      )
    ).filter((row) => !retainedDeploymentIds.has(row.id));

    for (const { id } of purgeableDeployments) {
      await db.run("delete from app_deployment_safety_observations where deployment_id = ?", [id]);
      await db.run("delete from app_deployment_launch_controls where deployment_id = ?", [id]);
      await db.run("delete from app_deployments where id = ?", [id]);
    }

    const windowsPurged = (await db.run(
      `delete from app_deployment_windows where status in ('completed', 'cancelled', 'failed')
       and coalesce(completed_at, updated_at) < ?`,
      [deploymentCutoff],
    )).changes;

    const webhookReceiptsPurged = (await db.run(
      "delete from deployment_webhook_receipts where status = 'processed' and coalesce(processed_at, received_at) < ?",
      [webhookCutoff],
    )).changes;

    const operationRequestsPurged = (await db.run(
      "delete from deployment_operation_requests where status = 'completed' and coalesce(completed_at, created_at) < ?",
      [operationCutoff],
    )).changes;

    return {
      deploymentsPurged: purgeableDeployments.length,
      windowsPurged,
      webhookReceiptsPurged,
      operationRequestsPurged,
    };
  });
}
