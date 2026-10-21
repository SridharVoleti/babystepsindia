-- Admin-controlled per-learner-per-app weekly session cap override. When a
-- row exists it takes precedence over the learner-wide
-- learners.unlimited_sessions / weekly_session_limit_override (0081) for that
-- one app; no row means "inherit the learner-wide setting". Additive only.

begin;

create table if not exists learner_app_session_limits (
  learner_id uuid not null references learners(id) on delete cascade,
  app_id uuid not null references app_registry(id) on delete restrict,
  unlimited_sessions boolean not null default false,
  weekly_session_limit_override integer check (weekly_session_limit_override is null or weekly_session_limit_override >= 1),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id)
);

alter table learner_app_session_limits enable row level security;
alter table learner_app_session_limits force row level security;

commit;
