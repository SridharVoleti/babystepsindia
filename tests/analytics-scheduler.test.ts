import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { previousKolkataActivityDate, invokeAnalyticsMonitor, invokeDailyAnalytics } from "../scripts/run-an001-daily.mjs";

describe("AN-001 daily scheduler (AT-AN-001-09)", () => {
  it("selects the previous Asia/Kolkata calendar date across UTC boundaries", () => {
    // 18:45 UTC on Aug 4 is 00:15 IST on Aug 5, so Aug 4 is the
    // explicitly processed previous local date.
    expect(previousKolkataActivityDate(new Date("2026-08-04T18:45:00.000Z"))).toBe("2026-08-04");
    expect(previousKolkataActivityDate(new Date("2026-01-01T18:45:00.000Z"))).toBe("2026-01-01");
    expect(previousKolkataActivityDate(new Date("2024-03-01T00:00:00.000Z"))).toBe("2024-02-29");
  });

  it("calls the authenticated endpoint with that explicit date", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "completed" }),
    });

    await invokeDailyAnalytics({
      baseUrl: "https://platform.example",
      secret: "s".repeat(32),
      now: new Date("2026-08-04T18:45:00.000Z"),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://platform.example/v1/internal/analytics/daily-runs/2026-08-04",
      expect.objectContaining({
        method: "POST",
        headers: { "x-babysteps-service-assertion": expect.any(String) },
      }),
    );
  });

  it("fails the job when configuration is missing or the endpoint rejects the run", async () => {
    await expect(invokeDailyAnalytics({ baseUrl: "", secret: "s".repeat(32) })).rejects.toThrow(
      "ANALYTICS_BASE_URL",
    );
    await expect(invokeDailyAnalytics({
      baseUrl: "https://platform.example",
      secret: "s".repeat(32),
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "failed" }),
    })).rejects.toThrow("status 500");
  });

  it("calls the independently authenticated monitoring endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ state: "healthy" }) });
    await invokeAnalyticsMonitor({ baseUrl: "https://platform.example", secret: "s".repeat(32), fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://platform.example/v1/internal/analytics/daily-runs/monitor",
      expect.objectContaining({ method: "POST",
        headers: { "x-babysteps-service-assertion": expect.any(String) } }),
    );
  });

  it("rejects an impossible manual recovery date before making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(invokeDailyAnalytics({
      baseUrl: "https://platform.example",
      secret: "s".repeat(32),
      activityDate: "2026-02-29",
      fetchImpl,
    })).rejects.toThrow("real calendar date");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("declares the 00:15 Asia/Kolkata production schedule", () => {
    const workflow = readFileSync(resolve(".github/workflows/an001-daily-analytics.yml"), "utf8");
    expect(workflow).toContain("cron: '45 18 * * *'");
    expect(workflow).toContain("cron: '20 19 * * *'");
    expect(workflow).toContain("ANALYTICS_BASE_URL");
    expect(workflow).toContain("ANALYTICS_SCHEDULER_SERVICE_SECRET");
    expect(workflow).toContain("scripts/run-an001-daily.mjs");
  });
});
