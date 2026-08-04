import { describe, expect, it } from "vitest";
import { stubReadinessAdapter } from "@/lib/app-registry/readiness-adapter";

describe("stubReadinessAdapter (AR-002 seam)", () => {
  it("always reports ready, since AR-002 doesn't exist yet", async () => {
    const result = await stubReadinessAdapter.checkReady("any-app-id");
    expect(result).toEqual({ ready: true });
  });
});
