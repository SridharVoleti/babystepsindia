-- AN-001 — minimal-data daily analytics aggregation. Mirrors
-- src/lib/db/schema.sql column for column. Row Level Security is enabled
-- on every table below with no anon/authenticated policies: all reads and
-- writes go through the service-role-backed internal/admin APIs, never
-- client-side (business rule 31/AC31).

-- Temporary pseudonymous source data. learner_daily_key is an HMAC over
-- (learner_id, activity_date) with a dedicated analytics secret (business
-- rule 6) — never the raw learner UUID. Deleted in full once its date's
-- run completes (business rule 25).
create table analytics_daily_buffer (
  activity_date date not null,
  learner_daily_key text not null,
  app_id uuid not null references app_registry(id) on delete restrict,
  level_key text not null,
  age_band text not null check (age_band in
    ('under_6','6_7','8_9','10_12','13_15','16_18','19_29','30_49','50_plus')),
  engaged_seconds integer not null default 0 check (engaged_seconds >= 0),
  sessions_started integer not null default 0 check (sessions_started >= 0),
  sessions_completed integer not null default 0 check (sessions_completed >= 0),
  sessions_interrupted integer not null default 0 check (sessions_interrupted >= 0),
  lessons_completed integer not null default 0 check (lessons_completed >= 0),
  updated_at timestamptz not null default now(),
  primary key (activity_date, learner_daily_key, app_id, level_key)
);

create index idx_analytics_daily_buffer_date on analytics_daily_buffer(activity_date);

alter table analytics_daily_buffer enable row level security;

-- Exact-once contribution tracking (business rule 11). Deleted together
-- with its date's buffer rows once the run completes (business rule 6).
create table analytics_contribution_receipts (
  contribution_id text primary key,
  activity_date date not null,
  created_at timestamptz not null default now()
);

create index idx_analytics_contribution_receipts_date
  on analytics_contribution_receipts(activity_date);

alter table analytics_contribution_receipts enable row level security;

-- Permanent, anonymous. No learner/parent identifier of any kind — grain
-- is date + app + level + age band only (business rule 5, 18).
create table analytics_daily_level (
  activity_date date not null,
  app_id uuid not null references app_registry(id) on delete restrict,
  level_key text not null,
  age_band text not null,
  active_learners integer not null default 0,
  sessions_started integer not null default 0,
  sessions_completed integer not null default 0,
  sessions_interrupted integer not null default 0,
  engaged_seconds integer not null default 0,
  lessons_completed integer not null default 0,
  generated_at timestamptz not null,
  run_version integer not null default 1,
  primary key (activity_date, app_id, level_key, age_band)
);

alter table analytics_daily_level enable row level security;

-- Same grain as analytics_daily_level but rolled up to app+age_band so a
-- learner active across several levels in one day is counted once
-- (business rule 19 / AT-AN-001-12), not once per level.
create table analytics_daily_app (
  activity_date date not null,
  app_id uuid not null references app_registry(id) on delete restrict,
  age_band text not null,
  active_learners integer not null default 0,
  sessions_started integer not null default 0,
  sessions_completed integer not null default 0,
  sessions_interrupted integer not null default 0,
  engaged_seconds integer not null default 0,
  lessons_completed integer not null default 0,
  generated_at timestamptz not null,
  run_version integer not null default 1,
  primary key (activity_date, app_id, age_band)
);

alter table analytics_daily_app enable row level security;

-- Run tracking/lock (business rules 16, 17, 26). Deliberately holds only
-- control totals and status — no learner information, ever.
create table analytics_daily_runs (
  activity_date date primary key,
  status text not null check (status in ('running','completed','failed')),
  run_version integer not null default 1,
  source_row_count integer not null default 0,
  source_engaged_seconds integer not null default 0,
  source_sessions_started integer not null default 0,
  source_sessions_completed integer not null default 0,
  source_sessions_interrupted integer not null default 0,
  source_lessons_completed integer not null default 0,
  started_at timestamptz not null,
  completed_at timestamptz,
  failure_code text
);

alter table analytics_daily_runs enable row level security;

-- Minimal admin-alert stand-in for "an administrator alert is emitted"
-- (business rule 24). Never carries learner information.
create table platform_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null,
  message text not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table platform_alerts enable row level security;

-- AN-001 business rule 29: current state only, one row per learner+app,
-- overwritten in place — deliberately not append-only/versioned history.
create table learner_app_progress (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  current_level_key text,
  current_lesson_key text,
  current_engaged_seconds integer not null default 0 check (current_engaged_seconds >= 0),
  app_state jsonb,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id)
);

alter table learner_app_progress enable row level security;

-- AN-001 business rule 30: one row per learner/app/lesson. completion_id
-- is the caller's deterministic idempotency key so a retried submission
-- neither duplicates the row nor double-counts into the buffer.
create table lesson_completions (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  lesson_key text not null,
  completion_id text not null unique,
  level_key text not null,
  completed_at timestamptz not null,
  engaged_seconds integer not null default 0 check (engaged_seconds >= 0),
  result text,
  primary key (learner_id, app_id, lesson_key)
);

alter table lesson_completions enable row level security;

-- Down migration (apply manually to reverse):
--
-- drop table if exists lesson_completions;
-- drop table if exists learner_app_progress;
-- drop table if exists platform_alerts;
-- drop table if exists analytics_daily_runs;
-- drop table if exists analytics_daily_app;
-- drop table if exists analytics_daily_level;
-- drop table if exists analytics_contribution_receipts;
-- drop table if exists analytics_daily_buffer;
