// PD-004 AC23-30: cross-mode/bfcache/multi-tab staleness protection for the
// parent shell. Mirrors the pattern already proven for learner_mode's own
// launcher (src/lib/learner-home/refresh-controller.ts's
// LauncherRefreshCoordinator/LauncherInvalidationMessage) — same
// pageshow/visibility/BroadcastChannel shape, same "metadata only, no
// secrets in the cross-tab message" discipline (AT-PD-004-30) — but scoped
// to "is my rendered mode/generation still current", not launcher data
// refresh/retry, since the parent shell has no equivalent live data to
// re-fetch on a timer.

export const PARENT_MODE_INVALIDATION_CHANNEL = "babysteps-parent-mode";
export const PARENT_MODE_INVALIDATION_EVENT = "babysteps:parent-mode-invalidated";

export type ParentModeInvalidationMessage = {
  modeGeneration: number;
  reason: "mode_transition";
  sourceVersion: string;
};

export function isSafeParentModeInvalidationMessage(value: unknown): value is ParentModeInvalidationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return Number.isInteger(message.modeGeneration) && message.reason === "mode_transition"
    && typeof message.sourceVersion === "string";
}

export function createParentModeInvalidationMessage(input: ParentModeInvalidationMessage): ParentModeInvalidationMessage {
  if (!isSafeParentModeInvalidationMessage(input)) throw new Error("PARENT_MODE_INVALIDATION_MESSAGE_INVALID");
  return { ...input };
}

export type ParentModeGuardResult = "current" | "stale" | "unauthorized" | "mode_changed" | "network_error";

export type ModeContextProbe = { ok: boolean; status: number; modeGeneration?: number };

type ParentModeGuardOptions = {
  modeGeneration: number;
  fetchModeContext: (signal: AbortSignal) => Promise<ModeContextProbe>;
  // "stale"/"unauthorized" fail closed to a fresh login; "mode_changed" means
  // the session is fine but this browser is no longer in parent mode (it
  // entered learner mode — here or in another tab), which routes to /learner
  // instead of pointlessly forcing a re-login.
  onStale: (result: "stale" | "unauthorized" | "mode_changed") => void;
};

export class ParentModeGuardController {
  private destroyed = false;
  private pending: Promise<ParentModeGuardResult> | null = null;

  constructor(private readonly options: ParentModeGuardOptions) {}

  revalidate(): Promise<ParentModeGuardResult> {
    if (this.destroyed) return Promise.resolve("current");
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async run(): Promise<ParentModeGuardResult> {
    const controller = new AbortController();
    let probe: ModeContextProbe;
    try {
      probe = await this.options.fetchModeContext(controller.signal);
    } catch {
      return "network_error";
    }
    if (this.destroyed) return "current";
    // 403 = authenticated, but not in parent mode any more. During a
    // learner-mode unlock the current tab hits this against its own
    // now-stale shell probe — it must land on /learner, not /login.
    if (probe.status === 403) {
      this.options.onStale("mode_changed");
      return "mode_changed";
    }
    if (probe.status === 401) {
      this.options.onStale("unauthorized");
      return "unauthorized";
    }
    if (!probe.ok) return "network_error";
    if (typeof probe.modeGeneration === "number" && probe.modeGeneration !== this.options.modeGeneration) {
      this.options.onStale("stale");
      return "stale";
    }
    return "current";
  }

  // AT-PD-004-25: a bfcache-restored page fires pageshow with persisted=true
  // and made zero network requests to get there — this is the only signal
  // available to detect it, since no server code ran.
  pageshow(persisted: boolean) {
    if (persisted) void this.revalidate();
  }

  // AT-PD-004-29: catches a mode transition that happened in another tab
  // while this tab was hidden and never got the BroadcastChannel message
  // (channel delivery to a frozen/bfcached tab isn't guaranteed).
  visibilityReturned() {
    void this.revalidate();
  }

  // AT-PD-004-29/30: same-origin cross-tab signal, metadata only.
  receiveInvalidation(message: unknown) {
    if (!isSafeParentModeInvalidationMessage(message)) return;
    if (message.modeGeneration !== this.options.modeGeneration) void this.revalidate();
  }

  destroy() {
    this.destroyed = true;
  }
}

export async function fetchParentModeContext(signal: AbortSignal): Promise<ModeContextProbe> {
  const response = await fetch("/v1/parent/shell-context", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) return { ok: false, status: response.status };
  const body = await response.json() as { modeGeneration?: unknown };
  return { ok: true, status: response.status, modeGeneration: typeof body.modeGeneration === "number" ? body.modeGeneration : undefined };
}
