import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn() }));
vi.mock("@/lib/staff-identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/session")>()),
  getStaffSession: mocks.getStaffSession,
}));

import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { seedStaffSession } from "./helpers/staff-session-fixture";

describe("analytics admin API authorization", () => {
  beforeEach(() => {
    useInMemoryDb();
    mocks.getStaffSession.mockReset();
  });

  it("denies analytics reads to a staff member without an analytics-capable role", async () => {
    const session = seedStaffSession(["billing_administrator"]);
    mocks.getStaffSession.mockResolvedValue(session);

    const result = await requireAdminApi("admin.analytics.daily.read");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({ error: "FORBIDDEN" });
    }
  });

  it("allows analytics reads for the Operations Administrator role that carries it", async () => {
    const session = seedStaffSession(["operations_administrator"]);
    mocks.getStaffSession.mockResolvedValue(session);

    const result = await requireAdminApi("admin.analytics.daily.read");
    expect(result.ok).toBe(true);
  });
});
