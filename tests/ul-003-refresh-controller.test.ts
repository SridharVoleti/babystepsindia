import { describe, expect, it, vi } from "vitest";
import { LauncherRefreshCoordinator, createLauncherInvalidationMessage,
  LAUNCHER_CACHE_PREFIX } from "@/lib/learner-home/refresh-controller";
import type { VersionedLearnerHomeResponse } from "@/lib/learner-home/contracts";

function home(overrides: Partial<VersionedLearnerHomeResponse> = {}): VersionedLearnerHomeResponse {
  return { learnerId: "learner-1", launcherVersion: "version-1", serverTime: "2026-08-11T00:00:00.000Z",
    composedAt: "2026-08-11T00:00:00.000Z", nextRecheckAt: null, cacheMaxAgeSeconds: 60,
    selectedLearnerContextVersion: 4, activeSession: null, cards: [], ...overrides };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); },
  };
}

describe("UL-003 launcher refresh coordinator", () => {
  it("performs an exact-context conditional entry refresh and safely retains cards on 304", async () => {
    const fetchLauncher = vi.fn(async ({ etag }: { etag: string | null }) => ({ status: 304 as const, etag }));
    const coordinator = new LauncherRefreshCoordinator({ contextBinding: "context-a", learnerId: "learner-1",
      contextVersion: 4, initialData: home(), fetchLauncher, storage: memoryStorage() });
    await coordinator.refresh("page_entry");
    expect(fetchLauncher).toHaveBeenCalledWith(expect.objectContaining({ etag: '"version-1.4"', reason: "page_entry" }));
    expect(coordinator.getSnapshot()).toMatchObject({ status: "fresh", actionsDisabled: false,
      data: { launcherVersion: "version-1" } });
  });

  it("coalesces simultaneous triggers and permits at most one higher-priority follow-up", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const fetchLauncher = vi.fn()
      .mockImplementationOnce(async () => { await first; return { status: 304 as const, etag: '"version-1"' }; })
      .mockResolvedValue({ status: 304 as const, etag: '"version-1"' });
    const coordinator = new LauncherRefreshCoordinator({ contextBinding: "context-a", learnerId: "learner-1",
      contextVersion: 4, initialData: home(), fetchLauncher });
    const inFlight = coordinator.refresh("visibility_return");
    void coordinator.refresh("online");
    void coordinator.refresh("finish_now");
    void coordinator.refresh("security_invalidation");
    expect(fetchLauncher).toHaveBeenCalledTimes(1);
    release();
    await inFlight;
    await vi.waitFor(() => expect(fetchLauncher).toHaveBeenCalledTimes(2));
    expect(fetchLauncher.mock.calls[1][0].reason).toBe("security_invalidation");
  });

  it("marks a hidden invalidation stale without a network request and refreshes once on visibility return", async () => {
    let visible = false;
    const fetchLauncher = vi.fn().mockResolvedValue({ status: 304 as const, etag: '"version-1"' });
    const coordinator = new LauncherRefreshCoordinator({ contextBinding: "context-a", learnerId: "learner-1",
      contextVersion: 4, initialData: home(), fetchLauncher, isVisible: () => visible });
    coordinator.receiveInvalidation(createLauncherInvalidationMessage({ contextGeneration: 4,
      reason: "acknowledged_action", sourceVersion: "session:2" }));
    expect(fetchLauncher).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().status).toBe("stale");
    visible = true;
    coordinator.visibilityReturned(31_000);
    await vi.waitFor(() => expect(fetchLauncher).toHaveBeenCalledTimes(1));
  });

  it("rejects a foreign-context response, clears its protected cache and requests one context revalidation", async () => {
    const storage = memoryStorage();
    const onContextStale = vi.fn();
    const coordinator = new LauncherRefreshCoordinator({ contextBinding: "context-a", learnerId: "learner-1",
      contextVersion: 4, initialData: home(), storage, onContextStale,
      fetchLauncher: vi.fn().mockResolvedValue({ status: 200 as const, etag: '"foreign"',
        data: home({ learnerId: "learner-2" }) }) });
    await coordinator.refresh("page_entry");
    expect(coordinator.getSnapshot()).toMatchObject({ data: null, status: "unavailable", actionsDisabled: true });
    expect(onContextStale).toHaveBeenCalledTimes(1);
    expect([...Array(storage.length)].map((_, index) => storage.key(index))
      .filter((key) => key?.startsWith(LAUNCHER_CACHE_PREFIX))).toEqual([]);
  });

  it("uses a maximum of three bounded attempts for one automatic event and schedules no periodic retry", async () => {
    const fetchLauncher = vi.fn().mockRejectedValue(new Error("offline"));
    const immediateTimer = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const coordinator = new LauncherRefreshCoordinator({ contextBinding: "context-a", learnerId: "learner-1",
      contextVersion: 4, initialData: home(), fetchLauncher, setTimer: immediateTimer,
      isOnline: () => true, isVisible: () => true });
    await coordinator.refresh("online");
    expect(fetchLauncher).toHaveBeenCalledTimes(3);
    expect(coordinator.getSnapshot()).toMatchObject({ status: "stale", actionsDisabled: false });
  });

  it("still fails gracefully to stale data when the retry backoff uses the real default timer", async () => {
    // Regression: the default setTimer was a bare `setTimeout` reference,
    // which throws "Illegal invocation" in a browser when the retry-backoff
    // path invoked `this.options.setTimer(resolve, ...)` — wedging the
    // launcher in "updating" with Start disabled after any failed refresh.
    vi.useFakeTimers();
    try {
      const fetchLauncher = vi.fn().mockRejectedValue(new Error("boom"));
      const coordinator = new LauncherRefreshCoordinator({ contextBinding: "context-a", learnerId: "learner-1",
        contextVersion: 4, initialData: home(), fetchLauncher, isOnline: () => true, isVisible: () => true });
      const settled = coordinator.refresh("page_entry");
      await vi.runAllTimersAsync();
      await settled;
      expect(fetchLauncher).toHaveBeenCalledTimes(3);
      expect(coordinator.getSnapshot()).toMatchObject({ status: "stale", actionsDisabled: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
