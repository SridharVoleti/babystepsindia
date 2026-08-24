import { evaluateAccessFresh, type AccessDecision } from "./service";

// GAP-106: a bounded, read-only cache for launcher/home-screen display only
// — it must never be consulted to authorize Start, launch exchange, usable
// launch or resume, all of which call evaluateAccessFresh directly and are
// untouched by this module. Per-process (not shared across serverless
// instances) is an acceptable tradeoff here precisely because nothing
// security-relevant ever reads from it — worst case is an instance showing
// a slightly stale "you have access" on a home screen for up to MAX_TTL_MS,
// never a live session start.
const MAX_TTL_MS = 60_000;

type CacheEntry = { decision: AccessDecision; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(learnerId: string, appId: string, environment: string) {
  return `${learnerId}:${appId}:${environment}`;
}

export async function evaluateAccessForLauncher(input: {
  learnerId: string; appId: string; environment: string; now: Date;
}): Promise<AccessDecision> {
  const key = cacheKey(input.learnerId, input.appId, input.environment);
  const nowMs = input.now.getTime();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.decision;

  const decision = await evaluateAccessFresh({
    learnerId: input.learnerId, appId: input.appId, environment: input.environment,
    useCase: "launcher", now: input.now,
  });
  // Expires at the sooner of the fixed TTL cap or the decision's own
  // nearest entitlement/app boundary — a lapsing period is never shown
  // stale past the instant it actually lapses.
  const boundaryMs = decision.accessUntil ? new Date(decision.accessUntil).getTime() : Infinity;
  cache.set(key, { decision, expiresAt: Math.min(nowMs + MAX_TTL_MS, boundaryMs) });
  return decision;
}

export function clearLauncherAccessCache() {
  cache.clear();
}
