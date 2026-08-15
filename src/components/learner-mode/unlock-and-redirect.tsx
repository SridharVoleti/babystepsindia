"use client";

import { useRouter } from "next/navigation";
import { PasskeyUnlock } from "./passkey-unlock";
import { createParentModeInvalidationMessage, PARENT_MODE_INVALIDATION_CHANNEL } from "@/lib/parent-shell/mode-guard";

// PD-004: "Open learner" invokes the exact existing AU-002/IA-004
// selection+unlock sequence — this wrapper only adds the redirect once
// that ceremony succeeds, it has no unlock logic of its own. AT-PD-004-29:
// broadcasts the new modeGeneration so any other open /account tab
// revalidates and fails closed rather than sitting on stale parent content.
export function UnlockAndRedirect({ learnerId, learnerName, redirectTo }: {
  learnerId: string; learnerName: string; redirectTo: string;
}) {
  const router = useRouter();
  return <PasskeyUnlock learnerId={learnerId} learnerName={learnerName} onUnlocked={(modeGeneration) => {
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(PARENT_MODE_INVALIDATION_CHANNEL);
        channel.postMessage(createParentModeInvalidationMessage({
          modeGeneration, reason: "mode_transition", sourceVersion: `learner_mode:${learnerId}`,
        }));
        channel.close();
      }
    } catch { /* BroadcastChannel unavailable — other tabs still fail closed on their own next fetch */ }
    router.push(redirectTo);
  }} />;
}
