import { resolveDbClient } from "@/lib/db-client";
import { reconcileLearnerApp } from "@/lib/entitlement-integrity/repair";

export type AttemptLazyRepairInput = {
  learnerId: string; appId: string; environment: string; timeoutMs: number; now: Date;
};

export type AttemptLazyRepairResult = { attempted: boolean; repaired: boolean; timedOut: boolean };

// EN-004 rules 51-52: a strict wall-clock-bounded repair check, callable
// from an access-evaluation path when a verified source exists but target
// readiness is missing. Built and unit-tested standalone this session —
// deliberately NOT called from evaluateAccessFresh or the learner-home
// route yet (see README's "not yet built" callout); wiring it into that
// live, frequently-hit path was judged a separate decision, not this
// session's call to make unilaterally.
export async function attemptLazyRepair(input: AttemptLazyRepairInput): Promise<AttemptLazyRepairResult> {
  const deadline = Date.now() + input.timeoutMs;
  if (Date.now() > deadline) return { attempted: false, repaired: false, timedOut: true };

  const effective = await resolveDbClient().get<{ effective_version: number }>(
    "select effective_version from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?",
    [input.learnerId, input.appId, input.environment],
  );

  try {
    const result = await reconcileLearnerApp({
      learnerId: input.learnerId, appId: input.appId, environment: input.environment,
      expectedSourceVersion: effective?.effective_version ?? 0, principalId: "entitlement-integrity-monitor-service",
      runIdempotencyKey: `lazy:${input.learnerId}:${input.appId}:${input.environment}:${input.now.toISOString()}`,
      now: input.now,
    });
    if (Date.now() > deadline) return { attempted: true, repaired: false, timedOut: true };
    return { attempted: true, repaired: result.action === "repair", timedOut: false };
  } catch {
    return { attempted: true, repaired: false, timedOut: false };
  }
}
