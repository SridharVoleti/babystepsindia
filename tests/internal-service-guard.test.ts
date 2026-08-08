import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";

const now = new Date("2026-08-05T10:00:00.000Z");
const schedulerKeys = generateKeyPairSync("ed25519");
const contributorKeys = generateKeyPairSync("ed25519");
const schedulerPrivateKeyPem = schedulerKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const contributorPrivateKeyPem = contributorKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
    values('scheduler-id','analytics-scheduler','scheduler-ref',?,'active','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',1),
          ('contributor-id','analytics-contributor','contributor-ref',?,'active','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',1)`)
    .run(schedulerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      contributorKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
});

function requestFor(serviceKey: string, audience: string, jti: string, privateKeyPem: string) {
  const assertion = createPlatformServiceAssertion({ serviceKey, audience, jti, now, privateKeyPem });
  return new Request("http://localhost/v1/internal/analytics", {
    headers: { "x-babysteps-service-assertion": assertion },
  });
}

describe("AN-001 scoped internal service authentication", () => {
  it("allows the scheduler only for the run audience", async () => {
    const request = requestFor("analytics-scheduler", "babysteps:internal:analytics:run", "run-1", schedulerPrivateKeyPem);
    expect((await requireInternalService(request, "scheduler", now)).ok).toBe(true);
  });

  it("denies scheduler assertions at the contribution boundary", async () => {
    const request = requestFor("analytics-scheduler", "babysteps:internal:analytics:contribute", "cross-1", schedulerPrivateKeyPem);
    const result = await requireInternalService(request, "contributor", now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects missing and wrong-audience assertions", async () => {
    expect((await requireInternalService(new Request("http://localhost"), "scheduler", now)).ok).toBe(false);
    const wrongAudience = requestFor("analytics-scheduler", "babysteps:wrong", "wrong-aud", schedulerPrivateKeyPem);
    expect((await requireInternalService(wrongAudience, "scheduler", now)).ok).toBe(false);
  });

  it("consumes each principal JTI exactly once", async () => {
    const request = requestFor("analytics-contributor", "babysteps:internal:analytics:contribute",
      "contribution-replay", contributorPrivateKeyPem);
    expect((await requireInternalService(request, "contributor", now)).ok).toBe(true);
    const replay = await requireInternalService(request, "contributor", now);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.response.status).toBe(409);
  });
});
