import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { ProgressIntegrityError } from "@/lib/progress-integrity/errors";

export { ProgressIntegrityError };

// PR-004 rule 7-8: the canonical hash folds in identity/version/schema, not
// just the state payload, so a row can't be silently swapped onto another
// learner/app/environment or an earlier version and still hash-match.
// Always hashes the literal stored current_state_json text, never a
// reparsed/reserialized object, so JSON key-order drift is never mistaken
// for corruption.
export function computeCanonicalStateHash(input: {
  learnerId: string;
  appId: string;
  environment: string;
  progressVersion: number;
  schemaVersion: number;
  serializedState: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      learnerId: input.learnerId,
      appId: input.appId,
      environment: input.environment,
      progressVersion: input.progressVersion,
      schemaVersion: input.schemaVersion,
      state: input.serializedState,
    }))
    .digest("hex");
}

export type IntegrityClassification =
  | "healthy"
  | "read_only_safe"
  | "blocked_repairable_metadata"
  | "blocked_conflict"
  | "unreadable_corrupt";

export type LegacyReceiptStatus =
  | "not_required"
  | "required_present"
  | "required_missing_unenforced"
  | "required_missing_enforced";

export type MigrationReceiptStatus = "none" | "consistent" | "mismatched" | "unlinked";

export type SummaryRelation = "ok" | "stale" | "ahead" | "none";

export type IntegrityEvidence = {
  rowExists: boolean;
  hashMatches: boolean;
  schemaRegistered: boolean;
  payloadValidatesAgainstSchema: boolean;
  progressVersionPositiveMonotonic: boolean;
  sourceProvenanceSafe: boolean;
  legacyReceiptStatus: LegacyReceiptStatus;
  migrationReceiptStatus: MigrationReceiptStatus;
  completionOwnershipConflict: boolean;
  summaryRelation: SummaryRelation;
};

export type ClassificationResult = {
  classification: IntegrityClassification;
  issueCodes: string[];
  mutationBlocked: boolean;
  readSafe: boolean;
};

// Rules 46-51: most-severe-wins when multiple issues are detected at once,
// but every detected issue code is still reported (rule 67 aggregation).
const SEVERITY_ORDER: IntegrityClassification[] = [
  "unreadable_corrupt",
  "blocked_conflict",
  "blocked_repairable_metadata",
  "read_only_safe",
  "healthy",
];

function moreSevere(a: IntegrityClassification, b: IntegrityClassification): IntegrityClassification {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

export function classifyIntegrity(evidence: IntegrityEvidence): ClassificationResult {
  if (!evidence.rowExists) {
    // Rule: "No progress row" is a valid first-use state, not corruption.
    return { classification: "healthy", issueCodes: [], mutationBlocked: false, readSafe: true };
  }

  const findings: Array<{ code: string; classification: IntegrityClassification }> = [];

  if (!evidence.hashMatches) findings.push({ code: "HASH_MISMATCH", classification: "unreadable_corrupt" });
  if (!evidence.schemaRegistered) findings.push({ code: "SCHEMA_VERSION_UNREGISTERED", classification: "unreadable_corrupt" });
  if (!evidence.payloadValidatesAgainstSchema) findings.push({ code: "STATE_SCHEMA_INVALID", classification: "unreadable_corrupt" });
  if (!evidence.progressVersionPositiveMonotonic) findings.push({ code: "PROGRESS_VERSION_NOT_POSITIVE", classification: "unreadable_corrupt" });
  if (!evidence.sourceProvenanceSafe) findings.push({ code: "SOURCE_PROVENANCE_UNSAFE", classification: "unreadable_corrupt" });

  if (evidence.legacyReceiptStatus === "required_missing_enforced")
    findings.push({ code: "RECEIPT_REQUIRED_MISSING", classification: "blocked_conflict" });
  if (evidence.migrationReceiptStatus === "mismatched")
    findings.push({ code: "RECEIPT_VERSION_MISMATCH", classification: "blocked_conflict" });
  if (evidence.completionOwnershipConflict)
    findings.push({ code: "COMPLETION_OWNERSHIP_CONFLICT", classification: "blocked_conflict" });

  if (evidence.summaryRelation === "ahead")
    findings.push({ code: "SUMMARY_VERSION_AHEAD", classification: "blocked_repairable_metadata" });
  if (evidence.migrationReceiptStatus === "unlinked")
    findings.push({ code: "MIGRATION_RECEIPT_UNLINKED", classification: "blocked_repairable_metadata" });

  if (evidence.legacyReceiptStatus === "required_missing_unenforced")
    findings.push({ code: "LEGACY_RECEIPT_MISSING_UNENFORCED", classification: "read_only_safe" });
  if (evidence.summaryRelation === "stale")
    findings.push({ code: "SUMMARY_STALE", classification: "read_only_safe" });

  if (findings.length === 0) {
    return { classification: "healthy", issueCodes: [], mutationBlocked: false, readSafe: true };
  }

  const classification = findings.reduce<IntegrityClassification>(
    (worst, finding) => moreSevere(worst, finding.classification), "healthy");
  const issueCodes = findings.map((finding) => finding.code);
  const mutationBlocked = classification !== "healthy";
  const readSafe = classification !== "blocked_conflict" && classification !== "unreadable_corrupt";
  return { classification, issueCodes, mutationBlocked, readSafe };
}

function gateFromClassification(classification: IntegrityClassification): { mutationBlocked: boolean; readSafe: boolean } {
  return {
    mutationBlocked: classification !== "healthy",
    readSafe: classification !== "blocked_conflict" && classification !== "unreadable_corrupt",
  };
}

// A benign, always-readable read_only_safe cause (rule 26: "a non-
// destructive auxiliary inconsistency such as a stale summary" needs no
// operations incident). A read_only_safe row carrying any OTHER issue —
// concretely, LEGACY_RECEIPT_MISSING_UNENFORCED, the case rule 63's
// resolve_legacy_policy action exists for — does need one, or that action
// would have no incident to ever be invoked against.
const NON_INCIDENT_ISSUE_CODES = new Set(["SUMMARY_STALE"]);

function needsIncident(result: ClassificationResult): boolean {
  if (result.classification === "healthy") return false;
  return result.issueCodes.some((code) => !NON_INCIDENT_ISSUE_CODES.has(code));
}

// Duplicated (not imported) from app-progress/service.ts deliberately —
// that module will import validateProgressIntegrity from here for its
// write-gate, so importing matchesSchema back from there would create a
// circular dependency.
function matchesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === "object") {
    if (!value || Array.isArray(value) || typeof value !== "object") return false;
    const object = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => !(String(key) in object))) return false;
    const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties === false && Object.keys(object).some((key) => !properties[key])) return false;
    return Object.entries(properties).every(([key, child]) => !(key in object) || matchesSchema(object[key], child));
  }
  if (type === "array") return Array.isArray(value) && (!schema.items || value.every((item) => matchesSchema(item, schema.items as Record<string, unknown>)));
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

type ProgressRow = {
  learner_id: string; app_id: string; schema_version: number; current_state_json: string | null;
  progress_version: number; state_hash: string | null; progress_summary_json: string | null;
  progress_summary_based_on_version: number | null; last_migration_receipt_id: string | null;
};

export type IntegrityRow = {
  integrity_state: IntegrityClassification; integrity_version: number; issue_codes: string; active_incident_id: string | null;
  legacy_policy_acknowledged: number;
};

function buildEvidence(db: ReturnType<typeof getDb>, input: { learnerId: string; appId: string; environment: string },
  progressRow: ProgressRow | undefined, legacyPolicyAcknowledged: boolean): { evidence: IntegrityEvidence; computedHash: string | null } {
  if (!progressRow) {
    return {
      evidence: { rowExists: false, hashMatches: true, schemaRegistered: true, payloadValidatesAgainstSchema: true,
        progressVersionPositiveMonotonic: true, sourceProvenanceSafe: true, legacyReceiptStatus: "not_required",
        migrationReceiptStatus: "none", completionOwnershipConflict: false, summaryRelation: "ok" },
      computedHash: null,
    };
  }

  const state = progressRow.current_state_json ?? "null";
  const computedHash = computeCanonicalStateHash({ learnerId: input.learnerId, appId: input.appId,
    environment: input.environment, progressVersion: progressRow.progress_version,
    schemaVersion: progressRow.schema_version, serializedState: state });
  const hashMatches = progressRow.state_hash !== null && progressRow.state_hash === computedHash;

  // Rule 9: schema registration is checked at the app/schema-version grain
  // — app_progress_schemas carries no environment column, and a release-
  // pinned lookup belongs to the write-time path (validateState in
  // app-progress/service.ts), not this domain-level integrity check.
  const registered = db.prepare(`select schema_json from app_progress_schemas
    where app_id=? and schema_version=? and status='active' limit 1`)
    .get(input.appId, progressRow.schema_version) as { schema_json: string } | undefined;
  const schemaRegistered = !!registered;
  let payloadValidatesAgainstSchema = true;
  if (registered) {
    try { payloadValidatesAgainstSchema = matchesSchema(JSON.parse(state), JSON.parse(registered.schema_json)); }
    catch { payloadValidatesAgainstSchema = false; }
  }

  const progressVersionPositiveMonotonic = Number.isInteger(progressRow.progress_version) && progressRow.progress_version > 0;

  // Rules 12-15: migration-receipt agreement. A row whose schema_version
  // still matches this app's lowest ever registered version has never
  // been migrated — nothing to check. A row that has migrated carries
  // last_migration_receipt_id once migrateLearnerProgressToReleaseSchema
  // (PR-001) has been updated for PR-004; a row bumped before that receipt
  // existed is the "legacy" case rules 13-14 describe.
  let legacyReceiptStatus: LegacyReceiptStatus = "not_required";
  let migrationReceiptStatus: MigrationReceiptStatus = "none";
  const baseline = db.prepare(`select min(schema_version) as version from app_progress_schemas where app_id=?`)
    .get(input.appId) as { version: number | null };
  const everMigrated = baseline.version !== null && progressRow.schema_version !== baseline.version;

  if (progressRow.last_migration_receipt_id) {
    const receipt = db.prepare(`select to_schema_version from learner_progress_migration_receipts where id=?`)
      .get(progressRow.last_migration_receipt_id) as { to_schema_version: number } | undefined;
    migrationReceiptStatus = receipt && receipt.to_schema_version === progressRow.schema_version ? "consistent" : "mismatched";
  } else if (everMigrated && !legacyPolicyAcknowledged) {
    const appHasReceiptHistory = db.prepare(`select 1 from learner_progress_migration_receipts where app_id=? limit 1`)
      .get(input.appId);
    legacyReceiptStatus = appHasReceiptHistory ? "required_missing_enforced" : "required_missing_unenforced";
  }

  const conflictingCompletion = db.prepare(`select 1 from lesson_completions
    where learner_id=? and app_id=? and progress_version_after_completion > ? limit 1`)
    .get(input.learnerId, input.appId, progressRow.progress_version);
  const completionOwnershipConflict = !!conflictingCompletion;

  let summaryRelation: SummaryRelation = "ok";
  if (progressRow.progress_summary_json !== null && progressRow.progress_summary_based_on_version !== null) {
    if (progressRow.progress_summary_based_on_version > progressRow.progress_version) summaryRelation = "ahead";
    else if (progressRow.progress_summary_based_on_version < progressRow.progress_version) summaryRelation = "stale";
  }

  return {
    evidence: { rowExists: true, hashMatches, schemaRegistered, payloadValidatesAgainstSchema,
      progressVersionPositiveMonotonic, sourceProvenanceSafe: true, legacyReceiptStatus, migrationReceiptStatus,
      completionOwnershipConflict, summaryRelation },
    computedHash,
  };
}

function activeIncidentId(db: ReturnType<typeof getDb>, learnerId: string, appId: string): string | null {
  const row = db.prepare(`select id from progress_integrity_incidents where learner_id=? and app_id=? and status in ('open','investigating')`)
    .get(learnerId, appId) as { id: string } | undefined;
  return row?.id ?? null;
}

function severityFor(classification: IntegrityClassification): "low" | "medium" | "high" | "critical" {
  return classification === "unreadable_corrupt" ? "critical" : classification === "blocked_conflict" ? "high" :
    classification === "read_only_safe" ? "low" : "medium";
}

// Rules 59, 67: exactly one active incident per learner+app — a second
// detection while one is already open/investigating aggregates its issue
// codes onto the existing row instead of inserting a duplicate. Relies on
// the ux_pii_active unique index as the actual dedup guarantee.
function upsertIncident(db: ReturnType<typeof getDb>, input: { learnerId: string; appId: string; environment: string },
  result: ClassificationResult, progressRow: ProgressRow | undefined, computedHash: string | null, nowIso: string): string {
  const existingId = activeIncidentId(db, input.learnerId, input.appId);
  if (existingId) {
    const existing = db.prepare(`select issue_codes from progress_integrity_incidents where id=?`).get(existingId) as { issue_codes: string };
    const merged = Array.from(new Set([...(JSON.parse(existing.issue_codes) as string[]), ...result.issueCodes]));
    db.prepare(`update progress_integrity_incidents set classification=?, severity=?, issue_codes=?,
      expected_state_hash=?, actual_state_hash=?, actual_progress_version=?, actual_schema_version=?,
      attempt_count=attempt_count+1, version=version+1, updated_at=? where id=?`)
      .run(result.classification, severityFor(result.classification), JSON.stringify(merged),
        progressRow?.state_hash ?? null, computedHash, progressRow?.progress_version ?? null,
        progressRow?.schema_version ?? null, nowIso, existingId);
    return existingId;
  }
  const id = randomUUID();
  db.prepare(`insert into progress_integrity_incidents(id,app_id,environment,learner_id,classification,severity,status,
    issue_codes,expected_state_hash,actual_state_hash,actual_progress_version,actual_schema_version,attempt_count,version,
    created_at,updated_at) values(?,?,?,?,?,?,'open',?,?,?,?,?,1,1,?,?)`)
    .run(id, input.appId, input.environment, input.learnerId, result.classification, severityFor(result.classification),
      JSON.stringify(result.issueCodes), progressRow?.state_hash ?? null, computedHash, progressRow?.progress_version ?? null,
      progressRow?.schema_version ?? null, nowIso, nowIso);
  return id;
}

// Matches the spec's literal API contract enum exactly (reason=read|write|
// launch|reconcile) — an admin-triggered "revalidate" incident action
// (Section 4/incidents.ts) calls this with reason:"read", since it's a
// fresh, on-demand recheck rather than a distinct fifth mode the schema's
// check constraints would need to carry.
export type IntegrityReason = "read" | "write" | "launch" | "reconcile";

export type ValidateProgressIntegrityInput = {
  learnerId: string; appId: string; environment: string; reason: IntegrityReason;
  expectedIntegrityVersion?: number; idempotencyKey?: string; requesterPrincipalId?: string; now: Date;
};

export type ValidateProgressIntegrityResult = {
  classification: IntegrityClassification; integrityVersion: number; mutationBlocked: boolean; readSafe: boolean;
  issueCodes: string[]; incidentId: string | null;
};

// PR-004's central orchestrator — every write-gate call site (LA-003
// checkpoint/completion, PR-001 migration, SC-003 mandatory-progress
// launch) and every read/reconcile path calls this. Rule 57: bounded,
// single-row lookups only, never a full learner-history scan.
export function validateProgressIntegrity(input: ValidateProgressIntegrityInput): ValidateProgressIntegrityResult {
  const db = getDb();
  const nowIso = input.now.toISOString();

  if (input.idempotencyKey && input.requesterPrincipalId) {
    const existing = db.prepare(`select classification, integrity_version from progress_integrity_validation_receipts
      where requester_principal_id=? and idempotency_key=?`)
      .get(input.requesterPrincipalId, input.idempotencyKey) as
      { classification: IntegrityClassification; integrity_version: number } | undefined;
    if (existing) {
      return { classification: existing.classification, integrityVersion: existing.integrity_version,
        ...gateFromClassification(existing.classification), issueCodes: [],
        incidentId: activeIncidentId(db, input.learnerId, input.appId) };
    }
  }

  return db.transaction(() => {
    const integrityRow = db.prepare(`select * from learner_app_progress_integrity where learner_id=? and app_id=?`)
      .get(input.learnerId, input.appId) as IntegrityRow | undefined;

    if (input.expectedIntegrityVersion !== undefined) {
      const currentVersion = integrityRow?.integrity_version ?? 0;
      if (currentVersion !== input.expectedIntegrityVersion) throw new ProgressIntegrityError("PROGRESS_INTEGRITY_VERSION_CONFLICT");
    }

    const progressRow = db.prepare(`select * from learner_app_progress where learner_id=? and app_id=?`)
      .get(input.learnerId, input.appId) as ProgressRow | undefined;

    const { evidence, computedHash } = buildEvidence(db, input, progressRow, integrityRow?.legacy_policy_acknowledged === 1);
    const result = classifyIntegrity(evidence);

    const priorIssues = integrityRow ? (JSON.parse(integrityRow.issue_codes) as string[]) : [];
    const priorState = integrityRow?.integrity_state ?? "healthy";
    const stateChanged = priorState !== result.classification ||
      JSON.stringify([...priorIssues].sort()) !== JSON.stringify([...result.issueCodes].sort());
    const nextVersion = integrityRow ? (stateChanged ? integrityRow.integrity_version + 1 : integrityRow.integrity_version) : 0;

    // Not integrityRow?.active_incident_id — that field can be stale
    // relative to an incident an admin action already closed. The live
    // open/investigating lookup is the source of truth.
    const incidentId = needsIncident(result)
      ? upsertIncident(db, input, result, progressRow, computedHash, nowIso)
      : activeIncidentId(db, input.learnerId, input.appId);

    db.prepare(`insert into learner_app_progress_integrity(learner_id,app_id,environment,integrity_state,integrity_version,
      canonical_state_hash,validated_progress_version,validated_schema_version,last_migration_receipt_id,issue_codes,
      mutation_blocked,read_safe,last_validated_at,last_validated_source,active_incident_id,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(learner_id,app_id) do update set environment=excluded.environment,integrity_state=excluded.integrity_state,
      integrity_version=excluded.integrity_version,canonical_state_hash=excluded.canonical_state_hash,
      validated_progress_version=excluded.validated_progress_version,validated_schema_version=excluded.validated_schema_version,
      last_migration_receipt_id=excluded.last_migration_receipt_id,issue_codes=excluded.issue_codes,
      mutation_blocked=excluded.mutation_blocked,read_safe=excluded.read_safe,last_validated_at=excluded.last_validated_at,
      last_validated_source=excluded.last_validated_source,active_incident_id=excluded.active_incident_id,updated_at=excluded.updated_at`)
      .run(input.learnerId, input.appId, input.environment, result.classification, nextVersion, computedHash,
        progressRow?.progress_version ?? null, progressRow?.schema_version ?? null, progressRow?.last_migration_receipt_id ?? null,
        JSON.stringify(result.issueCodes), result.mutationBlocked ? 1 : 0, result.readSafe ? 1 : 0, nowIso,
        reasonToSource(input.reason), incidentId, nowIso, nowIso);

    db.prepare(`insert into progress_integrity_validation_receipts(id,learner_id,app_id,progress_version,integrity_version,
      schema_version,expected_state_hash,actual_state_hash,result,classification,reason,requester_principal_id,
      request_hash,idempotency_key,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), input.learnerId, input.appId, progressRow?.progress_version ?? null, nextVersion,
        progressRow?.schema_version ?? null, progressRow?.state_hash ?? null, computedHash,
        result.classification === "healthy" || result.classification === "read_only_safe" ? "pass" : "fail",
        result.classification, input.reason, input.requesterPrincipalId ?? null, null, input.idempotencyKey ?? null, nowIso);

    return { classification: result.classification, integrityVersion: nextVersion, mutationBlocked: result.mutationBlocked,
      readSafe: result.readSafe, issueCodes: result.issueCodes, incidentId };
  })();
}

function reasonToSource(reason: IntegrityReason): "inline_read" | "inline_write" | "launch" | "reconcile" {
  if (reason === "write") return "inline_write";
  if (reason === "launch") return "launch";
  if (reason === "reconcile") return "reconcile";
  return "inline_read";
}
