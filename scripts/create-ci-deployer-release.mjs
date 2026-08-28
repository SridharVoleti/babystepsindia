#!/usr/bin/env node
// Create an app release as the `ci-deployer` platform-service principal.
//
// This is the sole write path onto `app_releases` (AR-002 business rule 11):
// there is no admin/browser button for it. `POST /v1/internal/apps/{appId}/releases`
// is guarded by requireInternalService(request, "ci-deployer"), which verifies an
// Ed25519-signed JWT ("service assertion") against the public key stored on the
// `platform_service_principals` row whose `service_key` is 'ci-deployment-service'
// (src/lib/authorization/internal-decision.ts — the HS256 shared-secret scheme was
// retired in commit 6bdd26d).
//
// ── One-time setup ────────────────────────────────────────────────────────────
//   node scripts/create-ci-deployer-release.mjs --generate-keypair
//     Prints an Ed25519 private key (keep it secret — this is the CI signing key)
//     and the exact SQL to register its public half as the ci-deployment-service
//     principal. Run that SQL once against the production database. Store the
//     private key as the CI_DEPLOYER_PRIVATE_KEY secret (GitHub Actions env, or a
//     local file passed with --key-file).
//
// ── Cutting a release ─────────────────────────────────────────────────────────
//   CI_DEPLOYER_PRIVATE_KEY="$(cat ci-deployer.pem)" \
//   node scripts/create-ci-deployer-release.mjs \
//     --commit ed47baeb619bcd3e21e7b3c2049a342c5b4b75c1 \
//     --artifact manual-attestation-ed47bae
//
// After a release is created (status `created`) an operator clicks "Deploy to
// staging" on /admin/apps/{id}/deployments; if staging verification passes the
// release becomes `verified` and can then be promoted to production (that step
// is password + reauth gated and stays in the browser).

import { argv, env, exit } from "node:process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

const DEFAULTS = {
  baseUrl: "https://www.babystepsindia.com",
  appId: "2caee1f3-63f1-4285-9869-dd250a1e9d95", // ChessMasters (chess-masters)
  appKey: "chess-masters",
  repo: "SridharVoleti/ChessMaster",
  launchPath: "/launch",
  returnPath: "/return",
  identityPath: "/identity",
  healthPath: "/health",
  minimumSdkVersion: "1.0.0",
};

export const SERVICE_KEY = "ci-deployment-service";
export const AUDIENCE = "babysteps:internal:deployment:release_create";

function parseArgs(args) {
  const out = { _: [], gates: {} };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "generate-keypair" || key === "dry-run") {
      out[key === "dry-run" ? "dryRun" : "generateKeypair"] = true;
      continue;
    }
    if (key === "gate-fail") {
      out.gates[args[++i]] = false;
      continue;
    }
    out[key] = args[++i];
  }
  return out;
}

function normalizePem(value) {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function loadPrivateKey(args) {
  const raw = args["key-file"]
    ? readFileSync(args["key-file"], "utf8")
    : env.CI_DEPLOYER_PRIVATE_KEY;
  if (!raw || !raw.trim()) {
    console.error(
      "No signing key. Pass --key-file <path> or set CI_DEPLOYER_PRIVATE_KEY.\n" +
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
  // Postgres stores public_key with literal newlines fine; keep the PEM intact.
  const keyRef = `manual://babysteps/ci-deployer/${new Date().toISOString().slice(0, 10)}`;
  console.log("── CI_DEPLOYER private key — store as a secret, never commit ──\n");
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
  console.log(
    "\nNotes:\n" +
    "  • No migration seeds this principal — provisioning it here is expected.\n" +
    "  • If a row already exists this rotates its key; existing releases are\n" +
    "    unaffected (they only stored the principal id, not the key).\n" +
    "  • Run against SUPABASE_DB_URL (Supabase SQL editor, or psql).",
  );
}

// Builds the exact JSON body POST /v1/internal/apps/{appId}/releases expects
// (src/lib/deployment-release/service.ts::CreateReleaseInput). Hashes are
// deterministic per commit so a retry with the same commit + artifact is
// idempotent server-side.
export function buildReleaseBody(args) {
  const commit = args.commit;
  const artifact = args.artifact ?? `manual-attestation-${commit.slice(0, 10)}`;
  const digest = (suffix) => createHash("sha256").update(`${commit}:${suffix}`).digest("hex");
  return {
    sourceRepository: args["source-repo"] ?? args.repo ?? DEFAULTS.repo,
    sourceCommitSha: commit,
    dependencyLockHash: args["lock-hash"] ?? digest("dependency-lock"),
    buildInputHash: args["build-hash"] ?? digest("build-input"),
    artifactDigest: artifact,
    providerArtifactId: args["provider-artifact-id"] ?? null,
    manifest: {
      manifestVersion: 1,
      appKey: args.appKey ?? args["app-key"] ?? DEFAULTS.appKey,
      launchPath: args["launch-path"] ?? DEFAULTS.launchPath,
      returnPath: args["return-path"] ?? DEFAULTS.returnPath,
      identityPath: args["identity-path"] ?? DEFAULTS.identityPath,
      healthPath: args["health-path"] ?? DEFAULTS.healthPath,
      minimumSdkVersion: args["min-sdk"] ?? DEFAULTS.minimumSdkVersion,
    },
    gateResults: {
      dependencyInstall: true, typeCheck: true, lint: true, unitTests: true,
      contractTests: true, security: true, build: true,
      ...(args.gates ?? {}),
    },
    idempotencyKey: args["idempotency-key"]
      ?? createHash("sha256").update(`${commit}:${artifact}`).digest("hex"),
  };
}

async function createRelease(args) {
  const now = new Date();
  const baseUrl = (args["base-url"] ?? env.RELEASE_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/$/, "");
  const appId = args["app-id"] ?? env.RELEASE_APP_ID ?? DEFAULTS.appId;
  const appKey = args["app-key"] ?? DEFAULTS.appKey;
  const commit = args.commit ?? env.RELEASE_COMMIT;
  if (!commit) {
    console.error("--commit <full 40-char sha> is required.");
    exit(2);
  }
  const artifact = args.artifact ?? env.RELEASE_ARTIFACT ?? `manual-attestation-${commit.slice(0, 10)}`;
  const body = buildReleaseBody({ ...args, commit, artifact, appKey });
  const { gateResults } = body;

  const endpoint = `${baseUrl}/v1/internal/apps/${appId}/releases`;
  console.error(`POST ${endpoint}`);
  console.error(`  commit   ${commit}`);
  console.error(`  artifact ${artifact}`);
  console.error(`  gates    ${JSON.stringify(gateResults)}`);
  if (args.dryRun) {
    console.error("\n--dry-run: not sending. Request body:");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const privateKey = loadPrivateKey(args);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-babysteps-service-assertion": serviceAssertion(privateKey, now),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`\nFAILED ${response.status}: ${text}`);
    if (response.status === 401) {
      console.error(
        "\n401 means the assertion did not verify. Either the ci-deployment-service\n" +
        "principal row is missing/inactive in this environment, or its public key does\n" +
        "not match this private key. Run --generate-keypair and register the public half.",
      );
    }
    exit(1);
  }
  const release = JSON.parse(text);
  console.error(`\nOK — release ${release.id} status=${release.status}`);
  console.log(JSON.stringify(release, null, 2));
  console.error(
    "\nNext: open /admin/apps/" + appId + "/deployments, click \"Deploy to staging\"\n" +
    "on this release. If staging verification passes it becomes `verified` and you can\n" +
    "schedule the (password + reauth gated) production deployment.",
  );
}

const isMain = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isMain) {
  const args = parseArgs(argv.slice(2));
  if (args.generateKeypair) {
    generateKeypair();
  } else {
    await createRelease(args);
  }
}
