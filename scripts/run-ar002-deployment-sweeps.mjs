// AR-002 session 2: drives the post-publish release-safety observation
// (business rules 32-33), the deployment-window zero-reserved-session /
// overrun sweep (rules 55, 58) — which is what actually executes a
// scheduled production promotion — and the retention purge (rules 40-41).
// All three are cheap no-ops when nothing is due, so invoking this on a
// short recurring cadence (see .github/workflows/ar002-deployment-sweeps.yml)
// is safe.
//
// Auth: the `deployment-pipeline-scheduler` platform-service principal, an
// Ed25519 "service assertion" verified against the public key stored on
// the `platform_service_principals` row whose service_key is
// 'deployment-pipeline-scheduler' (the HS256 shared-secret scheme was
// retired in commit 6bdd26d). Same mechanism as
// scripts/create-ci-deployer-release.mjs.
//
// ── One-time setup ────────────────────────────────────────────────────────────
//   node scripts/run-ar002-deployment-sweeps.mjs --generate-keypair
//     Prints an Ed25519 private key and the SQL to register its public
//     half. Run the SQL once against production. Store the private key as
//     the DEPLOYMENT_SWEEP_PRIVATE_KEY secret (GitHub Actions env, or pass
//     --key-file locally).
//
// ── Running the sweeps ────────────────────────────────────────────────────────
//   DEPLOYMENT_SWEEP_BASE_URL=https://www.babystepsindia.com \
//   DEPLOYMENT_SWEEP_PRIVATE_KEY="$(cat sweep.pem)" \
//   node scripts/run-ar002-deployment-sweeps.mjs
//
//   Add --window-sweep-only to run just the deployment-window sweep (the
//   one that executes a due production-promotion window).

import { argv, env, exit } from "node:process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

export const SERVICE_KEY = "deployment-pipeline-scheduler";
export const AUDIENCE = "babysteps:internal:deployment:sweep";

function normalizePem(value) {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function loadPrivateKey(keyFile) {
  const raw = keyFile ? readFileSync(keyFile, "utf8") : env.DEPLOYMENT_SWEEP_PRIVATE_KEY;
  if (!raw || !raw.trim()) {
    console.error(
      "No signing key. Pass --key-file <path> or set DEPLOYMENT_SWEEP_PRIVATE_KEY.\n" +
      "Run with --generate-keypair to create one and register its public half.",
    );
    exit(2);
  }
  return createPrivateKey(normalizePem(raw.trim()));
}

export function serviceAssertion(privateKey, now) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: "JWT" });
  const payload = encode({
    iss: SERVICE_KEY, sub: SERVICE_KEY, aud: AUDIENCE,
    jti: randomUUID(), iat: issuedAt, exp: issuedAt + 60,
  });
  const unsigned = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const keyRef = `manual://babysteps/deployment-sweep/${new Date().toISOString().slice(0, 10)}`;
  console.log("── DEPLOYMENT_SWEEP private key — store as a secret, never commit ──\n");
  console.log(privatePem);
  console.log("\n── Register its public half — run once against the PRODUCTION database ──\n");
  console.log(
    "insert into platform_service_principals\n" +
    "  (id, service_key, key_ref, public_key, status, valid_from, valid_until, version)\n" +
    "values (\n" +
    "  gen_random_uuid(),\n" +
    `  '${SERVICE_KEY}',\n` +
    `  '${keyRef}',\n` +
    `  '${publicPem}',\n` +
    "  'active',\n" +
    "  now(),\n" +
    "  now() + interval '3650 days',\n" +
    "  1\n" +
    ")\n" +
    "on conflict (service_key) do update set\n" +
    "  public_key  = excluded.public_key,\n" +
    "  key_ref     = excluded.key_ref,\n" +
    "  status      = 'active',\n" +
    "  valid_from  = excluded.valid_from,\n" +
    "  valid_until = excluded.valid_until,\n" +
    "  version     = platform_service_principals.version + 1;",
  );
  console.log("\n  • No migration seeds this principal — provisioning it here is expected.\n  • Run against SUPABASE_DB_URL (Supabase SQL editor, or psql).");
}

async function invokeSweep({ baseUrl, privateKey, path, now = new Date(), fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("DEPLOYMENT_SWEEP_BASE_URL is required");
  const endpoint = `${baseUrl.replace(/\/$/, "")}${path}`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "x-babysteps-service-assertion": serviceAssertion(privateKey, now) },
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned status ${response.status}: ${body}`);
  return body;
}

export async function invokeDeploymentSweeps({ baseUrl, privateKey, now = new Date(), fetchImpl = fetch, windowOnly = false }) {
  const windowSweep = await invokeSweep({ baseUrl, privateKey, path: "/v1/internal/deployments/window-sweep", now, fetchImpl });
  if (windowOnly) return { windowSweep };
  const safetySweep = await invokeSweep({ baseUrl, privateKey, path: "/v1/internal/deployments/safety-sweep", now, fetchImpl });
  const retentionPurge = await invokeSweep({ baseUrl, privateKey, path: "/v1/internal/deployments/retention-purge", now, fetchImpl });
  return { windowSweep, safetySweep, retentionPurge };
}

const isMain = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isMain) {
  const args = argv.slice(2);
  if (args.includes("--generate-keypair")) {
    generateKeypair();
  } else {
    const keyFileIdx = args.indexOf("--key-file");
    const keyFile = keyFileIdx >= 0 ? args[keyFileIdx + 1] : undefined;
    invokeDeploymentSweeps({
      baseUrl: env.DEPLOYMENT_SWEEP_BASE_URL,
      privateKey: loadPrivateKey(keyFile),
      windowOnly: args.includes("--window-sweep-only"),
    })
      .then((result) => console.log(`AR-002 deployment sweeps completed: ${JSON.stringify(result)}`))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
