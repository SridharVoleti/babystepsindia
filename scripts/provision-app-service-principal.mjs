#!/usr/bin/env node
// Provision an app-service principal (AU-004) so a partner app's backend can
// call POST /v1/internal/app-launch/exchange as itself, and prints a fresh
// APP_LAUNCH_BOOTSTRAP_SECRET for it to verify the bootstrap assertion that
// comes back.
//
// No admin UI or code path inserts app_service_principals rows (deliberate
// gap, see APP_ONBOARDING_AND_LAUNCH_GUIDE.md step 8) -- this is that step.
//
// ── Usage ──────────────────────────────────────────────────────────────────
//   node scripts/provision-app-service-principal.mjs
//     Defaults to ChessMasters' current production deployment. Prints:
//       1. The Ed25519 private key + client_id for the app's own Vercel env
//       2. A fresh APP_LAUNCH_BOOTSTRAP_SECRET (only generate once per
//          platform -- see the note it prints)
//       3. The exact SQL to register the public half, run once against
//          the production database
//
//   Flags: --app-id, --environment, --deployment-id, --client-id
//   (all default to ChessMasters/production/its current published deployment)

import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

const DEFAULTS = {
  appId: "2caee1f3-63f1-4285-9869-dd250a1e9d95", // ChessMasters
  environment: "production",
  deploymentId: "30ce3cbb-8ce0-4356-954b-060f7bb1d17c", // current published production deployment
  clientId: "chess-masters-app-service",
};

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) out[arg.slice(2)] = args[++i];
  }
  return out;
}

function main(args) {
  const appId = args["app-id"] ?? DEFAULTS.appId;
  const environment = args.environment ?? DEFAULTS.environment;
  const deploymentId = args["deployment-id"] ?? DEFAULTS.deploymentId;
  const clientId = args["client-id"] ?? DEFAULTS.clientId;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const keyRef = `manual://babysteps/${clientId}/${new Date().toISOString().slice(0, 10)}`;
  const bootstrapSecret = randomBytes(32).toString("base64url"); // 43 chars, well over the 32-char minimum

  console.log("═══ 1. Give the app team (their Vercel project, server-side env vars) ═══\n");
  console.log(`APP_SERVICE_CLIENT_ID=${clientId}`);
  console.log(`APP_SERVICE_APP_ID=${appId}`);
  console.log(`APP_SERVICE_ENVIRONMENT=${environment}`);
  console.log(`APP_SERVICE_DEPLOYMENT_ID=${deploymentId}`);
  console.log("APP_SERVICE_PRIVATE_KEY (their Ed25519 private key -- signs the exchange call):");
  console.log(privatePem);
  console.log(`\nAPP_LAUNCH_BOOTSTRAP_SECRET=${bootstrapSecret}`);
  console.log("  (verifies the bootstrap assertion BabySteps hands back -- HS256, shared secret)");

  console.log("\n═══ 2. Set on BABYSTEPS' OWN Vercel (babystepsindia project, Production) ═══\n");
  console.log(`APP_LAUNCH_BOOTSTRAP_SECRET=${bootstrapSecret}`);
  console.log(
    "  Same value as above -- this codebase signs bootstrap assertions with ONE global\n" +
    "  secret for every app (process.env.APP_LAUNCH_BOOTSTRAP_SECRET, no per-app column),\n" +
    "  so only set this ONCE across the platform's lifetime. If it's already set from an\n" +
    "  earlier provisioning attempt, DO NOT overwrite it -- every other app's launches\n" +
    "  would break. Check first; only apply this value if the var is genuinely unset.",
  );

  console.log("\n═══ 3. Register the public half -- run ONCE against the PRODUCTION database ═══\n");
  console.log(
    "insert into app_service_principals\n" +
    "  (id, app_id, environment, deployment_id, client_id, key_ref, public_key, status, valid_from, valid_until, version)\n" +
    "values (\n" +
    `  '${randomUUID()}',\n` +
    `  '${appId}',\n` +
    `  '${environment}',\n` +
    `  '${deploymentId}',\n` +
    `  '${clientId}',\n` +
    `  '${keyRef}',\n` +
    `  '${publicPem}',\n` +
    "  'active',\n" +
    "  now(),\n" +
    "  now() + interval '3650 days',\n" +
    "  1\n" +
    ")\n" +
    "on conflict (client_id) do update set\n" +
    "  environment   = excluded.environment,\n" +
    "  deployment_id = excluded.deployment_id,\n" +
    "  key_ref       = excluded.key_ref,\n" +
    "  public_key    = excluded.public_key,\n" +
    "  status        = 'active',\n" +
    "  valid_from    = excluded.valid_from,\n" +
    "  valid_until   = excluded.valid_until,\n" +
    "  version       = app_service_principals.version + 1;",
  );

  console.log(
    "\nNotes:\n" +
    "  • deployment_id is bound to the CURRENT production deployment -- if production is\n" +
    "    ever re-promoted to a new deployment, this row (and the app's own\n" +
    "    APP_SERVICE_DEPLOYMENT_ID) needs updating, or the exchange call will fail\n" +
    "    binding-mismatch checks.\n" +
    "  • The private key and bootstrap secret are shown once here -- store them securely,\n" +
    "    they are never re-derivable from the database (only the public key is stored).\n" +
    "  • Run the SQL against SUPABASE_DB_URL (Supabase SQL editor, or psql).",
  );
}

const isMain = argv[1] && import.meta.url === pathToFileURL(argv[1]).href;
if (isMain) main(parseArgs(argv.slice(2)));
