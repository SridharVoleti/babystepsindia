import type { CadenceCelebrationContext } from "./contracts";

const PREFIX = "babysteps:cadence-celebration:presented:";

export function cadenceCelebrationPresentationKey(sessionId: string, context: CadenceCelebrationContext) {
  return `${PREFIX}${context.appRef.appId}:${sessionId}:${context.weeklyKey}`;
}

// App-local, non-authoritative replay suppression. The app remains solely
// responsible for its art, copy, motion, audio, layout and controls.
export function shouldPresentCadenceCelebration(storage: Pick<Storage, "getItem">, sessionId: string,
  context: CadenceCelebrationContext) {
  return storage.getItem(cadenceCelebrationPresentationKey(sessionId, context)) !== "1";
}

export function markCadenceCelebrationPresented(storage: Pick<Storage, "setItem">, sessionId: string,
  context: CadenceCelebrationContext) {
  storage.setItem(cadenceCelebrationPresentationKey(sessionId, context), "1");
}
