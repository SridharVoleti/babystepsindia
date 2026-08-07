import { randomUUID } from "node:crypto";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { assertManifestIdentity, parseDeploymentManifest, type DeploymentManifest } from "@/lib/deployment-manifest/schema";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import {
  beginDeploymentOperation,
  checkDeploymentIdempotency,
  completeDeploymentOperation,
} from "@/lib/deployment-pipeline/idempotency";

// AR-002 business rule 15: the mandatory build-gate set. All must pass
// before a release can be staged.
export type ReleaseGateResults = {
  dependencyInstall: boolean;
  typeCheck: boolean;
  lint: boolean;
  unitTests: boolean;
  contractTests: boolean;
  security: boolean;
  build: boolean;
};

export type ReleaseStatus = "created" | "gate_failed" | "staging_deploying" | "staging_failed" | "verified" | "promoted";

type ReleaseRow = {
  id: string;
  app_id: string;
  source_repository: string;
  source_commit_sha: string;
  dependency_lock_hash: string;
  build_input_hash: string;
  artifact_digest: string;
  provider_artifact_id: string | null;
  manifest_json: string;
  gate_results_json: string;
  status: ReleaseStatus;
  created_by_ci_principal: string;
  version: number;
  created_at: string;
  verified_at: string | null;
  failed_at: string | null;
};

export type ReleaseView = {
  id: string;
  appId: string;
  sourceRepository: string;
  sourceCommitSha: string;
  dependencyLockHash: string;
  buildInputHash: string;
  artifactDigest: string;
  providerArtifactId: string | null;
  manifest: DeploymentManifest;
  gateResults: ReleaseGateResults;
  status: ReleaseStatus;
  createdByCiPrincipal: string;
  version: number;
  createdAt: string;
  verifiedAt: string | null;
  failedAt: string | null;
};

function toView(row: ReleaseRow): ReleaseView {
  return {
    id: row.id,
    appId: row.app_id,
    sourceRepository: row.source_repository,
    sourceCommitSha: row.source_commit_sha,
    dependencyLockHash: row.dependency_lock_hash,
    buildInputHash: row.build_input_hash,
    artifactDigest: row.artifact_digest,
    providerArtifactId: row.provider_artifact_id,
    manifest: JSON.parse(row.manifest_json) as DeploymentManifest,
    gateResults: JSON.parse(row.gate_results_json) as ReleaseGateResults,
    status: row.status,
    createdByCiPrincipal: row.created_by_ci_principal,
    version: row.version,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    failedAt: row.failed_at,
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

export function getRelease(releaseId: string): ReleaseView | null {
  const row = getDb().prepare("select * from app_releases where id = ?").get(releaseId) as ReleaseRow | undefined;
  return row ? toView(row) : null;
}

export function listReleases(appId: string): ReleaseView[] {
  const rows = getDb().prepare("select * from app_releases where app_id = ? order by created_at desc").all(appId) as ReleaseRow[];
  return rows.map(toView);
}

export type CreateReleaseInput = {
  appId: string;
  sourceRepository: string;
  sourceCommitSha: string;
  dependencyLockHash: string;
  buildInputHash: string;
  artifactDigest: string;
  providerArtifactId?: string | null;
  manifest: unknown;
  gateResults: ReleaseGateResults;
  createdByCiPrincipal: string;
  idempotencyKey: string;
};

// AT-AR-002-09/10/11/13: only an authenticated CI principal reaches this
// path (enforced by the route's requireInternalService guard); the release
// identity (commit/hashes/digest) is fixed at creation and never mutated —
// only status/timestamps ever change afterward (business rule 12-13).
export function createRelease(input: CreateReleaseInput): ReleaseView {
  const app = requireActiveApp(input.appId);

  const manifest = parseDeploymentManifest(input.manifest);
  assertManifestIdentity(manifest, app.app_key);

  const hash = computeRequestHash({
    appId: input.appId,
    sourceRepository: input.sourceRepository,
    sourceCommitSha: input.sourceCommitSha,
    dependencyLockHash: input.dependencyLockHash,
    buildInputHash: input.buildInputHash,
    artifactDigest: input.artifactDigest,
    gateResults: input.gateResults,
  });
  const cached = checkDeploymentIdempotency<ReleaseView>(input.createdByCiPrincipal, input.idempotencyKey, hash);
  if (cached) {
    if (cached.status === "gate_failed") throw new DeploymentPipelineError("RELEASE_GATE_FAILED");
    return cached;
  }

  const db = getDb();
  const run = db.transaction(() => {
    beginDeploymentOperation({
      actorPrincipalId: input.createdByCiPrincipal,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      operation: "create_release",
      hash,
    });

    // Alt flow: a duplicate commit/artifact retry (even under a different
    // idempotency key — e.g. a CI runner retrying without preserving state)
    // returns the original release rather than creating a second identity.
    const existing = db
      .prepare("select * from app_releases where app_id = ? and source_commit_sha = ? and artifact_digest = ?")
      .get(input.appId, input.sourceCommitSha, input.artifactDigest) as ReleaseRow | undefined;
    if (existing) {
      const view = toView(existing);
      completeDeploymentOperation({ actorPrincipalId: input.createdByCiPrincipal, idempotencyKey: input.idempotencyKey, result: view, releaseId: existing.id });
      return { view, gatesAllPass: existing.status !== "gate_failed" };
    }

    const gatesAllPass = Object.values(input.gateResults).every(Boolean);
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `insert into app_releases
       (id, app_id, source_repository, source_commit_sha, dependency_lock_hash, build_input_hash, artifact_digest,
        provider_artifact_id, manifest_json, gate_results_json, status, created_by_ci_principal, version, created_at, failed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.appId,
      input.sourceRepository,
      input.sourceCommitSha,
      input.dependencyLockHash,
      input.buildInputHash,
      input.artifactDigest,
      input.providerArtifactId ?? null,
      JSON.stringify(manifest),
      JSON.stringify(input.gateResults),
      gatesAllPass ? "created" : "gate_failed",
      input.createdByCiPrincipal,
      now,
      gatesAllPass ? null : now,
    );

    const view = toView(db.prepare("select * from app_releases where id = ?").get(id) as ReleaseRow);
    completeDeploymentOperation({ actorPrincipalId: input.createdByCiPrincipal, idempotencyKey: input.idempotencyKey, result: view, releaseId: id });
    return { view, gatesAllPass };
  });

  const { view, gatesAllPass } = run();
  if (!gatesAllPass || view.status === "gate_failed") throw new DeploymentPipelineError("RELEASE_GATE_FAILED");
  return view;
}
