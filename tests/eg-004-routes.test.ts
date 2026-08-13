import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeProtectedAppApi: vi.fn(async () => ({ grantId: "grant", principalId: "principal",
    learnerSessionId: "session", learnerId: "learner", appId: "app" })),
  writeProgressSummary: vi.fn((_auth: unknown, body: unknown) => ({ ok: true, body })),
}));

vi.mock("@/lib/app-authorization/guard", () => ({ authorizeProtectedAppApi: mocks.authorizeProtectedAppApi }));
vi.mock("@/lib/app-progress/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-progress/service")>()),
  writeProgressSummary: mocks.writeProgressSummary,
}));

import { PUT } from "@/app/v1/internal/learner-app-progress/summary/route";
import { resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";

const body = { basedOnProgressVersion: 4, progressSummary: { currentLevel: "Level 4", efficiencyStars: 3,
  milestone: null, nextDestination: "Level 5", motivationProgress: { displayType: "steps",
    stepPosition: 3, stepCount: 7 } }, summaryIdempotencyKey: "summary-1" };
const request = (value: unknown) => new Request("http://localhost/v1/internal/learner-app-progress/summary",
  { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

beforeEach(() => vi.clearAllMocks());

describe("EG-004 API-EG-015 route", () => {
  it("requires the exact progress.summary.write app-session scope", async () => {
    const response = await PUT(request(body));
    expect(response.status).toBe(200);
    expect(mocks.authorizeProtectedAppApi).toHaveBeenCalledWith(expect.any(Request), "progress.summary.write");
  });
  it("passes only the exact based-on version, summary, and idempotency key", async () => {
    await PUT(request(body));
    expect(mocks.writeProgressSummary).toHaveBeenCalledWith(expect.objectContaining({ appId: "app" }), body,
      expect.any(Date));
  });
  it("rejects client extensions before invoking the mutation", async () => {
    const response = await PUT(request({ ...body, percentageDerivedFromSteps: 43 }));
    expect(response.status).toBe(400);
    expect(mocks.writeProgressSummary).not.toHaveBeenCalled();
  });
  it("returns no-store acknowledgements", async () => {
    expect((await PUT(request(body))).headers.get("Cache-Control")).toBe("no-store");
  });
  it("maps the endpoint to the app-service authorization action", () => {
    expect(resolveApiRouteAuthorization("PUT", "/v1/internal/learner-app-progress/summary"))
      .toBe("app.progress.summary.write");
    expect(AUTHORIZATION_ACTIONS["app.progress.summary.write"]).toMatchObject({ mode: "app_service", resource: "learner" });
  });
});
