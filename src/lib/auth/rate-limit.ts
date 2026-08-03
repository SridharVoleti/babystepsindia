// In-memory fixed-window limiter — sufficient for a single Node process
// (local dev / single Vercel instance). Swap for a shared store (Upstash,
// Supabase) before running more than one instance, since counts here don't
// cross processes.

type Window = { count: number; resetAt: number };

let windows = new Map<string, Window>();

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }

  existing.count += 1;
  return true;
}

export function resetRateLimitsForTests() {
  windows = new Map();
}
