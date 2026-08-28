"use client";

import { useState } from "react";
import type { LearnerHomeCard, VersionedLearnerHomeResponse } from "@/lib/learner-home/contracts";
import { LearnerLauncher } from "@/components/learner-home/learner-launcher";

// LP-004: the client half of "tap Start → the game opens with the child
// signed in". `LearnerLauncher` has always accepted an `onPrimaryAction`
// prop but nothing in the app supplied one, so every Start/Resume button
// rendered disabled. This wrapper supplies it.
//
// Start flow: POST /v1/learner-sessions (creates the reserved session) →
// POST /v1/learner-sessions/{id}/launch-dispatch (mints the one-time code
// and returns an auto-submitting HTML form) → the returned HTML replaces
// the current document, which immediately POSTs the handoff to the app's
// own /launch route.
//
// Resume is deliberately not handled here — a disconnected session resumes
// from inside the app (SC-001), not by re-dispatching a launch from the
// launcher.

function newIdempotencyKey() {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    /* fall through */
  }
  return `HTTP_${response.status}`;
}

export function LearnerLaunchController(props: {
  learnerName: string;
  learnerId: string;
  contextVersion: number;
  contextBinding: string;
  initialData: VersionedLearnerHomeResponse;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onPrimaryAction(card: LearnerHomeCard) {
    if (busy) return;
    if (card.primaryAction !== "start") {
      setError("Resuming happens inside the app, not from here.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const startResponse = await fetch("/v1/learner-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: card.appId, idempotencyKey: newIdempotencyKey() }),
      });
      if (!startResponse.ok) {
        setError(await readError(startResponse));
        return;
      }
      const started = (await startResponse.json()) as { sessionId?: string };
      if (!started.sessionId) {
        setError("SESSION_NOT_CREATED");
        return;
      }
      const dispatchResponse = await fetch(
        `/v1/learner-sessions/${encodeURIComponent(started.sessionId)}/launch-dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: 1, idempotencyKey: newIdempotencyKey() }),
        },
      );
      if (!dispatchResponse.ok) {
        setError(await readError(dispatchResponse));
        return;
      }
      const html = await dispatchResponse.text();
      document.open();
      document.write(html);
      document.close();
    } catch {
      setError("LAUNCH_REQUEST_FAILED");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Could not open the app ({error}). Please try again.
        </p>
      )}
      <LearnerLauncher
        learnerName={props.learnerName}
        learnerId={props.learnerId}
        contextVersion={props.contextVersion}
        contextBinding={props.contextBinding}
        initialData={props.initialData}
        onPrimaryAction={onPrimaryAction}
      />
    </>
  );
}
