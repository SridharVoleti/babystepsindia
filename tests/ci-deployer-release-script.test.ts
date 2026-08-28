import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { POST as createReleaseRoute } from "@/app/v1/internal/apps/[appId]/releases/route";
// The script is plain .mjs with no repo imports — safe to import here.
import {
  AUDIENCE, SERVICE_KEY, buildReleaseBody, serviceAssertion,
} from "../scripts/create-ci-deployer-release.mjs";

// Proves scripts/create-ci-deployer-release.mjs produces an assertion + body
// that the real release-creation route accepts — the same end-to-end path the
// script hits against production, minus the network.

const COMMIT = "ed47baeb619bcd3e21e7b3c2049a342c5b4b75c1";
const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey; // KeyObject works with node:crypto sign()
let appId: string;

beforeEach(async () => {
  useInMemoryDb();
  const admin = (await sqliteAuthAdapter.signUp("ci-script-admin@example.com", "CorrectHorse1!")).user.id;
  const app = await createApp(admin, {
    appKey: "chess-masters", displayName: "ChessMasters", shortDescription: "chess",
    iconAssetKey: "icon-chess-piece", category: "learning", owningTeam: "platform",
    internalNotes: null, idempotencyKey: crypto.randomUUID(),
  });
  await activateApp(admin, app.id, { expectedVersion: app.version, idempotencyKey: crypto.randomUUID() });
  appId = app.id;
  getDb().prepare(
    `insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
     values('ci-principal','${SERVICE_KEY}','ci-ref',?,'active','2020-01-01T00:00:00Z','2035-01-01T00:00:00Z',1)`,
  ).run(keys.publicKey.export({ type: "spki", format: "pem" }).toString());
});

function request(body: unknown) {
  return new Request(`http://localhost/v1/internal/apps/${appId}/releases`, {
    method: "POST",
    headers: {
      "x-babysteps-service-assertion": serviceAssertion(privateKey, new Date()),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("create-ci-deployer-release.mjs", () => {
  it("targets the ci-deployer contract", () => {
    expect(SERVICE_KEY).toBe("ci-deployment-service");
    expect(AUDIENCE).toBe("babysteps:internal:deployment:release_create");
  });

  it("creates a release the route accepts, status created", async () => {
    const body = buildReleaseBody({ commit: COMMIT, artifact: "manual-attestation-ed47bae", appKey: "chess-masters" });
    const response = await createReleaseRoute(request(body), { params: { appId } });
    expect(response.status).toBe(201);
    const release = await response.json();
    expect(release.status).toBe("created");
    expect(release.sourceCommitSha).toBe(COMMIT);
    expect(release.artifactDigest).toBe("manual-attestation-ed47bae");
    expect(release.manifest.launchPath).toBe("/launch");
  });

  it("is idempotent for the same commit + artifact (deterministic idempotencyKey)", async () => {
    const body = buildReleaseBody({ commit: COMMIT, artifact: "manual-attestation-ed47bae", appKey: "chess-masters" });
    const first = await createReleaseRoute(request(body), { params: { appId } });
    const second = await createReleaseRoute(request(body), { params: { appId } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await first.json()).id).toBe((await second.json()).id);
  });

  it("a different artifact label cuts a distinct release for the same commit", async () => {
    const a = await createReleaseRoute(
      request(buildReleaseBody({ commit: COMMIT, artifact: "attest-a", appKey: "chess-masters" })),
      { params: { appId } });
    const b = await createReleaseRoute(
      request(buildReleaseBody({ commit: COMMIT, artifact: "attest-b", appKey: "chess-masters" })),
      { params: { appId } });
    // Same commit+digest dedup is keyed on artifactDigest too, so distinct
    // labels are distinct releases — this is why prior manual runs used
    // "...-retry-N" suffixes.
    expect((await a.json()).artifactDigest).toBe("attest-a");
    expect((await b.json()).artifactDigest).toBe("attest-b");
  });

  it("rejects a manifest whose appKey does not match the registry", async () => {
    const body = buildReleaseBody({ commit: COMMIT, artifact: "wrong-key", appKey: "not-chess-masters" });
    const response = await createReleaseRoute(request(body), { params: { appId } });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
