import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { POST as webhookRoute } from "@/app/v1/internal/deployment-provider/webhook/route";

const secret = "deployment-webhook-shared-secret-at-least-32-chars";

beforeEach(() => {
  useInMemoryDb();
  process.env.DEPLOYMENT_WEBHOOK_SECRET = secret;
});

function signedRequest(body: Record<string, unknown>, opts: { timestampSeconds?: number; badSignature?: boolean } = {}) {
  const rawBody = JSON.stringify(body);
  const timestampSeconds = opts.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signature = opts.badSignature
    ? "0".repeat(64)
    : createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return new Request("http://localhost/v1/internal/deployment-provider/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-babysteps-webhook-signature": signature,
      "x-babysteps-webhook-timestamp": String(timestampSeconds),
    },
    body: rawBody,
  });
}

describe("AR-002 session 2: signed webhook ingestion", () => {
  it("records a validly signed, fresh event", async () => {
    const response = await webhookRoute(signedRequest({ provider: "vercel", eventId: "evt-1", type: "deployment.ready" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ id: expect.any(String), provider: "vercel", providerEventId: "evt-1", status: "processed" });

    const row = getDb().prepare("select status from deployment_webhook_receipts where provider = ? and provider_event_id = ?").get("vercel", "evt-1") as { status: string };
    expect(row.status).toBe("processed");
  });

  // AT-AR-002-30: a forged signature is rejected.
  it("rejects a forged signature", async () => {
    const response = await webhookRoute(signedRequest({ provider: "vercel", eventId: "evt-2", type: "deployment.ready" }, { badSignature: true }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "WEBHOOK_SIGNATURE_INVALID" });
  });

  it("rejects a stale timestamp outside the tolerance window", async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10 * 60;
    const response = await webhookRoute(signedRequest({ provider: "vercel", eventId: "evt-3", type: "deployment.ready" }, { timestampSeconds: staleTimestamp }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "WEBHOOK_SIGNATURE_INVALID" });
  });

  // AT-AR-002-31: a replayed event ID does not duplicate the receipt.
  it("rejects a replayed event ID even with a valid signature", async () => {
    const first = await webhookRoute(signedRequest({ provider: "vercel", eventId: "evt-4", type: "deployment.ready" }));
    expect(first.status).toBe(200);

    const replay = await webhookRoute(signedRequest({ provider: "vercel", eventId: "evt-4", type: "deployment.ready" }));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({ error: "WEBHOOK_REPLAYED" });

    const count = getDb().prepare("select count(*) as n from deployment_webhook_receipts where provider = ? and provider_event_id = ?").get("vercel", "evt-4") as { n: number };
    expect(count.n).toBe(1);
  });

  it("rejects when no webhook secret is configured", async () => {
    delete process.env.DEPLOYMENT_WEBHOOK_SECRET;
    const response = await webhookRoute(signedRequest({ provider: "vercel", eventId: "evt-5", type: "deployment.ready" }));
    expect(response.status).toBe(401);
  });
});
