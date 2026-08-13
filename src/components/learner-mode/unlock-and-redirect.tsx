"use client";

import { useRouter } from "next/navigation";
import { PasskeyUnlock } from "./passkey-unlock";

// PD-004: "Open learner" invokes the exact existing AU-002/IA-004
// selection+unlock sequence — this wrapper only adds the redirect once
// that ceremony succeeds, it has no unlock logic of its own.
export function UnlockAndRedirect({ learnerId, learnerName, redirectTo }: {
  learnerId: string; learnerName: string; redirectTo: string;
}) {
  const router = useRouter();
  return <PasskeyUnlock learnerId={learnerId} learnerName={learnerName} onUnlocked={() => router.push(redirectTo)} />;
}
