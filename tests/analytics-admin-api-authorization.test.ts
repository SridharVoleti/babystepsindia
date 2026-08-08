import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));

import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";

describe("analytics admin API authorization", () => {
  beforeEach(() => {
    useInMemoryDb();
    mocks.getSession.mockReset();
  });

  it("denies analytics reads to a coarse admin without analytics_read", async () => {
    const user = (await sqliteAuthAdapter.signUp("limited-admin@example.com", "CorrectHorse1!")).user;
    getDb().prepare("update users set is_admin=1 where id=?").run(user.id);
    getDb().prepare("insert into admin_permissions(user_id,permission) values(?, 'app_registry_edit')")
      .run(user.id);
    mocks.getSession.mockResolvedValue({
      sub: user.id,
      email: user.email,
      isAdmin: true,
      entitlements: { bundle: false, products: [] },
    });

    const result = await requireAdminApi("analytics_read");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({ error: "FORBIDDEN" });
    }
  });

  it("allows analytics reads after the exact permission is granted", async () => {
    const user = (await sqliteAuthAdapter.signUp("analyst-admin@example.com", "CorrectHorse1!")).user;
    getDb().prepare("update users set is_admin=1 where id=?").run(user.id);
    getDb().prepare("insert into admin_permissions(user_id,permission) values(?, 'analytics_read')")
      .run(user.id);
    mocks.getSession.mockResolvedValue({
      sub: user.id,
      email: user.email,
      isAdmin: true,
      entitlements: { bundle: false, products: [] },
    });

    const result = await requireAdminApi("analytics_read");
    expect(result.ok).toBe(true);
  });
});
