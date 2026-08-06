// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { SessionEnvelopeError, issueSessionEnvelope, verifySessionEnvelope } from "@/lib/session-runtime/envelope";

const SECRET = "session-envelope-test-secret-at-least-32-characters";

function claims(overrides: Partial<Parameters<typeof issueSessionEnvelope>[0]> = {}) {
  return {
    learner_session_id: "session-1", learner_id: "learner-1", app_id: "app-1",
    environment: "production", deployment_id: "deployment-1", release_id: "release-1",
    device_session_id: "device-1", usable_launch_established_at: "2026-08-05T10:00:00.000Z",
    hard_expires_at: "2026-08-05T11:00:00.000Z", maximum_connected_seconds: 2700,
    ...overrides,
  };
}

const bindings = { appId: "app-1", deploymentId: "deployment-1", releaseId: "release-1" };

beforeEach(() => { process.env.SESSION_ENVELOPE_SECRET = SECRET; });

describe("SC-001 session envelope", () => {
  it("issues and verifies a valid envelope with exact bindings", async () => {
    const now = new Date("2026-08-05T10:00:01.000Z");
    const token = await issueSessionEnvelope(claims(), now);
    const verified = await verifySessionEnvelope(token, bindings, now);
    expect(verified).toMatchObject({
      learner_session_id: "session-1", learner_id: "learner-1", app_id: "app-1",
      environment: "production", deployment_id: "deployment-1", release_id: "release-1",
      device_session_id: "device-1", maximum_connected_seconds: 2700, envelope_version: 1,
    });
  });

  it("rejects wrong app/deployment/release binding", async () => {
    const now = new Date("2026-08-05T10:00:01.000Z");
    const token = await issueSessionEnvelope(claims(), now);
    await expect(verifySessionEnvelope(token, { ...bindings, appId: "other-app" }, now))
      .rejects.toThrow(new SessionEnvelopeError("SESSION_ENVELOPE_INVALID"));
    await expect(verifySessionEnvelope(token, { ...bindings, deploymentId: "other-deploy" }, now))
      .rejects.toThrow(new SessionEnvelopeError("SESSION_ENVELOPE_INVALID"));
    await expect(verifySessionEnvelope(token, { ...bindings, releaseId: "other-release" }, now))
      .rejects.toThrow(new SessionEnvelopeError("SESSION_ENVELOPE_INVALID"));
  });

  it("rejects an envelope past hard_expires_at with SESSION_HARD_EXPIRED", async () => {
    const token = await issueSessionEnvelope(claims(), new Date("2026-08-05T10:00:01.000Z"));
    await expect(verifySessionEnvelope(token, bindings, new Date("2026-08-05T11:00:01.000Z")))
      .rejects.toThrow(new SessionEnvelopeError("SESSION_HARD_EXPIRED"));
  });

  it("rejects a tampered signature", async () => {
    const now = new Date("2026-08-05T10:00:01.000Z");
    const token = await issueSessionEnvelope(claims(), now);
    const tampered = token.slice(0, -2) + (token.slice(-2) === "AA" ? "BB" : "AA");
    await expect(verifySessionEnvelope(tampered, bindings, now))
      .rejects.toThrow(new SessionEnvelopeError("SESSION_ENVELOPE_INVALID"));
  });

  it("rejects an envelope signed with a different secret", async () => {
    const now = new Date("2026-08-05T10:00:01.000Z");
    const token = await issueSessionEnvelope(claims(), now, "a-completely-different-secret-of-32-chars");
    await expect(verifySessionEnvelope(token, bindings, now))
      .rejects.toThrow(new SessionEnvelopeError("SESSION_ENVELOPE_INVALID"));
  });

  it("throws when the signing secret is missing or too short", async () => {
    const now = new Date("2026-08-05T10:00:01.000Z");
    await expect(issueSessionEnvelope(claims(), now, "too-short")).rejects.toThrow();
    delete process.env.SESSION_ENVELOPE_SECRET;
    await expect(issueSessionEnvelope(claims(), now)).rejects.toThrow();
  });
});
