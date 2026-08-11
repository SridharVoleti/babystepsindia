import type { LauncherRefreshReason, VersionedLearnerHomeResponse } from "./contracts";

export const LAUNCHER_CACHE_PREFIX = "babysteps:launcher:v1:";
export const LAUNCHER_INVALIDATION_CHANNEL = "babysteps-launcher";
export const LAUNCHER_INVALIDATION_EVENT = "babysteps:launcher-invalidated";
export const VISIBILITY_REFRESH_THRESHOLD_MS = 30_000;

export type LauncherFreshnessStatus = "initializing" | "updating" | "fresh" | "stale" | "offline" | "unavailable";

export type LauncherRefreshSnapshot = {
  data: VersionedLearnerHomeResponse | null;
  status: LauncherFreshnessStatus;
  actionsDisabled: boolean;
  lastUpdatedAt: string | null;
  errorMessage: string | null;
};

export type LauncherRefreshMetric = {
  reason: LauncherRefreshReason;
  result: "success" | "not_modified" | "failed" | "offline" | "ignored";
  httpStatus: number | null;
  latencyMs: number;
  staleDurationMs: number;
  partialErrorCount: number;
  recordedAt: string;
};

export type LauncherInvalidationMessage = {
  contextGeneration: number;
  reason: "acknowledged_action" | "domain_change" | "security_invalidation";
  sourceVersion: string;
  opaqueAppReference?: string;
};

type FetchResult = {
  status: 200 | 304;
  etag: string | null;
  serverTime?: string | null;
  composedAt?: string | null;
  nextRecheckAt?: string | null;
  data?: VersionedLearnerHomeResponse;
};

type CachedLauncher = {
  contextBinding: string;
  learnerId: string;
  contextVersion: number;
  etag: string | null;
  receivedAt: string;
  data: VersionedLearnerHomeResponse;
};

type LauncherRefreshOptions = {
  contextBinding: string;
  learnerId: string;
  contextVersion: number;
  initialData?: VersionedLearnerHomeResponse;
  fetchLauncher: (input: { etag: string | null; reason: LauncherRefreshReason; signal: AbortSignal }) => Promise<FetchResult>;
  storage?: Storage;
  now?: () => number;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onAuthorizationLost?: (status: 401 | 403) => void;
  onContextStale?: () => void;
  onMetric?: (metric: LauncherRefreshMetric) => void;
};

class LauncherRefreshHttpError extends Error {
  constructor(public readonly status: number) { super(`LAUNCHER_REFRESH_HTTP_${status}`); }
}

const criticalReasons = new Set<LauncherRefreshReason>([
  "page_entry", "pageshow", "learner_unlock", "learner_switch", "security_invalidation",
]);
const priority: Record<LauncherRefreshReason, number> = {
  visibility_return: 1, online: 1, same_browser_invalidation: 2, reload: 2, manual_refresh: 2,
  server_boundary: 3, acknowledged_start: 4, acknowledged_resume: 4, acknowledged_cancel_start: 4,
  resume_later: 4, finish_now: 4, page_entry: 5, pageshow: 5, learner_unlock: 5,
  learner_switch: 6, security_invalidation: 7,
};

function cacheKey(contextBinding: string) { return `${LAUNCHER_CACHE_PREFIX}${contextBinding}`; }

function safeParseCache(value: string | null): CachedLauncher | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CachedLauncher;
    return parsed && typeof parsed.contextBinding === "string" && typeof parsed.learnerId === "string"
      && typeof parsed.contextVersion === "number" && typeof parsed.receivedAt === "string"
      && parsed.data && Array.isArray(parsed.data.cards) ? parsed : null;
  } catch { return null; }
}

export function clearForeignLauncherCaches(storage: Storage, activeContextBinding?: string) {
  const keep = activeContextBinding ? cacheKey(activeContextBinding) : null;
  const remove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(LAUNCHER_CACHE_PREFIX) && key !== keep) remove.push(key);
  }
  for (const key of remove) storage.removeItem(key);
}

export function isSafeLauncherInvalidationMessage(value: unknown): value is LauncherInvalidationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return Number.isInteger(message.contextGeneration) && typeof message.sourceVersion === "string"
    && ["acknowledged_action", "domain_change", "security_invalidation"].includes(String(message.reason))
    && (message.opaqueAppReference === undefined || typeof message.opaqueAppReference === "string");
}

export function createLauncherInvalidationMessage(input: LauncherInvalidationMessage) {
  if (!isSafeLauncherInvalidationMessage(input)) throw new Error("LAUNCHER_INVALIDATION_MESSAGE_INVALID");
  return { ...input };
}

export class LauncherRefreshCoordinator {
  private snapshot: LauncherRefreshSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly options: Required<Pick<LauncherRefreshOptions, "now" | "isVisible" | "isOnline" | "setTimer" | "clearTimer">>
    & LauncherRefreshOptions;
  private etag: string | null = null;
  private current: Promise<void> | null = null;
  private currentPriority = 0;
  private pendingReason: LauncherRefreshReason | null = null;
  private followUpActive = false;
  private requestGeneration = 0;
  private abortController: AbortController | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVisibilityRefreshAt = -Infinity;
  private staleSince: number | null = null;
  private destroyed = false;

  constructor(options: LauncherRefreshOptions) {
    this.options = {
      ...options,
      now: options.now ?? Date.now,
      isVisible: options.isVisible ?? (() => typeof document === "undefined" || document.visibilityState === "visible"),
      isOnline: options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine),
      setTimer: options.setTimer ?? setTimeout,
      clearTimer: options.clearTimer ?? clearTimeout,
    };
    const cached = options.storage ? safeParseCache(options.storage.getItem(cacheKey(options.contextBinding))) : null;
    if (options.storage) clearForeignLauncherCaches(options.storage, options.contextBinding);
    const validCache = cached?.contextBinding === options.contextBinding && cached.learnerId === options.learnerId
      && cached.contextVersion === options.contextVersion ? cached : null;
    const data = options.initialData ?? validCache?.data ?? null;
    this.etag = options.initialData ? `"${options.initialData.launcherVersion}.${options.contextVersion}"` : validCache?.etag ?? null;
    this.snapshot = {
      data, status: data ? "stale" : "initializing", actionsDisabled: true,
      lastUpdatedAt: validCache?.receivedAt ?? (options.initialData ? new Date(this.options.now()).toISOString() : null),
      errorMessage: null,
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private publish(patch: Partial<LauncherRefreshSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private persist(data: VersionedLearnerHomeResponse, etag: string | null, receivedAt: string) {
    if (!this.options.storage) return;
    const cached: CachedLauncher = { contextBinding: this.options.contextBinding, learnerId: this.options.learnerId,
      contextVersion: this.options.contextVersion, etag, receivedAt, data };
    this.options.storage.setItem(cacheKey(this.options.contextBinding), JSON.stringify(cached));
  }

  private clearProtectedCache() {
    this.options.storage?.removeItem(cacheKey(this.options.contextBinding));
    this.etag = null;
  }

  private scheduleBoundary(data: VersionedLearnerHomeResponse) {
    if (this.boundaryTimer) this.options.clearTimer(this.boundaryTimer);
    this.boundaryTimer = null;
    if (!data.nextRecheckAt) return;
    const delay = new Date(data.nextRecheckAt).getTime() - this.options.now();
    if (delay <= 0 || !Number.isFinite(delay)) return;
    this.boundaryTimer = this.options.setTimer(() => {
      this.boundaryTimer = null;
      if (!this.options.isVisible()) { this.markStale(); return; }
      void this.refresh("server_boundary");
    }, delay);
  }

  private record(reason: LauncherRefreshReason, result: LauncherRefreshMetric["result"], status: number | null,
    startedAt: number) {
    const now = this.options.now();
    this.options.onMetric?.({ reason, result, httpStatus: status, latencyMs: Math.max(0, now - startedAt),
      staleDurationMs: this.staleSince === null ? 0 : Math.max(0, now - this.staleSince),
      partialErrorCount: this.snapshot.data?.cards.filter((card) => card.status === "error").length ?? 0,
      recordedAt: new Date(now).toISOString() });
  }

  private markStale() {
    if (this.staleSince === null) this.staleSince = this.options.now();
    this.publish({ status: this.options.isOnline() ? "stale" : "offline", actionsDisabled: !this.options.isOnline(),
      errorMessage: null });
  }

  async refresh(reason: LauncherRefreshReason, followUp = false): Promise<void> {
    if (this.destroyed) return;
    if (!this.options.isVisible() && !["page_entry", "learner_switch", "learner_unlock"].includes(reason)) {
      this.markStale();
      return;
    }
    const now = this.options.now();
    if (reason === "visibility_return") {
      if (now - this.lastVisibilityRefreshAt < VISIBILITY_REFRESH_THRESHOLD_MS) return;
      this.lastVisibilityRefreshAt = now;
    }
    if (this.current) {
      if (!this.followUpActive && priority[reason] > this.currentPriority) this.pendingReason = reason;
      return this.current;
    }
    this.currentPriority = priority[reason];
    this.followUpActive = followUp;
    const generation = ++this.requestGeneration;
    this.abortController = new AbortController();
    const critical = criticalReasons.has(reason);
    this.publish({ status: "updating", actionsDisabled: critical || !this.snapshot.data || !this.options.isOnline(),
      errorMessage: null });
    const startedAt = this.options.now();
    this.current = (async () => {
      let lastError: unknown;
      const automatic = reason !== "manual_refresh";
      const maxAttempts = automatic ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const result = await this.options.fetchLauncher({ etag: this.etag, reason, signal: this.abortController!.signal });
          if (this.destroyed || generation !== this.requestGeneration) {
            this.record(reason, "ignored", result.status, startedAt); return;
          }
          if (result.status === 304) {
            if (!this.snapshot.data) throw new Error("LAUNCHER_304_WITHOUT_SAFE_CACHE");
            const receivedAt = new Date(this.options.now()).toISOString();
            const data = { ...this.snapshot.data,
              serverTime: result.serverTime ?? this.snapshot.data.serverTime,
              composedAt: result.composedAt ?? this.snapshot.data.composedAt,
              nextRecheckAt: result.nextRecheckAt === undefined
                ? this.snapshot.data.nextRecheckAt : result.nextRecheckAt };
            this.etag = result.etag ?? this.etag;
            this.persist(data, this.etag, receivedAt);
            this.staleSince = null;
            this.publish({ data, status: "fresh", actionsDisabled: false, lastUpdatedAt: receivedAt, errorMessage: null });
            this.scheduleBoundary(data);
            this.record(reason, "not_modified", 304, startedAt); return;
          }
          const data = result.data;
          if (!data || data.learnerId !== this.options.learnerId
            || data.selectedLearnerContextVersion !== this.options.contextVersion) {
            this.clearProtectedCache();
            this.publish({ data: null, status: "unavailable", actionsDisabled: true,
              errorMessage: "The learner context changed. Unlock the learner again." });
            this.options.onContextStale?.();
            this.record(reason, "ignored", 200, startedAt); return;
          }
          const receivedAt = new Date(this.options.now()).toISOString();
          this.etag = result.etag ?? `"${data.launcherVersion}.${this.options.contextVersion}"`;
          this.persist(data, this.etag, receivedAt);
          this.staleSince = null;
          this.publish({ data, status: "fresh", actionsDisabled: false, lastUpdatedAt: receivedAt, errorMessage: null });
          this.scheduleBoundary(data);
          this.record(reason, "success", 200, startedAt); return;
        } catch (error) {
          lastError = error;
          if (this.destroyed || generation !== this.requestGeneration || (error instanceof DOMException && error.name === "AbortError")) return;
          if (error instanceof LauncherRefreshHttpError && (error.status === 401 || error.status === 403)) {
            this.clearProtectedCache();
            this.publish({ data: null, status: "unavailable", actionsDisabled: true,
              errorMessage: "Learning mode needs to be unlocked again." });
            this.options.onAuthorizationLost?.(error.status);
            this.record(reason, "failed", error.status, startedAt); return;
          }
          if (error instanceof LauncherRefreshHttpError && error.status === 409) {
            this.clearProtectedCache();
            this.publish({ data: null, status: "unavailable", actionsDisabled: true,
              errorMessage: "The learner context is out of date. Unlock the learner again." });
            this.options.onContextStale?.();
            this.record(reason, "failed", 409, startedAt); return;
          }
          if (attempt < maxAttempts && this.options.isVisible() && this.options.isOnline()) {
            await new Promise<void>((resolve) => this.options.setTimer(resolve, 250 * 2 ** (attempt - 1)));
            continue;
          }
          break;
        }
      }
      const offline = !this.options.isOnline();
      if (this.staleSince === null) this.staleSince = this.options.now();
      this.publish({ status: offline ? "offline" : this.snapshot.data ? "stale" : "unavailable",
        actionsDisabled: offline || !this.snapshot.data,
        errorMessage: offline ? "You are offline. Start and Resume are unavailable."
          : "Could not refresh. Your last safe launcher is still shown." });
      this.record(reason, offline ? "offline" : "failed",
        lastError instanceof LauncherRefreshHttpError ? lastError.status : null, startedAt);
    })().finally(() => {
      this.current = null;
      this.currentPriority = 0;
      const pending = this.pendingReason;
      this.pendingReason = null;
      if (pending && !this.followUpActive && !this.destroyed) void this.refresh(pending, true);
      else this.followUpActive = false;
    });
    return this.current;
  }

  visibilityReturned(hiddenDurationMs: number) {
    if (hiddenDurationMs >= VISIBILITY_REFRESH_THRESHOLD_MS || this.snapshot.status === "stale" || this.snapshot.status === "offline") {
      void this.refresh("visibility_return");
    }
  }

  receiveInvalidation(message: unknown) {
    if (!isSafeLauncherInvalidationMessage(message) || message.contextGeneration !== this.options.contextVersion) return;
    if (!this.options.isVisible()) { this.markStale(); return; }
    void this.refresh(message.reason === "security_invalidation" ? "security_invalidation" : "same_browser_invalidation");
  }

  online() { if (this.options.isVisible()) void this.refresh("online"); else this.markStale(); }
  manualRefresh() { return this.refresh("manual_refresh"); }
  pageshow(persisted: boolean) { if (persisted) void this.refresh("pageshow"); }

  destroy(clearCache = false) {
    this.destroyed = true;
    this.requestGeneration += 1;
    this.abortController?.abort();
    if (this.boundaryTimer) this.options.clearTimer(this.boundaryTimer);
    if (clearCache) this.clearProtectedCache();
    this.listeners.clear();
  }
}

export async function fetchVersionedLearnerHome(input: {
  etag: string | null;
  reason: LauncherRefreshReason;
  signal: AbortSignal;
}): Promise<FetchResult> {
  const headers = new Headers({ "X-Launcher-Refresh-Reason": input.reason });
  if (input.etag) headers.set("If-None-Match", input.etag);
  const response = await fetch("/v1/learner-home", { method: "GET", headers, signal: input.signal,
    credentials: "same-origin", cache: "no-store" });
  if (response.status === 304) return { status: 304, etag: response.headers.get("etag"),
    serverTime: response.headers.get("x-launcher-server-time"),
    composedAt: response.headers.get("x-launcher-composed-at"),
    nextRecheckAt: response.headers.get("x-launcher-next-recheck-at") };
  if (!response.ok) throw new LauncherRefreshHttpError(response.status);
  return { status: 200, etag: response.headers.get("etag"), data: await response.json() as VersionedLearnerHomeResponse };
}
