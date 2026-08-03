import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, resetRateLimitsForTests } from "@/lib/auth/rate-limit";

beforeEach(() => {
  resetRateLimitsForTests();
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows attempts up to the limit within the window", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("login:parent@example.com", 5, 60_000)).toBe(true);
    }
  });

  it("denies once the limit is exceeded within the window", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("login:parent@example.com", 5, 60_000);
    }
    expect(checkRateLimit("login:parent@example.com", 5, 60_000)).toBe(false);
  });

  it("tracks separate keys independently", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("login:a@example.com", 5, 60_000);
    }
    expect(checkRateLimit("login:a@example.com", 5, 60_000)).toBe(false);
    expect(checkRateLimit("login:b@example.com", 5, 60_000)).toBe(true);
  });

  it("resets once the window elapses", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        checkRateLimit("login:parent@example.com", 5, 60_000);
      }
      expect(checkRateLimit("login:parent@example.com", 5, 60_000)).toBe(false);

      vi.advanceTimersByTime(60_001);

      expect(checkRateLimit("login:parent@example.com", 5, 60_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
