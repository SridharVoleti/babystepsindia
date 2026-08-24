import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";

export const ALLOWED_ERROR_CLASSES = [
  "dependency_unavailable",
  "timeout",
  "rate_limited",
  "validation",
  "conflict",
  "internal",
] as const;

export type OperationalErrorClass = (typeof ALLOWED_ERROR_CLASSES)[number];
export type OperationalRunStatus = "running" | "succeeded" | "failed";

export type OperationalRunInput = {
  operationKey: string;
  runKey: string;
  status: OperationalRunStatus;
  processedCount?: number;
  succeededCount?: number;
  failedCount?: number;
  durationMs?: number;
  retryCount?: number;
  errorClass?: OperationalErrorClass | null;
  correlationId: string;
  startedAt: string;
  completedAt?: string | null;
};

const nonNegative = (value: number | undefined) => Math.max(0, Math.trunc(value ?? 0));

export function recordOperationalRun(input: OperationalRunInput) {
  if (!input.operationKey.trim() || !input.runKey.trim() || !input.correlationId.trim()) {
    throw new Error("OPERATIONAL_MONITORING_IDENTITY_REQUIRED");
  }
  if (input.errorClass && !ALLOWED_ERROR_CLASSES.includes(input.errorClass)) {
    throw new Error("OPERATIONAL_MONITORING_ERROR_CLASS_INVALID");
  }

  db.prepare(`
    insert into operational_monitoring_runs(
      id,operation_key,run_key,status,processed_count,succeeded_count,failed_count,
      duration_ms,retry_count,error_class,correlation_id,started_at,completed_at,created_at
    ) values(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    on conflict(operation_key,run_key) do update set
      status=excluded.status,
      processed_count=excluded.processed_count,
      succeeded_count=excluded.succeeded_count,
      failed_count=excluded.failed_count,
      duration_ms=excluded.duration_ms,
      retry_count=excluded.retry_count,
      error_class=excluded.error_class,
      correlation_id=excluded.correlation_id,
      started_at=excluded.started_at,
      completed_at=excluded.completed_at
  `).run(
    randomUUID(), input.operationKey.trim(), input.runKey.trim(), input.status,
    nonNegative(input.processedCount), nonNegative(input.succeededCount), nonNegative(input.failedCount),
    nonNegative(input.durationMs), nonNegative(input.retryCount), input.errorClass ?? null,
    input.correlationId.trim(), input.startedAt, input.completedAt ?? null,
  );
}

export function getLatestOperationalRun(operationKey: string) {
  return db.prepare(`
    select operation_key,run_key,status,processed_count,succeeded_count,failed_count,
      duration_ms,retry_count,error_class,correlation_id,started_at,completed_at
    from operational_monitoring_runs
    where operation_key=?
    order by started_at desc
    limit 1
  `).get(operationKey);
}
