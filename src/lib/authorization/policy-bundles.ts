import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { findStaffById } from "@/lib/staff-identity/accounts-repo";

export type AuthorizationPrincipalType = "parent" | "learner" | "administrator" | "support" | "managed_service";
export type AuthorizationPolicyRule = {
  actionKey: string;
  effect: "allow" | "deny";
  principalType: AuthorizationPrincipalType;
  resourceType: string;
};
export type AuthorizationPolicyBundle = {
  id: string;
  version: string;
  digest: string;
  sourceCommitSha: string;
  rules: AuthorizationPolicyRule[];
  createdAt: string;
};

export class AuthorizationPolicyBundleError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AuthorizationPolicyBundleError";
  }
}

function canonicalRules(rules: AuthorizationPolicyRule[]) {
  return rules.map((rule) => ({
    actionKey: rule.actionKey,
    effect: rule.effect,
    principalType: rule.principalType,
    resourceType: rule.resourceType,
  })).sort((left, right) => left.actionKey.localeCompare(right.actionKey));
}

function canonicalPayload(version: string, sourceCommitSha: string, rules: AuthorizationPolicyRule[]) {
  return JSON.stringify({ version, sourceCommitSha, rules: canonicalRules(rules) });
}

function digest(payload: string) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function validate(input: { version: string; sourceCommitSha: string; rules: AuthorizationPolicyRule[] }) {
  if (!/^\d+\.\d+\.\d+$/.test(input.version) || !/^[a-f0-9]{40}$/.test(input.sourceCommitSha) || input.rules.length === 0) {
    throw new AuthorizationPolicyBundleError("POLICY_BUNDLE_INVALID");
  }
  const seen = new Set<string>();
  for (const rule of input.rules) {
    if (!(rule.actionKey in AUTHORIZATION_ACTIONS) || seen.has(rule.actionKey)
      || !["allow", "deny"].includes(rule.effect)
      || !["parent", "learner", "administrator", "support", "managed_service"].includes(rule.principalType)
      || !rule.resourceType.trim()) {
      throw new AuthorizationPolicyBundleError("POLICY_BUNDLE_INVALID");
    }
    seen.add(rule.actionKey);
  }
}

function deserialize(row: Record<string, unknown>): AuthorizationPolicyBundle {
  const policyJson = String(row.policy_json);
  const rules = JSON.parse(policyJson) as AuthorizationPolicyRule[];
  const payload = canonicalPayload(String(row.version), String(row.source_commit_sha), rules);
  if (digest(payload) !== row.digest || JSON.stringify(canonicalRules(rules)) !== policyJson) {
    throw new AuthorizationPolicyBundleError("POLICY_BUNDLE_INTEGRITY_FAILED");
  }
  return {
    id: String(row.id), version: String(row.version), digest: String(row.digest),
    sourceCommitSha: String(row.source_commit_sha), rules, createdAt: String(row.created_at),
  };
}

export async function createAuthorizationPolicyBundle(input: {
  version: string;
  sourceCommitSha: string;
  rules: AuthorizationPolicyRule[];
  now?: Date;
}) {
  validate(input);
  const rules = canonicalRules(input.rules);
  const payload = canonicalPayload(input.version, input.sourceCommitSha, rules);
  const row = {
    id: randomUUID(), version: input.version, digest: digest(payload), sourceCommitSha: input.sourceCommitSha,
    policyJson: JSON.stringify(rules), createdAt: (input.now ?? new Date()).toISOString(),
  };
  const db = resolveDbClient();
  try {
    await db.run(
      `insert into authorization_policy_bundles
      (id,version,digest,source_commit_sha,policy_json,created_at) values(?,?,?,?,?,?)`,
      [row.id, row.version, row.digest, row.sourceCommitSha, row.policyJson, row.createdAt],
    );
  } catch (error) {
    if (error instanceof Error && /authorization_policy_bundles\.version|UNIQUE constraint failed: authorization_policy_bundles\.version|duplicate key value violates unique constraint/.test(error.message)) {
      throw new AuthorizationPolicyBundleError("POLICY_BUNDLE_VERSION_EXISTS");
    }
    throw error;
  }
  return deserialize((await db.get<Record<string, unknown>>("select * from authorization_policy_bundles where id=?", [row.id]))!);
}

export async function getAuthorizationPolicyBundle(version: string) {
  const row = await resolveDbClient().get<Record<string, unknown>>(
    "select * from authorization_policy_bundles where version=?", [version]);
  if (!row) throw new AuthorizationPolicyBundleError("POLICY_BUNDLE_NOT_FOUND");
  return deserialize(row);
}

export async function getActiveAuthorizationPolicyBundle() {
  const row = await resolveDbClient().get<Record<string, unknown>>(
    `select b.* from authorization_policy_active a
    join authorization_policy_bundles b on b.id=a.bundle_id where a.singleton_key='active'`);
  if (!row) throw new AuthorizationPolicyBundleError("AUTHORIZATION_POLICY_INACTIVE");
  return deserialize(row);
}

export async function activateAuthorizationPolicyBundle(input: { version: string; activatedBy: string; now?: Date }) {
  const db = resolveDbClient();
  const actor = await findStaffById(input.activatedBy);
  if (!actor || actor.status !== "active") throw new AuthorizationPolicyBundleError("POLICY_ACTIVATION_ACTOR_INVALID");
  const candidateRow = await db.get<Record<string, unknown>>(
    "select * from authorization_policy_bundles where version=?", [input.version]);
  if (!candidateRow) throw new AuthorizationPolicyBundleError("POLICY_BUNDLE_NOT_FOUND");
  const candidate = deserialize(candidateRow);
  const activatedAt = (input.now ?? new Date()).toISOString();

  await db.transaction(async (tx: DbClient) => {
    const current = await tx.get<{ bundle_id: string }>(
      "select bundle_id from authorization_policy_active where singleton_key='active'");
    await tx.run(
      `insert into authorization_policy_active(singleton_key,bundle_id,activated_by,activated_at)
      values('active',?,?,?) on conflict(singleton_key) do update set bundle_id=excluded.bundle_id,
      activated_by=excluded.activated_by,activated_at=excluded.activated_at`,
      [candidate.id, input.activatedBy, activatedAt],
    );
    await tx.run(
      `insert into authorization_policy_activation_history
      (id,bundle_id,previous_bundle_id,digest,source_commit_sha,activated_by,activated_at)
      values(?,?,?,?,?,?,?)`,
      [randomUUID(), candidate.id, current?.bundle_id ?? null, candidate.digest,
        candidate.sourceCommitSha, input.activatedBy, activatedAt],
    );
  });
  return getActiveAuthorizationPolicyBundle();
}
