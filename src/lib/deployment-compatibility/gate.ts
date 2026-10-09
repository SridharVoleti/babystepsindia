import type { DbClient } from "@/lib/db-client/types";
import { resolveDbClient } from "@/lib/db-client";
import { hasMigrationPath } from "@/lib/progress-schema-registry/service";

// PRG-025: the mandatory release compatibility gate (AR-002 business rules 46-49). Executed against LIVE state at staging
// verification AND again at production promotion; the outcome is stored against the release identifier as evidence, whether it
// passes or fails. Three independent checks over every learner-progress schema version still represented for the app:
//   read      - the release's CI-attested readableSchemaVersions cover every represented version;
//   migration - a registered forward migration path exists from every represented version to the version the release writes;
//   write     - a registered rollback path exists from the release's version back to every represented version, so state the new
//               release writes can still be read after a rollback.
// With no registered progress schema the release writes no new schema version, so migration and write have nothing to gate.
export type CompatibilityCheckName = "read" | "migration" | "write";
export type CompatibilityCheck = { name: CompatibilityCheckName; status: "passed" | "failed"; versions?: number[]; detail?: string };
export type CompatibilityGateResult = {
  releaseId: string;
  status: "passed" | "failed";
  checks: CompatibilityCheck[];
  representedVersions: number[];
  targetVersion: number | null;
  generatedAt: string;
};

export async function runCompatibilityGate(input: {
  appId: string; releaseId: string; readableSchemaVersions: number[]; now: Date; db?: DbClient;
}): Promise<CompatibilityGateResult> {
  const db = input.db ?? resolveDbClient();
  const rows = await db.all<{ schema_version: number }>("select distinct schema_version from learner_app_progress where app_id = ?", [input.appId]);
  const represented = rows.map((r) => r.schema_version).sort((a, b) => a - b);
  const registered = await db.get<{ version: number | null }>(
    "select max(schema_version) as version from app_progress_schemas where app_id = ? and release_id = ? and status = 'active'", [input.appId, input.releaseId]);
  const target = registered?.version ?? null;

  const unreadable = represented.filter((v) => !input.readableSchemaVersions.includes(v));
  const checks: CompatibilityCheck[] = [{ name: "read", status: unreadable.length ? "failed" : "passed", ...(unreadable.length ? { versions: unreadable, detail: "release cannot read these represented schema versions" } : {}) }];

  const noForward: number[] = [];
  const noRollback: number[] = [];
  if (target !== null) {
    for (const v of represented) {
      if (v === target) continue;
      if (!(await hasMigrationPath(input.appId, v, target))) noForward.push(v);
      if (!(await hasMigrationPath(input.appId, target, v))) noRollback.push(v);
    }
  }
  checks.push({ name: "migration", status: noForward.length ? "failed" : "passed", ...(noForward.length ? { versions: noForward, detail: `no forward migration path to schema version ${target}` } : target === null ? { detail: "release registered no progress schema" } : {}) });
  checks.push({ name: "write", status: noRollback.length ? "failed" : "passed", ...(noRollback.length ? { versions: noRollback, detail: `no rollback path from schema version ${target}` } : target === null ? { detail: "release registered no progress schema" } : {}) });

  return {
    releaseId: input.releaseId, status: checks.every((c) => c.status === "passed") ? "passed" : "failed", checks,
    representedVersions: represented, targetVersion: target, generatedAt: input.now.toISOString(),
  };
}

const statusOf = (r: CompatibilityGateResult, name: CompatibilityCheckName) => r.checks.find((c) => c.name === name)!.status;

export async function recordCompatibilityReport(db: DbClient, result: CompatibilityGateResult): Promise<void> {
  await db.run(
    `insert into app_release_compatibility_reports
     (release_id, platform_contract_version, represented_progress_schema_versions_json, status, read_status, migration_status, write_status, checks_json, generated_at)
     values (?, '1.0', ?, ?, ?, ?, ?, ?, ?)
     on conflict(release_id) do update set
       represented_progress_schema_versions_json = excluded.represented_progress_schema_versions_json, status = excluded.status,
       read_status = excluded.read_status, migration_status = excluded.migration_status, write_status = excluded.write_status,
       checks_json = excluded.checks_json, generated_at = excluded.generated_at`,
    [result.releaseId, JSON.stringify(result.representedVersions), result.status, statusOf(result, "read"), statusOf(result, "migration"), statusOf(result, "write"),
      JSON.stringify(result.checks), result.generatedAt],
  );
}

/** Compact, non-sensitive evidence copied onto the production deployment record. */
export function gateEvidence(result: CompatibilityGateResult) {
  return { releaseId: result.releaseId, status: result.status, read: statusOf(result, "read"), migration: statusOf(result, "migration"), write: statusOf(result, "write"), generatedAt: result.generatedAt };
}
