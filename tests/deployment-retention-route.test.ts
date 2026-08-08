import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { POST as retentionPurgeRoute } from "@/app/v1/internal/deployments/retention-purge/route";

const now = new Date();
const sweepSecret = "deployment-pipeline-scheduler-secret-at-least-32-chars";

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(
    `insert into platform_service_principals(id,service_key,key_ref,status,valid_from,valid_until,version)
     values('sweep-principal-id','deployment-pipeline-scheduler','sweep-ref','active','2020-01-01T00:00:00Z','2035-01-01T00:00:00Z',1)`,
  ).run();
  process.env.PLATFORM_SERVICE_SECRETS = JSON.stringify({ "sweep-ref": sweepSecret });
});

describe("AR-002 session 2: retention-purge route", () => {
  it("runs the purge and reports zero counts when nothing is due", async () => {
    const assertion = await createPlatformServiceAssertion({
      serviceKey: "deployment-pipeline-scheduler", audience: "babysteps:internal:deployment:sweep", jti: "purge-1", now, secret: sweepSecret,
    });
    const response = await retentionPurgeRoute(new Request("http://localhost/v1/internal/deployments/retention-purge", {
      method: "POST", headers: { "x-babysteps-service-assertion": assertion },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deploymentsPurged: 0, windowsPurged: 0, webhookReceiptsPurged: 0, operationRequestsPurged: 0,
    });
  });

  it("rejects without a valid service assertion", async () => {
    const response = await retentionPurgeRoute(new Request("http://localhost/v1/internal/deployments/retention-purge", { method: "POST" }));
    expect(response.status).toBe(401);
  });
});
