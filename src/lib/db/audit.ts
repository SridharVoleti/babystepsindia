import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { AuditLogEntry } from "@/lib/db/types";

export function logAuditEvent(params: {
  subscriptionId: string | null;
  changedBy: string;
  changeType: string;
  oldStatus: string | null;
  newStatus: string | null;
  note: string | null;
}) {
  getDb()
    .prepare(
      `insert into subscription_audit_log
         (id, subscription_id, changed_by, change_type, old_status, new_status, note)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      params.subscriptionId,
      params.changedBy,
      params.changeType,
      params.oldStatus,
      params.newStatus,
      params.note,
    );
}

export function listAuditLog(limit = 100): AuditLogEntry[] {
  return getDb()
    .prepare(
      `select * from subscription_audit_log order by created_at desc limit ?`,
    )
    .all(limit) as AuditLogEntry[];
}

export type AuditLogEntryWithContext = AuditLogEntry & {
  userEmail: string | null;
  productLabel: string | null;
};

export function listAuditLogWithContext(limit = 100): AuditLogEntryWithContext[] {
  return getDb()
    .prepare(
      `select al.*, u.email as userEmail,
              coalesce(pr.name, case when s.type = 'bundle' then 'Bundle' else null end) as productLabel
       from subscription_audit_log al
       left join subscriptions s on s.id = al.subscription_id
       left join users u on u.id = s.user_id
       left join products pr on pr.id = s.product_id
       order by al.created_at desc
       limit ?`,
    )
    .all(limit) as AuditLogEntryWithContext[];
}
