export type LifecycleEventSource =
  | "billing_cancellation" | "billing_grace" | "billing_refund" | "billing_chargeback"
  | "billing_dispute" | "billing_reassignment" | "platform_security" | "reconciliation";

export type LifecycleEventType =
  | "cancellation_effective" | "cancellation_reversed"
  | "grace_started" | "grace_expired" | "grace_recovered"
  | "refund_confirmed" | "refund_partial_no_change"
  | "chargeback_confirmed" | "chargeback_reversed" | "dispute_opened"
  | "reassignment_effective"
  | "security_revoked";

export type SessionEffect = "preserve_to_hard_expiry" | "cancel_starting" | "immediate_revoke" | "none";

export type TransitionEffect = { newState: string | null; sessionEffect: SessionEffect };

// EN-003 rules 9-57: the exact state/session-effect this domain applies per
// event type. `newState: null` means the transition is audit-only — the
// effective-entitlement row's `state` column is left exactly as it already
// is. Cancellation (BI-004) and grace (BI-003) lapse are still written by
// their own existing lazy mechanism in cancellation-policy.ts/grace-
// policy.ts, unchanged; this ledger only records those events too, so every
// transition (old and new) lands in one immutable, auditable history
// (rules 8, 68).
//
// Known interaction, not solved here: EN-001's recomputeEffectiveEntitlement
// (entitlement-access/service.ts) unconditionally writes `state` to
// 'active'/'inactive' whenever it runs (e.g. a fresh paid-cycle event
// creates a new period). A future paid cycle after a refund/chargeback
// would therefore silently clear a terminal state this domain wrote —
// correct for refund re-purchase (rule 40), not obviously correct for a
// fraud/security suspension. Out of scope for this pass; flag if it comes
// up again.
export function resolveTransitionEffect(eventType: LifecycleEventType,
  input: { fraudOrSecurityRisk?: boolean } = {}): TransitionEffect {
  switch (eventType) {
    case "cancellation_effective": return { newState: null, sessionEffect: "preserve_to_hard_expiry" };
    case "cancellation_reversed": return { newState: "active", sessionEffect: "none" };
    case "grace_started": return { newState: "approved_grace", sessionEffect: "none" };
    case "grace_expired": return { newState: null, sessionEffect: "preserve_to_hard_expiry" };
    case "grace_recovered": return { newState: "active", sessionEffect: "none" };
    case "refund_confirmed": return { newState: "inactive_refunded", sessionEffect: "preserve_to_hard_expiry" };
    case "refund_partial_no_change": return { newState: null, sessionEffect: "none" };
    case "chargeback_confirmed": return input.fraudOrSecurityRisk
      ? { newState: "suspended_security", sessionEffect: "immediate_revoke" }
      : { newState: "suspended_financial", sessionEffect: "preserve_to_hard_expiry" };
    case "chargeback_reversed": return { newState: "active", sessionEffect: "none" };
    case "dispute_opened": return { newState: null, sessionEffect: "none" };
    case "reassignment_effective": return { newState: null, sessionEffect: "cancel_starting" };
    case "security_revoked": return { newState: "suspended_security", sessionEffect: "immediate_revoke" };
  }
}
