import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { activateAuthorizationPolicyBundle, createAuthorizationPolicyBundle } from "@/lib/authorization/policy-bundles";
import { createPlatformServiceAssertion, decideInternalAuthorization, InternalAuthorizationDecisionError } from "@/lib/authorization/internal-decision";

const now = new Date("2026-08-05T10:00:00.000Z");
const secret = "platform-service-secret-that-is-long-enough";

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into platform_service_principals(id,service_key,key_ref,status,valid_from,valid_until,version)
    values('service-1','scheduler','secret-ref','active','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',1)`).run();
  createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules: [
    { actionKey: "service.authorization.decide", effect: "allow", principalType: "managed_service", resourceType: "authorization" },
    { actionKey: "service.analytics.run", effect: "allow", principalType: "managed_service", resourceType: "analytics" },
  ] });
  const actor = (getDb().prepare("select id from users where is_admin=1").get() as { id: string }).id;
  activateAuthorizationPolicyBundle({ version: "2026.08.1", activatedBy: actor, now });
});

describe("AU-001 internal authorization-decision API service", () => {
  it("authenticates a managed platform service and returns an active-policy decision", async () => {
    const assertion = await createPlatformServiceAssertion({ serviceKey: "scheduler", audience: "babysteps:internal:authorization-decision",
      jti: "jti-1", now, secret });
    const result = await decideInternalAuthorization({ assertion, action: "service.analytics.run", resource: {}, now,
      resolveSecret: (keyRef) => keyRef === "secret-ref" ? secret : undefined });
    expect(result).toMatchObject({ allowed: true, action: "service.analytics.run", principalType: "managed_service",
      policyVersion: "2026.08.1" });
  });

  it("rejects missing/browser credentials and learning-app principals", async () => {
    await expect(decideInternalAuthorization({ assertion: "", action: "service.analytics.run", resource: {}, now,
      resolveSecret: () => secret })).rejects.toEqual(new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED"));
    const appLike = await createPlatformServiceAssertion({ serviceKey: "app-client", audience: "babysteps:internal:authorization-decision",
      jti: "jti-app", now, secret });
    await expect(decideInternalAuthorization({ assertion: appLike, action: "service.analytics.run", resource: {}, now,
      resolveSecret: () => secret })).rejects.toEqual(new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED"));
  });

  it("rejects assertion replay before producing a second decision", async () => {
    const assertion = await createPlatformServiceAssertion({ serviceKey: "scheduler", audience: "babysteps:internal:authorization-decision",
      jti: "jti-replay", now, secret });
    const input = { assertion, action: "service.analytics.run" as const, resource: {}, now, resolveSecret: () => secret };
    await decideInternalAuthorization(input);
    await expect(decideInternalAuthorization(input)).rejects.toEqual(new InternalAuthorizationDecisionError("SERVICE_ASSERTION_REPLAYED"));
  });

  it("fails closed for actions absent or denied by the active policy", async () => {
    const assertion = await createPlatformServiceAssertion({ serviceKey: "scheduler", audience: "babysteps:internal:authorization-decision",
      jti: "jti-denied", now, secret });
    await expect(decideInternalAuthorization({ assertion, action: "service.analytics.contribute", resource: {}, now,
      resolveSecret: () => secret })).rejects.toEqual(new InternalAuthorizationDecisionError("AUTHORIZATION_DENIED"));
  });
});
