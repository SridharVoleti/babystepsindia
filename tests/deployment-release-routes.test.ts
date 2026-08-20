import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { POST as createReleaseRoute } from "@/app/v1/internal/apps/[appId]/releases/route";
import { GET as publishedDeploymentRoute } from "@/app/v1/internal/apps/[appId]/published-deployment/route";

// AT-AR-002-09: only an authenticated CI/deployment service principal can
// reach the release-creation route — this exercises requireInternalService
// end-to-end (the service-layer tests never go through the HTTP guard).
const now = new Date();
const ciKeys = generateKeyPairSync("ed25519");
const ciPrivateKeyPem = ciKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let ADMIN: string;
let appId: string;

beforeEach(async () => {
  useInMemoryDb();
  ADMIN = (await sqliteAuthAdapter.signUp("route-ci-admin@example.com", "CorrectHorse1!")).user.id;
  const app = await createApp(ADMIN, {
    appKey: "chess-master", displayName: "Chess Master", shortDescription: "desc", iconAssetKey: "icon-chess-piece",
    category: "learning", owningTeam: "platform", internalNotes: null, idempotencyKey: crypto.randomUUID(),
  });
  await activateApp(ADMIN, app.id, { expectedVersion: app.version, idempotencyKey: crypto.randomUUID() });
  appId = app.id;
  getDb().prepare(
    `insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
     values('ci-principal-id','ci-deployment-service','ci-ref',?,'active','2020-01-01T00:00:00Z','2035-01-01T00:00:00Z',1)`,
  ).run(ciKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
});

async function releaseRequest(body: unknown, jti = "release-1") {
  const assertion = createPlatformServiceAssertion({
    serviceKey: "ci-deployment-service", audience: "babysteps:internal:deployment:release_create", jti, now,
    privateKeyPem: ciPrivateKeyPem,
  });
  return new Request(`http://localhost/v1/internal/apps/${appId}/releases`, {
    method: "POST",
    headers: { "x-babysteps-service-assertion": assertion, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validReleaseBody() {
  return {
    sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-route-1",
    dependencyLockHash: "lock-1", buildInputHash: "build-1", artifactDigest: "sha256:route-1",
    manifest: {
      manifestVersion: 1, appKey: "chess-master", launchPath: "/launch", returnPath: "/return",
      identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0",
    },
    gateResults: { dependencyInstall: true, typeCheck: true, lint: true, unitTests: true, contractTests: true, security: true, build: true },
    idempotencyKey: crypto.randomUUID(),
  };
}

describe("AR-002 internal deployment routes", () => {
  it("creates a release when the CI service assertion is valid", async () => {
    const response = await createReleaseRoute(await releaseRequest(validReleaseBody()), { params: { appId } });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.status).toBe("created");
    expect(body.sourceCommitSha).toBe("commit-route-1");
  });

  it("rejects release creation without a valid service assertion", async () => {
    const request = new Request(`http://localhost/v1/internal/apps/${appId}/releases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validReleaseBody()),
    });
    const response = await createReleaseRoute(request, { params: { appId } });
    expect(response.status).toBe(401);
  });

  it("rejects a replayed service assertion (same jti twice)", async () => {
    const request = await releaseRequest({ ...validReleaseBody(), sourceCommitSha: "commit-route-2", artifactDigest: "sha256:route-2" }, "replay-jti");
    const assertion = request.headers.get("x-babysteps-service-assertion")!;
    const first = await createReleaseRoute(
      new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...validReleaseBody(), sourceCommitSha: "commit-route-2", artifactDigest: "sha256:route-2" }) }),
      { params: { appId } },
    );
    expect(first.status).toBe(201);
    const replay = await createReleaseRoute(
      new Request(request.url, { method: "POST", headers: { "x-babysteps-service-assertion": assertion, "content-type": "application/json" }, body: JSON.stringify({ ...validReleaseBody(), sourceCommitSha: "commit-route-3", artifactDigest: "sha256:route-3" }) }),
      { params: { appId } },
    );
    expect(replay.status).toBe(409);
  });

  it("returns 404 for published-deployment before anything is published", async () => {
    const assertion = createPlatformServiceAssertion({
      serviceKey: "ci-deployment-service", audience: "babysteps:internal:deployment:release_create", jti: "read-1", now,
      privateKeyPem: ciPrivateKeyPem,
    });
    const request = new Request(`http://localhost/v1/internal/apps/${appId}/published-deployment?environment=production`, {
      headers: { "x-babysteps-service-assertion": assertion },
    });
    const response = await publishedDeploymentRoute(request, { params: { appId } });
    expect(response.status).toBe(404);
  });
});
