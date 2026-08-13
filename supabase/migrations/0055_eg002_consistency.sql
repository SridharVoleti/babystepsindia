-- EG-002: per-app weekly consistency derived from the SC-002 funded-use
-- cadence. All tables are backend-only under forced RLS.
create table learner_app_consistency (
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  current_streak_weeks integer not null default 0 check(current_streak_weeks>=0),
  longest_streak_weeks integer not null default 0 check(longest_streak_weeks>=0),
  current_week_key text not null,
  current_week_progress integer not null default 0 check(current_week_progress between 0 and 2),
  current_week_start_at timestamptz not null,
  current_week_end_at timestamptz not null,
  latest_completed_week_key text,
  last_computed_usage_version integer not null default 0,
  state_version integer not null default 1,
  state_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(learner_id,app_id,environment)
);
create index idx_learner_app_consistency_current
  on learner_app_consistency(learner_id,environment,current_week_key,app_id);

create table learner_app_consistency_weeks (
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  weekly_key text not null,
  week_timezone text not null,
  weekly_start_at timestamptz not null,
  weekly_end_at timestamptz not null,
  cadence_target integer not null default 2 check(cadence_target=2),
  qualifying_standard_sessions integer not null default 0 check(qualifying_standard_sessions between 0 and 2),
  status text not null default 'open' check(status in
    ('open','cadence_complete','incomplete_reset','neutral_partial','platform_unavailable_neutral','out_of_scope')),
  entitlement_opening_state text not null check(entitlement_opening_state in
    ('eligible','approved_grace','partial_start','out_of_scope')),
  entitlement_opening_reference uuid,
  availability_neutral_evidence text,
  cadence_completed_by_session_id uuid references learner_sessions(id) on delete restrict,
  completed_at timestamptz,
  finalized_at timestamptz,
  result_version integer not null default 1,
  result_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(learner_id,app_id,environment,weekly_key)
);
create index idx_consistency_weeks_history
  on learner_app_consistency_weeks(learner_id,weekly_start_at desc,app_id,weekly_key);
create index idx_consistency_weeks_finalize
  on learner_app_consistency_weeks(environment,status,weekly_end_at,learner_id,app_id);

create table consistency_mutation_receipts (
  id uuid primary key,
  learner_id uuid references learners(id) on delete restrict,
  app_id uuid references app_registry(id) on delete restrict,
  environment text not null,
  weekly_key text,
  action text not null check(action in ('standard_session_committed','finalize_week','reconcile')),
  source_session_id uuid references learner_sessions(id) on delete restrict,
  source_usage_version integer,
  event_id text not null,
  run_idempotency_key text,
  cursor text not null default '',
  request_hash text not null,
  status text not null default 'pending' check(status in ('pending','completed','failed')),
  result_json jsonb,
  principal_id text not null,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(action,event_id)
);
create index idx_consistency_receipts_pending
  on consistency_mutation_receipts(status,action,created_at,id);
create index idx_consistency_receipts_scope
  on consistency_mutation_receipts(learner_id,app_id,weekly_key,action,created_at);

alter table learner_app_consistency enable row level security;
alter table learner_app_consistency force row level security;
alter table learner_app_consistency_weeks enable row level security;
alter table learner_app_consistency_weeks force row level security;
alter table consistency_mutation_receipts enable row level security;
alter table consistency_mutation_receipts force row level security;
-- Server-role only: no browser PostgREST policies.
