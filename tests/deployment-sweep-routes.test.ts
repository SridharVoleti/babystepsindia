import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { POST as safetySweepRoute } from "@/app/v1/internal/deployments/safety-sweep/route";
import { POST as windowSweepRoute } from "@/app/v1/internal/deployments/window-sweep/route";

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

async function sweepRequest(path: string, jti: string) {
  const assertion = await createPlatformServiceAssertion({
    serviceKey: "deployment-pipeline-scheduler", audience: "babysteps:internal:deployment:sweep", jti, now, secret: sweepSecret,
  });
  return new Request(`http://localhost${path}`, { method: "POST", headers: { "x-babysteps-service-assertion": assertion } });
}

describe("AR-002 session 2 sweep routes", () => {
  it("runs the safety sweep as a no-op when nothing is observing", async () => {
    const response = await safetySweepRoute(await sweepRequest("/v1/internal/deployments/safety-sweep", "safety-1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects the safety sweep without a valid service assertion", async () => {
    const request = new Request("http://localhost/v1/internal/deployments/safety-sweep", { method: "POST" });
    expect((await safetySweepRoute(request)).status).toBe(401);
  });

  it("runs the window sweep as a no-op when nothing is due", async () => {
    const response = await windowSweepRoute(await sweepRequest("/v1/internal/deployments/window-sweep", "window-1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects the window sweep without a valid service assertion", async () => {
    const request = new Request("http://localhost/v1/internal/deployments/window-sweep", { method: "POST" });
    expect((await windowSweepRoute(request)).status).toBe(401);
  });
});
