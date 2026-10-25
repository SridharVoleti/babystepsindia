import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { POST as webhookRoute } from "@/app/v1/internal/deployment-provider/webhook/route";

// PRG-024 (issue #67): signed deployment webhook processing - validation, event mapping, idempotent and replay-safe state transitions.
const secret = "deployment-webhook-shared-secret-at-least-32-chars";
let appId: string;
let releaseId: string;
let bindingId: string;

function seedDeployment(status: string, providerDeploymentId: string, environment = "staging") {
  const id = randomUUID();
  getDb().prepare(
    `insert into app_deployments (id, app_id, release_id, binding_id, environment, provider_deployment_id, verified_origin, status)
     values (?, ?, ?, ?, ?, ?, 'https://example.dev', ?)`,
  ).run(id, appId, releaseId, bindingId, environment, providerDeploymentId, status);
  return id;
}
const statusOf = (id: string) => (getDb().prepare("select status from app_deployments where id = ?").get(id) as { status: string }).status;

function signed(body: unknown, opts: { raw?: string; timestampSeconds?: number; badSignature?: boolean } = {}) {
  const rawBody = opts.raw ?? JSON.stringify(body);
  const ts = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signature = opts.badSignature ? "0".repeat(64) : createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return new Request("http://localhost/v1/internal/deployment-provider/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-babysteps-webhook-signature": signature, "x-babysteps-webhook-timestamp": String(ts) },
    body: rawBody,
  });
}
const event = (eventId: string, type: string, deploymentId: string, extra: Record<string, unknown> = {}) =>
  ({ provider: "vercel", eventId, type, deployment: { id: deploymentId }, ...extra });

beforeEach(async () => {
  useInMemoryDb();
  process.env.DEPLOYMENT_WEBHOOK_SECRET = secret;
  const admin = (await sqliteAuthAdapter.signUp("webhook-admin@example.com", "CorrectHorse1!")).user.id;
  const app = await createApp(admin, {
    appKey: "chess-master", displayName: "Chess Master", shortDescription: "desc", iconAssetKey: "icon-chess-piece",
    category: "learning", owningTeam: "platform", internalNotes: null, idempotencyKey: randomUUID(),
  });
  await activateApp(admin, app.id, { expectedVersion: app.version, idempotencyKey: randomUUID() });
  appId = app.id;
  bindingId = randomUUID();
  getDb().prepare(
    `insert into app_deployment_bindings (id, app_id, environment, provider, provider_team_id, provider_project_id, expected_repository, binding_status)
     values (?, ?, 'staging', 'vercel', 'team', 'proj', 'babysteps/chess-master', 'verified')`,
  ).run(bindingId, appId);
  releaseId = randomUUID();
  getDb().prepare(
    `insert into app_releases (id, app_id, source_repository, source_commit_sha, dependency_lock_hash, build_input_hash, artifact_digest,
      manifest_json, gate_results_json, status, created_by_ci_principal)
     values (?, ?, 'babysteps/chess-master', 'commit-fixture', 'lock', 'build', 'sha256:fixture', '{}', '{}', 'verified', 'ci-1')`,
  ).run(releaseId, appId);
});

describe("valid signed events update deployment state", () => {
  it("maps deployment.ready to validating for a deploying deployment and records the transition against the provider event", async () => {
    const dep = seedDeployment("deploying", "dpl_1");
    const res = await webhookRoute(signed(event("evt-ready", "deployment.ready", "dpl_1")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ providerEventId: "evt-ready", status: "processed", outcome: "applied", transitions: [{ deploymentId: dep, from: "deploying", to: "validating" }] });
    expect(statusOf(dep)).toBe("validating");
    const hist = getDb().prepare("select * from app_deployment_events where deployment_id = ?").all(dep) as Record<string, unknown>[];
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ provider: "vercel", provider_event_id: "evt-ready", event_type: "deployment.ready", from_status: "deploying", to_status: "validating", applied: 1 });
  });

  it.each([["deployment.error"], ["deployment.canceled"]])("maps %s to failed from deploying or validating", async (type) => {
    const a = seedDeployment("deploying", "dpl_a");
    const b = seedDeployment("validating", "dpl_b");
    await webhookRoute(signed(event("e1", type, "dpl_a")));
    await webhookRoute(signed(event("e2", type, "dpl_b")));
    expect(statusOf(a)).toBe("failed");
    expect(statusOf(b)).toBe("failed");
    expect((getDb().prepare("select ended_at from app_deployments where id = ?").get(a) as { ended_at: string | null }).ended_at).toBeTruthy();
  });

  it("deployment.created / building keep a deploying deployment deploying (recorded as a no-op)", async () => {
    const dep = seedDeployment("deploying", "dpl_c");
    const res = await webhookRoute(signed(event("e-b", "deployment.building", "dpl_c")));
    expect(await res.json()).toMatchObject({ outcome: "no_change", transitions: [] });
    expect(statusOf(dep)).toBe("deploying");
  });
});

describe("safe state transitions", () => {
  it.each([["published"], ["superseded"], ["rolled_back"]])("never changes a %s deployment (publication is owned by the release pipeline)", async (status) => {
    const dep = seedDeployment(status, "dpl_t");
    const res = await webhookRoute(signed(event(`e-${status}`, "deployment.error", "dpl_t")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "ignored_unsafe_transition", transitions: [] });
    expect(statusOf(dep)).toBe(status);
    const row = getDb().prepare("select applied, from_status, to_status from app_deployment_events where deployment_id = ?").get(dep) as Record<string, unknown>;
    expect(row).toMatchObject({ applied: 0, from_status: status });
  });

  it("an event that matches the current state is a recorded no-op", async () => {
    const dep = seedDeployment("failed", "dpl_same");
    const res = await webhookRoute(signed(event("e-same", "deployment.error", "dpl_same")));
    expect(await res.json()).toMatchObject({ outcome: "no_change", transitions: [] });
    expect(statusOf(dep)).toBe("failed");
  });

  it("never touches the publication pointer", async () => {
    seedDeployment("deploying", "dpl_p");
    await webhookRoute(signed(event("e-p", "deployment.ready", "dpl_p")));
    expect((getDb().prepare("select count(*) as n from app_environment_publications").get() as { n: number }).n).toBe(0);
  });

  it("an event for an unknown deployment is acknowledged, recorded and changes nothing", async () => {
    const res = await webhookRoute(signed(event("e-u", "deployment.ready", "dpl_missing")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "no_matching_deployment", transitions: [] });
    expect((getDb().prepare("select count(*) as n from deployment_webhook_receipts").get() as { n: number }).n).toBe(1);
  });

  it("an unsupported event type is acknowledged as ignored without mutation", async () => {
    const dep = seedDeployment("deploying", "dpl_x");
    const res = await webhookRoute(signed(event("e-x", "deployment.promoted", "dpl_x")));
    expect(await res.json()).toMatchObject({ outcome: "ignored_unsupported_event" });
    expect(statusOf(dep)).toBe("deploying");
  });

  it("matches the production row's suffixed provider id too, but only transitions rows that are legally transitionable", async () => {
    const staging = seedDeployment("published", "dpl_s");
    const prod = seedDeployment("validating", "dpl_s::production", "production");
    const res = await webhookRoute(signed(event("e-s", "deployment.error", "dpl_s")));
    expect(res.status).toBe(200);
    expect(statusOf(staging)).toBe("published");
    expect(statusOf(prod)).toBe("failed");
  });
});

describe("signature, payload validation, idempotency and replay", () => {
  it("rejects invalid signatures without any state change or receipt", async () => {
    const dep = seedDeployment("deploying", "dpl_i");
    const res = await webhookRoute(signed(event("e-i", "deployment.error", "dpl_i"), { badSignature: true }));
    expect(res.status).toBe(401);
    expect(statusOf(dep)).toBe("deploying");
    expect((getDb().prepare("select count(*) as n from deployment_webhook_receipts").get() as { n: number }).n).toBe(0);
  });

  it("a signature over a different body (tampered payload) is rejected", async () => {
    const dep = seedDeployment("deploying", "dpl_tamper");
    const good = event("e-t", "deployment.ready", "dpl_tamper");
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${ts}.${JSON.stringify(good)}`).digest("hex");
    const tampered = JSON.stringify({ ...good, type: "deployment.error" });
    const req = new Request("http://localhost/x", { method: "POST", headers: { "x-babysteps-webhook-signature": sig, "x-babysteps-webhook-timestamp": String(ts) }, body: tampered });
    expect((await webhookRoute(req)).status).toBe(401);
    expect(statusOf(dep)).toBe("deploying");
  });

  it.each([
    ["not json", { raw: "{nope" }, 400],
    ["missing type", { body: { provider: "vercel", eventId: "v1", deployment: { id: "d" } } }, 400],
    ["missing deployment id", { body: { provider: "vercel", eventId: "v2", type: "deployment.ready", deployment: {} } }, 400],
    ["non-string deployment id", { body: { provider: "vercel", eventId: "v3", type: "deployment.ready", deployment: { id: 7 } } }, 400],
    ["unknown provider", { body: { provider: "evilcorp", eventId: "v4", type: "deployment.ready", deployment: { id: "d" } } }, 400],
    ["oversized event id", { body: { provider: "vercel", eventId: "x".repeat(300), type: "deployment.ready", deployment: { id: "d" } } }, 400],
  ])("rejects an invalid payload: %s", async (_n, c: { raw?: string; body?: unknown }, status) => {
    const res = await webhookRoute(signed(c.body, { raw: c.raw }));
    expect(res.status).toBe(status);
    expect((getDb().prepare("select count(*) as n from deployment_webhook_receipts").get() as { n: number }).n).toBe(0);
  });

  it("duplicate deliveries do not duplicate state transitions or history (replay blocked with 409)", async () => {
    const dep = seedDeployment("deploying", "dpl_d");
    const first = await webhookRoute(signed(event("e-dup", "deployment.error", "dpl_d")));
    const second = await webhookRoute(signed(event("e-dup", "deployment.error", "dpl_d")));
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "WEBHOOK_REPLAYED" });
    expect(statusOf(dep)).toBe("failed");
    expect((getDb().prepare("select count(*) as n from app_deployment_events where deployment_id = ?").get(dep) as { n: number }).n).toBe(1);
  });

  it("concurrent identical deliveries produce exactly one winner", async () => {
    const dep = seedDeployment("deploying", "dpl_race");
    const results = await Promise.all([1, 2, 3, 4].map(() => webhookRoute(signed(event("e-race", "deployment.error", "dpl_race")))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((getDb().prepare("select count(*) as n from app_deployment_events where deployment_id = ?").get(dep) as { n: number }).n).toBe(1);
  });

  it("history is traceable: each applied transition links back to its provider receipt", async () => {
    const dep = seedDeployment("deploying", "dpl_h");
    await webhookRoute(signed(event("e-h1", "deployment.ready", "dpl_h")));
    await webhookRoute(signed(event("e-h2", "deployment.error", "dpl_h")));
    const rows = getDb().prepare(
      `select ev.provider_event_id, ev.from_status, ev.to_status, r.status as receipt_status
       from app_deployment_events ev join deployment_webhook_receipts r on r.id = ev.receipt_id where ev.deployment_id = ? order by ev.received_at, ev.rowid`,
    ).all(dep) as Record<string, unknown>[];
    expect(rows.map((r) => [r.provider_event_id, r.from_status, r.to_status])).toEqual([["e-h1", "deploying", "validating"], ["e-h2", "validating", "failed"]]);
  });

  it("the deployment history is append-only", async () => {
    const dep = seedDeployment("deploying", "dpl_ao");
    await webhookRoute(signed(event("e-ao", "deployment.error", "dpl_ao")));
    expect(() => getDb().prepare("update app_deployment_events set to_status = 'published'").run()).toThrow(/immutable|append/i);
    expect(() => getDb().prepare("delete from app_deployment_events").run()).toThrow(/immutable|append/i);
    expect(dep).toBeTruthy();
  });
});
