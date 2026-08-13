import { createLauncherInvalidationMessage, LAUNCHER_INVALIDATION_CHANNEL,
  LAUNCHER_INVALIDATION_EVENT } from "@/lib/learner-home/refresh-controller";
import type { CadenceCelebrationContext } from "@/lib/cadence-celebration/contracts";

export { LAUNCHER_INVALIDATION_CHANNEL, LAUNCHER_INVALIDATION_EVENT };

export type ExitAcknowledgement = {
  sessionId: string;
  sessionStatus: string;
  sessionVersion: number;
  hardExpiresAt: string | null;
  lastAcknowledgedProgressVersion: number;
  allowedActions: string[];
  returnUrl?: string;
  cadenceCelebrationContext?: CadenceCelebrationContext;
};

export type ExitActionRequest = {
  acknowledgedProgressVersion: number;
  idempotencyKey: string;
};

export function createExitIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `exit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// UL-003 consumes this safe, same-browser signal on launcher return. It
// contains only an action category and session version—never progress state,
// learner answers, tokens, funding details or billing data.
export function emitLauncherExitInvalidation(action: "resume_later" | "finish_now", result: ExitAcknowledgement,
  contextGeneration?: number) {
  if (typeof window === "undefined") return;
  const detail = { reason: action, sessionId: result.sessionId, sessionVersion: result.sessionVersion };
  window.dispatchEvent(new CustomEvent(LAUNCHER_INVALIDATION_EVENT, { detail }));
  // Cross-tab invalidation requires the exact learner-context generation.
  // A legacy shell may still notify its own window but cannot broadcast an
  // unpartitioned signal into another learner's launcher context.
  if (Number.isInteger(contextGeneration) && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(LAUNCHER_INVALIDATION_CHANNEL);
    channel.postMessage(createLauncherInvalidationMessage({ contextGeneration: contextGeneration!,
      reason: "acknowledged_action", sourceVersion: `session:${result.sessionVersion}` }));
    channel.close();
  }
}
