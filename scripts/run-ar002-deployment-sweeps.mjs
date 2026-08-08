import { createHmac, randomUUID } from "node:crypto";

const SERVICE_KEY = "deployment-pipeline-scheduler";
const AUDIENCE = "babysteps:internal:deployment:sweep";

function serviceAssertion(secret, now) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ iss: SERVICE_KEY, sub: SERVICE_KEY, aud: AUDIENCE, jti: randomUUID(), iat: issuedAt, exp: issuedAt + 60 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

async function invokeSweep({ baseUrl, secret, path, now = new Date(), fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("DEPLOYMENT_SWEEP_BASE_URL is required");
  if (!secret || secret.length < 32) throw new Error("DEPLOYMENT_SWEEP_SERVICE_SECRET must be at least 32 characters");
  const endpoint = `${baseUrl.replace(/\/$/, "")}${path}`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "x-babysteps-service-assertion": serviceAssertion(secret, now) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned status ${response.status}: ${body}`);
  return body;
}

// AR-002 session 2: drives both the ten-minute post-publish release-safety
// observation (business rules 32-33) and the deployment-window
// zero-reserved-session/overrun sweep (rules 55, 58). Both are cheap no-ops
// when nothing is due, so invoking this on a short recurring cadence (see
// .github/workflows/ar002-deployment-sweeps.yml) is safe.
export async function invokeDeploymentSweeps({ baseUrl, secret, now = new Date(), fetchImpl = fetch }) {
  const safetySweep = await invokeSweep({ baseUrl, secret, path: "/v1/internal/deployments/safety-sweep", now, fetchImpl });
  const windowSweep = await invokeSweep({ baseUrl, secret, path: "/v1/internal/deployments/window-sweep", now, fetchImpl });
  return { safetySweep, windowSweep };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  invokeDeploymentSweeps({
    baseUrl: process.env.DEPLOYMENT_SWEEP_BASE_URL,
    secret: process.env.DEPLOYMENT_SWEEP_SERVICE_SECRET,
  })
    .then((result) => console.log(`AR-002 deployment sweeps completed: ${JSON.stringify(result)}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
