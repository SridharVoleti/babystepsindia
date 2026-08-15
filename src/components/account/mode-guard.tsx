"use client";

import { useEffect } from "react";
import {
  ParentModeGuardController,
  fetchParentModeContext,
  isSafeParentModeInvalidationMessage,
  PARENT_MODE_INVALIDATION_CHANNEL,
  PARENT_MODE_INVALIDATION_EVENT,
} from "@/lib/parent-shell/mode-guard";

// PD-004 AC23-30: renders nothing — a pure background guard mounted once by
// account/layout.tsx. On a stale mode/generation (bfcache restore across a
// mode transition, browser Back/Forward, another tab's transition) it fails
// closed by forcing a fresh login rather than trying to route to the
// "right" place — same simplification the learner-side launcher's own
// onAuthorizationLost already makes (redirect to /login, not a guessed
// destination).
export function ParentModeGuard({ modeGeneration }: { modeGeneration: number }) {
  useEffect(() => {
    const controller = new ParentModeGuardController({
      modeGeneration,
      fetchModeContext: fetchParentModeContext,
      onStale: () => window.location.replace("/login"),
    });

    const pageshow = (event: PageTransitionEvent) => controller.pageshow(event.persisted);
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    const visibility = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (hiddenAt !== null) controller.visibilityReturned();
      hiddenAt = null;
    };
    const focus = () => { if (hiddenAt !== null) controller.visibilityReturned(); };
    const invalidation = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      controller.receiveInvalidation(detail);
    };

    window.addEventListener("pageshow", pageshow);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    window.addEventListener(PARENT_MODE_INVALIDATION_EVENT, invalidation);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(PARENT_MODE_INVALIDATION_CHANNEL);
      channel.onmessage = (event) => {
        if (isSafeParentModeInvalidationMessage(event.data)) controller.receiveInvalidation(event.data);
      };
    }

    return () => {
      controller.destroy();
      window.removeEventListener("pageshow", pageshow);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener(PARENT_MODE_INVALIDATION_EVENT, invalidation);
      channel?.close();
    };
  }, [modeGeneration]);

  return null;
}
