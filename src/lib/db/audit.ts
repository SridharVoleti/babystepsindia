import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { AuditLogEntry } from "@/lib/db/types";

export async function logAuditEvent(params: {
  subscriptionId: string | null;
  changedBy: string;
  changeType: string;
  oldStatus: string | null;
  newStatus: string | null;
  note: string | null;
}) {
  await resolveDbClient().run(
    `insert into subscription_audit_log
       (id, subscription_id, changed_by, change_type, old_status, new_status, note)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      params.subscriptionId,
      params.changedBy,
      params.changeType,
      params.oldStatus,
      params.newStatus,
      params.note,
    ],
  );
}

export async function listAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  return resolveDbClient().all<AuditLogEntry>(
    `select * from subscription_audit_log order by created_at desc limit ?`,
    [limit],
  );
}

export type AuditLogEntryWithContext = AuditLogEntry & {
  userEmail: string | null;
  productLabel: string | null;
};

export async function listAuditLogWithContext(limit = 100): Promise<AuditLogEntryWithContext[]> {
  return resolveDbClient().all<AuditLogEntryWithContext>(
    `select al.*, u.email as userEmail,
            coalesce(pr.name, case when s.type = 'bundle' then 'Bundle' else null end) as productLabel
     from subscription_audit_log al
     left join subscriptions s on s.id = al.subscription_id
     left join users u on u.id = s.user_id
     left join products pr on pr.id = s.product_id
     order by al.created_at desc
     limit ?`,
    [limit],
  );
}
