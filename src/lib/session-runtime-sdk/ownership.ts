// GAP-079: exactly one tab may own (write to) a given session's runtime at
// a time. Web Locks gives us a real single-holder primitive scoped to the
// browser (works across same-origin tabs); BroadcastChannel tells sibling
// tabs when ownership changes so a non-owner tab can present a "paused,
// active in another tab" state instead of racing writes.
export type OwnerBroadcastMessage = { type: "owner-claimed" } | { type: "owner-released" };

export type TabOwnership = {
  isOwner: boolean;
  release: () => void;
  broadcast: BroadcastChannel;
};

function lockName(sessionId: string) {
  return `babysteps-session-owner-${sessionId}`;
}

export function channelName(sessionId: string) {
  return `babysteps-session-${sessionId}`;
}

export async function claimOwnerTab(sessionId: string): Promise<TabOwnership> {
  const broadcast = new BroadcastChannel(channelName(sessionId));
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) {
    // No Web Locks support in this browser: there is no way to coordinate
    // multiple tabs, so this tab proceeds as sole owner rather than
    // silently deadlocking — a real (if degraded) fallback, not a stub.
    return { isOwner: true, release: () => broadcast.close(), broadcast };
  }
  let releaseHeldLock: (() => void) | null = null;
  const acquired = await new Promise<boolean>((resolveOuter) => {
    void locks.request(lockName(sessionId), { ifAvailable: true }, (lock) => {
      if (!lock) { resolveOuter(false); return Promise.resolve(); }
      return new Promise<void>((resolveHold) => {
        releaseHeldLock = resolveHold;
        resolveOuter(true);
      });
    });
  });
  if (!acquired) {
    return { isOwner: false, release: () => broadcast.close(), broadcast };
  }
  broadcast.postMessage({ type: "owner-claimed" } satisfies OwnerBroadcastMessage);
  return {
    isOwner: true,
    release: () => {
      broadcast.postMessage({ type: "owner-released" } satisfies OwnerBroadcastMessage);
      releaseHeldLock?.();
      broadcast.close();
    },
    broadcast,
  };
}
