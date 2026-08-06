import { beforeEach, describe, expect, it } from "vitest";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";

const now = new Date("2026-08-05T10:00:00.000Z");
const schedulerSecret = "scheduler-service-secret-at-least-32-characters";
const contributorSecret = "contributor-service-secret-at-least-32-characters";

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into platform_service_principals(id,service_key,key_ref,status,valid_from,valid_until,version)
    values('scheduler-id','analytics-scheduler','scheduler-ref','active','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',1),
          ('contributor-id','analytics-contributor','contributor-ref','active','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',1)`).run();
  process.env.PLATFORM_SERVICE_SECRETS = JSON.stringify({ "scheduler-ref": schedulerSecret,
    "contributor-ref": contributorSecret });
});

async function requestFor(serviceKey: string, audience: string, jti: string, secret: string) {
  const assertion = await createPlatformServiceAssertion({ serviceKey, audience, jti, now, secret });
  return new Request("http://localhost/v1/internal/analytics", {
    headers: { "x-babysteps-service-assertion": assertion },
  });
}

describe("AN-001 scoped internal service authentication", () => {
  it("allows the scheduler only for the run audience", async () => {
    const request = await requestFor("analytics-scheduler", "babysteps:internal:analytics:run", "run-1", schedulerSecret);
    expect((await requireInternalService(request, "scheduler", now)).ok).toBe(true);
  });

  it("denies scheduler assertions at the contribution boundary", async () => {
    const request = await requestFor("analytics-scheduler", "babysteps:internal:analytics:contribute", "cross-1", schedulerSecret);
    const result = await requireInternalService(request, "contributor", now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects missing and wrong-audience assertions", async () => {
    expect((await requireInternalService(new Request("http://localhost"), "scheduler", now)).ok).toBe(false);
    const wrongAudience = await requestFor("analytics-scheduler", "babysteps:wrong", "wrong-aud", schedulerSecret);
    expect((await requireInternalService(wrongAudience, "scheduler", now)).ok).toBe(false);
  });

  it("consumes each principal JTI exactly once", async () => {
    const request = await requestFor("analytics-contributor", "babysteps:internal:analytics:contribute",
      "contribution-replay", contributorSecret);
    expect((await requireInternalService(request, "contributor", now)).ok).toBe(true);
    const replay = await requireInternalService(request, "contributor", now);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.response.status).toBe(409);
  });
});
