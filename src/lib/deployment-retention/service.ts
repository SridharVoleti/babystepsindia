import { getDb } from "@/lib/db/client";

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

export function purgeDeploymentArtifacts(now: Date = new Date()): PurgeResult {
  const db = getDb();
  const deploymentCutoff = new Date(now.getTime() - DEPLOYMENT_RETENTION_MS).toISOString();
  const webhookCutoff = new Date(now.getTime() - WEBHOOK_RECEIPT_RETENTION_MS).toISOString();
  const operationCutoff = new Date(now.getTime() - OPERATION_REQUEST_RETENTION_MS).toISOString();

  const run = db.transaction(() => {
    // Rule 41: never purge whatever a publication pointer still names,
    // regardless of age or status, and never purge a failed deployment
    // under an open investigation_hold (rule 40's "detailed... responses
    // are temporary" explicitly excludes anything still being looked at).
    const retainedDeploymentIds = new Set(
      (
        db
          .prepare(
            `select current_published_deployment_id as id from app_environment_publications where current_published_deployment_id is not null
             union
             select previous_healthy_deployment_id as id from app_environment_publications where previous_healthy_deployment_id is not null`,
          )
          .all() as { id: string }[]
      ).map((row) => row.id),
    );

    const purgeableDeployments = (
      db
        .prepare(
          `select id from app_deployments
           where status in ('superseded', 'failed', 'rolled_back')
             and investigation_hold = 0
             and coalesce(superseded_at, ended_at, started_at) < ?`,
        )
        .all(deploymentCutoff) as { id: string }[]
    ).filter((row) => !retainedDeploymentIds.has(row.id));

    for (const { id } of purgeableDeployments) {
      db.prepare("delete from app_deployment_safety_observations where deployment_id = ?").run(id);
      db.prepare("delete from app_deployment_launch_controls where deployment_id = ?").run(id);
      db.prepare("delete from app_deployments where id = ?").run(id);
    }

    const windowsPurged = db
      .prepare(
        `delete from app_deployment_windows where status in ('completed', 'cancelled', 'failed')
         and coalesce(completed_at, updated_at) < ?`,
      )
      .run(deploymentCutoff).changes;

    const webhookReceiptsPurged = db
      .prepare("delete from deployment_webhook_receipts where status = 'processed' and coalesce(processed_at, received_at) < ?")
      .run(webhookCutoff).changes;

    const operationRequestsPurged = db
      .prepare("delete from deployment_operation_requests where status = 'completed' and coalesce(completed_at, created_at) < ?")
      .run(operationCutoff).changes;

    return {
      deploymentsPurged: purgeableDeployments.length,
      windowsPurged,
      webhookReceiptsPurged,
      operationRequestsPurged,
    };
  });

  return run();
}
