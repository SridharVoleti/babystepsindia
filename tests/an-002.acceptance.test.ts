import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const has = (value: string, pattern: RegExp) => expect(value).toMatch(pattern);
const lacks = (value: string, pattern: RegExp) => expect(value).not.toMatch(pattern);

const sources = {
  schema: () => read("src/lib/db/schema.sql"),
  migration: () => read("supabase/migrations/0051_an002_operational_monitoring.sql"),
  repository: () => read("src/lib/db/operational-monitoring-repo.ts"),
  retention: () => read("src/lib/operational-monitoring/retention.ts"),
  scheduler: () => read(".github/workflows/an002-monitoring-retention.yml"),
};

const table = (name: string) => {
  const match = sources.schema().match(
    new RegExp(`create table if not exists ${name} \\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  expect(match, `${name} must exist in the canonical schema`).not.toBeNull();
  return match![1];
};

describe("AN-002 acceptance criteria", () => {
  it("AT-AN-002-01 exposes privacy-safe critical operation status and controlled failures", () => {
    const detail = table("operational_monitoring_runs");
    has(detail, /operation_key text not null/);
    has(detail, /status text not null check \(status in \('running','succeeded','failed'\)\)/);
    has(detail, /processed_count integer not null default 0/);
    has(detail, /duration_ms integer not null default 0/);
    has(detail, /retry_count integer not null default 0/);
    has(detail, /error_class text/);
    has(detail, /correlation_id text not null/);
    lacks(detail, /\b(?:learner_id|parent_user_id|email|phone|display_name|raw_payload|request_body|response_body)\b/i);
    has(sources.repository(), /recordOperationalRun/);
    has(sources.repository(), /ALLOWED_ERROR_CLASSES/);
  });

  it("AT-AN-002-02 keeps monitoring strictly observational and non-authoritative", () => {
    const monitoring = sources.repository() + sources.retention();
    lacks(monitoring, /\b(?:update|insert into|delete from)\s+(?:subscriptions|entitlements|learner_sessions|learner_app_progress|lesson_completions)\b/i);
    has(sources.migration(), /alter table operational_monitoring_runs enable row level security/);
    has(sources.migration(), /alter table operational_monitoring_monthly enable row level security/);
  });

  it("AT-AN-002-03 enforces 30-day detail and 12-month monthly aggregate retention", () => {
    const monthly = table("operational_monitoring_monthly");
    has(monthly, /month_start date not null/);
    has(monthly, /operation_key text not null/);
    has(monthly, /run_count integer not null default 0/);
    has(monthly, /failure_count integer not null default 0/);
    has(monthly, /processed_count bigint not null default 0/);
    has(sources.retention(), /30 days/);
    has(sources.retention(), /12 months/);
    has(sources.retention(), /operational_monitoring_monthly/);
    has(sources.retention(), /delete from operational_monitoring_runs/);
    has(sources.retention(), /delete from operational_monitoring_monthly/);
    has(sources.scheduler(), /cron:/);
  });

  it("does not introduce continuous synthetic app probes", () => {
    const workflow = sources.scheduler();
    lacks(workflow, /curl .*\/api\/(?:launch|session|progress)|synthetic|heartbeat/i);
  });
});
