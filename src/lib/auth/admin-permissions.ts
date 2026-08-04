import { getDb } from "@/lib/db/client";
import type { AppRegistryPermission } from "@/lib/db/types";

// Granular layer on top of the coarse users.is_admin flag — an admin who
// can reach /admin at all may still lack a specific mutation permission
// (business rule 2; AT-AR-001-16: an editor without app_registry_soft_delete
// must be denied even though they're an admin).
export function hasAdminPermission(userId: string, permission: AppRegistryPermission): boolean {
  const row = getDb()
    .prepare("select 1 from admin_permissions where user_id = ? and permission = ?")
    .get(userId, permission);
  return !!row;
}
