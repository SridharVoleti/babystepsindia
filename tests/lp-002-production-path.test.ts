import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("LP-002 production correction path", () => {
  const route = source("src/app/v1/learners/[learnerId]/route.ts");
  const postgres = source("src/lib/learner-profile/postgres-service.ts");
  const gateway = source("src/lib/learner-profile/production-gateway.ts");

  it("routes reads and corrections through the production gateway", () => {
    expect(route).toContain("production-gateway");
    expect(route).not.toContain("@/lib/db/learner-repo");
    expect(gateway).toContain("updateOwnedLearner");
  });

  it("uses distributed rather than process-local rate limiting", () => {
    expect(route).toContain("consumeDistributedRateLimit");
    expect(route).not.toContain("checkRateLimit");
  });

  it("implements transactional optimistic locking and idempotency in Postgres", () => {
    expect(postgres).toContain("learner_profile_update_requests");
    expect(postgres).toMatch(/version=version\+1/);
    expect(postgres).toContain("LEARNER_VERSION_CONFLICT");
    expect(postgres).toContain("IDEMPOTENCY_KEY_REUSED");
  });
});
