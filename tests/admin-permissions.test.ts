import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { hasAdminPermission } from "@/lib/auth/admin-permissions";

beforeEach(() => {
  useInMemoryDb();
});

describe("hasAdminPermission (business rule 2 / AT-AR-001-16)", () => {
  it("is false for an admin with no granted permissions", async () => {
    const user = (await sqliteAuthAdapter.signUp("editor@example.com", "CorrectHorse1!")).user;
    expect(hasAdminPermission(user.id, "app_registry_soft_delete")).toBe(false);
  });

  it("is true once the specific permission is granted, and stays false for others", async () => {
    const user = (await sqliteAuthAdapter.signUp("editor@example.com", "CorrectHorse1!")).user;
    getDb()
      .prepare("insert into admin_permissions (user_id, permission) values (?, ?)")
      .run(user.id, "app_registry_edit");

    expect(hasAdminPermission(user.id, "app_registry_edit")).toBe(true);
    expect(hasAdminPermission(user.id, "app_registry_soft_delete")).toBe(false);
  });

  it("the seeded bootstrap admin has every app_registry_* permission", () => {
    const admin = getDb().prepare("select id from users where is_admin = 1").get() as { id: string };
    for (const permission of [
      "app_registry_create",
      "app_registry_edit",
      "app_registry_activate",
      "app_registry_soft_delete",
      "app_registry_restore",
    ] as const) {
      expect(hasAdminPermission(admin.id, permission)).toBe(true);
    }
  });
});
