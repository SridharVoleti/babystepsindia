import { describe, expect, it } from "vitest";
import {
  classifyIntegrity,
  computeCanonicalStateHash,
  type IntegrityEvidence,
} from "@/lib/progress-integrity/service";

const healthyEvidence: IntegrityEvidence = {
  rowExists: true,
  hashMatches: true,
  schemaRegistered: true,
  payloadValidatesAgainstSchema: true,
  progressVersionPositiveMonotonic: true,
  sourceProvenanceSafe: true,
  legacyReceiptStatus: "not_required",
  migrationReceiptStatus: "none",
  completionOwnershipConflict: false,
  summaryRelation: "ok",
};

describe("PR-004 computeCanonicalStateHash", () => {
  it("is deterministic for identical input", () => {
    const input = { learnerId: "l1", appId: "a1", environment: "production", progressVersion: 3,
      schemaVersion: 2, serializedState: '{"level":"l1"}' };
    expect(computeCanonicalStateHash(input)).toBe(computeCanonicalStateHash(input));
  });

  it("changes when any folded-in field changes (identity, version, schema, state)", () => {
    const base = { learnerId: "l1", appId: "a1", environment: "production", progressVersion: 3,
      schemaVersion: 2, serializedState: '{"level":"l1"}' };
    const baseline = computeCanonicalStateHash(base);
    expect(computeCanonicalStateHash({ ...base, learnerId: "l2" })).not.toBe(baseline);
    expect(computeCanonicalStateHash({ ...base, appId: "a2" })).not.toBe(baseline);
    expect(computeCanonicalStateHash({ ...base, environment: "staging" })).not.toBe(baseline);
    expect(computeCanonicalStateHash({ ...base, progressVersion: 4 })).not.toBe(baseline);
    expect(computeCanonicalStateHash({ ...base, schemaVersion: 3 })).not.toBe(baseline);
    expect(computeCanonicalStateHash({ ...base, serializedState: '{"level":"l2"}' })).not.toBe(baseline);
  });

  it("hashes the literal serialized state text, not a reparsed object", () => {
    const a = computeCanonicalStateHash({ learnerId: "l1", appId: "a1", environment: "production",
      progressVersion: 1, schemaVersion: 1, serializedState: '{"a":1,"b":2}' });
    const b = computeCanonicalStateHash({ learnerId: "l1", appId: "a1", environment: "production",
      progressVersion: 1, schemaVersion: 1, serializedState: '{"b":2,"a":1}' });
    expect(a).not.toBe(b);
  });
});

describe("PR-004 classifyIntegrity", () => {
  it("classifies a never-validated (nonexistent) row as healthy", () => {
    const result = classifyIntegrity({ ...healthyEvidence, rowExists: false });
    expect(result).toEqual({ classification: "healthy", issueCodes: [], mutationBlocked: false, readSafe: true });
  });

  it("classifies a fully clean row as healthy", () => {
    const result = classifyIntegrity(healthyEvidence);
    expect(result).toEqual({ classification: "healthy", issueCodes: [], mutationBlocked: false, readSafe: true });
  });

  it.each([
    ["hashMatches", false, "HASH_MISMATCH"],
    ["schemaRegistered", false, "SCHEMA_VERSION_UNREGISTERED"],
    ["payloadValidatesAgainstSchema", false, "STATE_SCHEMA_INVALID"],
    ["progressVersionPositiveMonotonic", false, "PROGRESS_VERSION_NOT_POSITIVE"],
    ["sourceProvenanceSafe", false, "SOURCE_PROVENANCE_UNSAFE"],
  ] as const)("classifies %s=%s as unreadable_corrupt (%s), blocking reads and writes", (field, value, code) => {
    const result = classifyIntegrity({ ...healthyEvidence, [field]: value });
    expect(result.classification).toBe("unreadable_corrupt");
    expect(result.issueCodes).toContain(code);
    expect(result.mutationBlocked).toBe(true);
    expect(result.readSafe).toBe(false);
  });

  it("classifies an enforced-but-missing receipt as blocked_conflict", () => {
    const result = classifyIntegrity({ ...healthyEvidence, legacyReceiptStatus: "required_missing_enforced" });
    expect(result.classification).toBe("blocked_conflict");
    expect(result.issueCodes).toContain("RECEIPT_REQUIRED_MISSING");
    expect(result.mutationBlocked).toBe(true);
    expect(result.readSafe).toBe(false);
  });

  it("classifies a mismatched migration receipt as blocked_conflict", () => {
    const result = classifyIntegrity({ ...healthyEvidence, migrationReceiptStatus: "mismatched" });
    expect(result.classification).toBe("blocked_conflict");
    expect(result.issueCodes).toContain("RECEIPT_VERSION_MISMATCH");
  });

  it("classifies a lesson-completion ownership conflict as blocked_conflict", () => {
    const result = classifyIntegrity({ ...healthyEvidence, completionOwnershipConflict: true });
    expect(result.classification).toBe("blocked_conflict");
    expect(result.issueCodes).toContain("COMPLETION_OWNERSHIP_CONFLICT");
  });

  it("classifies a summary ahead of current progress_version as blocked_repairable_metadata, reads still safe", () => {
    const result = classifyIntegrity({ ...healthyEvidence, summaryRelation: "ahead" });
    expect(result.classification).toBe("blocked_repairable_metadata");
    expect(result.issueCodes).toContain("SUMMARY_VERSION_AHEAD");
    expect(result.mutationBlocked).toBe(true);
    expect(result.readSafe).toBe(true);
  });

  it("classifies an unlinked-but-matching migration receipt as blocked_repairable_metadata", () => {
    const result = classifyIntegrity({ ...healthyEvidence, migrationReceiptStatus: "unlinked" });
    expect(result.classification).toBe("blocked_repairable_metadata");
    expect(result.issueCodes).toContain("MIGRATION_RECEIPT_UNLINKED");
  });

  it("classifies a legacy row with an unenforced missing receipt as read_only_safe", () => {
    const result = classifyIntegrity({ ...healthyEvidence, legacyReceiptStatus: "required_missing_unenforced" });
    expect(result.classification).toBe("read_only_safe");
    expect(result.issueCodes).toContain("LEGACY_RECEIPT_MISSING_UNENFORCED");
    expect(result.mutationBlocked).toBe(true);
    expect(result.readSafe).toBe(true);
  });

  it("classifies a summary behind current progress_version as read_only_safe (stale, not corrupt)", () => {
    const result = classifyIntegrity({ ...healthyEvidence, summaryRelation: "stale" });
    expect(result.classification).toBe("read_only_safe");
    expect(result.issueCodes).toContain("SUMMARY_STALE");
  });

  it("picks the most severe classification when multiple issues coexist, and accumulates every issue code", () => {
    const result = classifyIntegrity({ ...healthyEvidence, summaryRelation: "stale", hashMatches: false });
    expect(result.classification).toBe("unreadable_corrupt");
    expect(result.issueCodes).toEqual(expect.arrayContaining(["HASH_MISMATCH", "SUMMARY_STALE"]));
    expect(result.issueCodes).toHaveLength(2);
  });
});
