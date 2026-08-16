// PC-005: the canonical Third-Party Processor Register — every real
// external-provider integration point in this codebase (survey found
// exactly three: payment checkout, deployment hosting, transactional
// email) must have an entry here, linking it to its approved purpose,
// the frozen requirement that justifies it, and the exact minimal field
// set its own adapter interface accepts. No processor is actually LIVE
// yet — every adapter today is a local stand-in (`local*ProviderAdapter`)
// — so this register documents the readiness contract a future real
// integration must satisfy, not a currently-active data flow.

export type ProcessorEntry = {
  processorKey: string;
  purpose: string;
  requirementId: string;
  // The exact field names the processor's own adapter input type(s)
  // accept — re-verified against the live TS source in
  // tests/pc-005-processor-register.test.ts, same fail-closed pattern as
  // PC-001's schema-driven Data Catalog.
  approvedDataFields: readonly string[];
  subprocessors: string;
  retentionNote: string;
};

export const PROCESSOR_REGISTER: Record<string, ProcessorEntry> = {
  payment_checkout: {
    processorKey: "payment_checkout",
    purpose: "Process subscription checkout, renewal and refund payments.",
    requirementId: "BI-001",
    approvedDataFields: [
      "checkoutIntentId", "purchaserParentId", "assignedLearnerId", "productId", "productVersion",
      "priceId", "priceVersion", "amount", "currency", "billingInterval", "intervalCount", "autoRenewEnabled",
    ],
    subprocessors: "none declared",
    retentionNote: "Platform-side reference is checkout_intents/subscriptions — pseudonymous parent/learner IDs only, per PC-001's Data Catalog.",
  },
  deployment_hosting: {
    processorKey: "deployment_hosting",
    purpose: "Build, deploy and host each app's own environment.",
    requirementId: "AR-002",
    approvedDataFields: [
      "providerTeamId", "providerProjectId", "expectedRepository", "environment", "artifactDigest",
      "sourceCommitSha", "providerDeploymentId", "origin", "healthPath",
    ],
    subprocessors: "none declared",
    retentionNote: "No personal data of any kind is transmitted — build/project/technical identifiers only.",
  },
  transactional_email: {
    processorKey: "transactional_email",
    purpose: "Deliver transactional (non-marketing) parent-facing email.",
    requirementId: "NT-001",
    approvedDataFields: ["to", "subject", "text", "html", "idempotencyKey", "providerMessageId"],
    subprocessors: "none declared",
    retentionNote: "Destination is the parent's own verified email; NT-001 stores only a destination_hash platform-side (transactional_notification_deliveries, see PC-001 catalog).",
  },
};

export class ProcessorNotRegisteredError extends Error {
  constructor(public readonly processorKey: string) { super(`PROCESSOR_NOT_REGISTERED:${processorKey}`); }
}
export class UnapprovedProcessorFieldError extends Error {
  constructor(public readonly processorKey: string, public readonly fields: readonly string[]) {
    super(`UNAPPROVED_PROCESSOR_FIELDS:${processorKey}:${fields.join(",")}`);
  }
}

// Rule: "Unregistered processor access fails closed" / "Non-allowlisted
// fields cannot be transmitted." A real, callable runtime gate — not just
// documentation — wired into the checkout provider call site as the
// representative proof of the pattern (rule 8: material new exposure
// invokes PC-002 — adding a field here that isn't already part of an
// approved consent envelope is exactly the trigger point PC-002's
// material-change renewal exists for).
export function assertProcessorFieldsApproved(processorKey: string, fields: readonly string[]): void {
  const entry = PROCESSOR_REGISTER[processorKey];
  if (!entry) throw new ProcessorNotRegisteredError(processorKey);
  const unapproved = fields.filter((field) => !entry.approvedDataFields.includes(field));
  if (unapproved.length > 0) throw new UnapprovedProcessorFieldError(processorKey, unapproved);
}
