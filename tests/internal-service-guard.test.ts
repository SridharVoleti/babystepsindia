import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireInternalService } from "@/lib/auth/internal-service-guard";

const ORIGINAL_SECRET = process.env.ANALYTICS_INTERNAL_SERVICE_SECRET;

beforeEach(() => {
  process.env.ANALYTICS_INTERNAL_SERVICE_SECRET = "test-only-internal-service-secret-32b";
});

afterEach(() => {
  process.env.ANALYTICS_INTERNAL_SERVICE_SECRET = ORIGINAL_SECRET;
});

function requestWith(header: string | null) {
  const headers = new Headers();
  if (header !== null) headers.set("x-internal-service-secret", header);
  return new Request("http://localhost/v1/internal/analytics/daily-contribution", { headers });
}

// AC31: internal contribution/job endpoints are unavailable to browsers.
describe("requireInternalService", () => {
  it("allows a request presenting the correct shared secret", () => {
    const result = requireInternalService(requestWith("test-only-internal-service-secret-32b"));
    expect(result.ok).toBe(true);
  });

  it("rejects a request with no secret header (an ordinary browser call)", () => {
    const result = requireInternalService(requestWith(null));
    expect(result.ok).toBe(false);
  });

  it("rejects a request with the wrong secret", () => {
    const result = requireInternalService(requestWith("guessed-secret"));
    expect(result.ok).toBe(false);
  });

  it("fails closed when the server has no configured secret", () => {
    delete process.env.ANALYTICS_INTERNAL_SERVICE_SECRET;
    const result = requireInternalService(requestWith("anything"));
    expect(result.ok).toBe(false);
  });
});
