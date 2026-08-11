"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createExitIdempotencyKey,
  emitLauncherExitInvalidation,
  type ExitAcknowledgement,
  type ExitActionRequest,
} from "@/lib/session-exit/client";

type ExitPhase = "idle" | "checking" | "saving" | "making_resumable" | "finalizing" | "failed" | "complete";
type ExitChoice = "resume_later" | "finish_now";

export type SessionExitFlowProps = {
  sessionStatus: "active" | "resumable";
  lastAcknowledgedProgressVersion: number;
  hasMeaningfulUnsavedProgress: boolean;
  checkpoint?: () => Promise<{ progressVersion: number }>;
  markResumable: (request: ExitActionRequest) => Promise<ExitAcknowledgement>;
  finishSession: (request: ExitActionRequest) => Promise<ExitAcknowledgement>;
  onAcknowledged: (result: ExitAcknowledgement, choice: ExitChoice) => void;
  launcherContextGeneration?: number;
  onCancel?: () => void;
  protectNavigation?: boolean;
};

export function SessionExitFlow({
  sessionStatus,
  lastAcknowledgedProgressVersion,
  hasMeaningfulUnsavedProgress,
  checkpoint,
  markResumable,
  finishSession,
  onAcknowledged,
  launcherContextGeneration,
  onCancel,
  protectNavigation = true,
}: SessionExitFlowProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ExitPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastChoice, setLastChoice] = useState<ExitChoice | null>(null);
  const [savedProgressVersion, setSavedProgressVersion] = useState<number | null>(null);
  const keys = useRef<Record<ExitChoice, string>>({
    resume_later: createExitIdempotencyKey(),
    finish_now: createExitIdempotencyKey(),
  });
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const busy = !["idle", "failed", "complete"].includes(phase);

  const show = useCallback(() => {
    opener.current = document.activeElement as HTMLElement | null;
    setError(null);
    setPhase("idle");
    setOpen(true);
  }, []);

  const dismiss = useCallback(() => {
    if (busy) return;
    setOpen(false);
    setError(null);
    setPhase("idle");
    setLastChoice(null);
    onCancel?.();
    queueMicrotask(() => opener.current?.focus());
  }, [busy, onCancel]);

  useEffect(() => {
    if (!protectNavigation) return;
    const onPopState = () => show();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onDocumentClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const destination = new URL(link.href, window.location.href);
      if (destination.href === window.location.href) return;
      event.preventDefault();
      show();
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [protectNavigation, show]);

  useEffect(() => {
    if (!open) return;
    const first = dialog.current?.querySelector<HTMLElement>("button:not([disabled])");
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
      if (!focusable.length) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault(); lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault(); firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismiss, open]);

  async function choose(choice: ExitChoice) {
    if (busy) return;
    setLastChoice(choice);
    setError(null);
    try {
      setPhase("checking");
      let progressVersion = savedProgressVersion ?? lastAcknowledgedProgressVersion;
      if (hasMeaningfulUnsavedProgress && savedProgressVersion === null) {
        if (!checkpoint) throw new Error("Recent progress has not been saved. Continue learning or try again.");
        setPhase("saving");
        const checkpointResult = await checkpoint();
        progressVersion = checkpointResult.progressVersion;
        setSavedProgressVersion(progressVersion);
      }
      setPhase(choice === "resume_later" ? "making_resumable" : "finalizing");
      const request = { acknowledgedProgressVersion: progressVersion, idempotencyKey: keys.current[choice] };
      const result = choice === "resume_later" ? await markResumable(request) : await finishSession(request);
      setPhase("complete");
      emitLauncherExitInvalidation(choice, result, launcherContextGeneration);
      onAcknowledged(result, choice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not complete that exit action. Please try again.");
      setPhase("failed");
    }
  }

  const statusText = phase === "checking" ? "Checking your latest saved point…"
    : phase === "saving" ? "Saving recent progress…"
    : phase === "making_resumable" ? "Preparing this session to resume later…"
    : phase === "finalizing" ? "Finishing this session…"
    : phase === "complete" ? "Exit acknowledged. Returning to Babysteps…"
    : hasMeaningfulUnsavedProgress && savedProgressVersion === null
      ? "You have recent progress that must be saved before leaving."
      : "Your latest meaningful progress is saved.";

  return <>
    <button type="button" onClick={show}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-400 bg-white px-4 py-2 font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700">
      Return to Babysteps
    </button>
    {open ? <div className="fixed inset-0 z-50 flex items-end bg-slate-950/60 sm:items-center sm:justify-center"
      aria-hidden={false}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="session-exit-title"
        aria-describedby="session-exit-status"
        className="w-full rounded-t-2xl bg-white p-6 shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <h2 id="session-exit-title" className="text-xl font-semibold text-slate-950">Return to Babysteps?</h2>
        <p id="session-exit-status" role="status" aria-live="polite" className="mt-3 font-medium text-slate-800">
          {statusText}
        </p>
        {error ? <div role="alert" className="mt-3 rounded-lg border border-red-700 bg-red-50 p-3 text-sm text-red-950">
          <span className="font-semibold">Action not completed.</span> {error}
        </div> : null}
        <div className="mt-5 grid gap-3">
          <button type="button" disabled={busy}
            onClick={() => void choose("resume_later")}
            className="min-h-11 rounded-lg bg-blue-700 px-4 py-3 text-left font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">
            Resume this session later
            <span className="mt-1 block text-sm font-normal">Keep this same session until its current hard expiry. Other apps stay blocked.</span>
          </button>
          <button type="button" disabled={busy} onClick={() => void choose("finish_now")}
            className="min-h-11 rounded-lg border-2 border-slate-800 bg-white px-4 py-3 text-left font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-60">
            Finish session now
            <span className="mt-1 block text-sm font-normal">Finalize the session now. The consumed credit is not restored.</span>
          </button>
          <button type="button" disabled={busy} onClick={dismiss}
            className="min-h-11 rounded-lg px-4 py-3 font-medium text-slate-800 underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60">
            Continue learning
          </button>
        </div>
        {phase === "failed" && lastChoice ? <p className="mt-3 text-sm text-slate-700">
          Retry uses the same protected request. Your session remains {sessionStatus} until the server acknowledges a change.
        </p> : null}
      </div>
    </div> : null}
  </>;
}
