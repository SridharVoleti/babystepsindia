-- EG-006 parent-only consolidated learning reminders. Server-role only: no
-- browser PostgREST policy and no learner contact storage.
create table parent_notification_preferences (
  parent_id uuid primary key references profiles(id) on delete cascade,
  learning_reminder_email_enabled boolean not null default true,
  version bigint not null default 1 check(version>0),
  last_idempotency_key text,
  last_request_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table learning_reminder_batches (
  id uuid primary key,
  parent_id uuid not null references profiles(id) on delete cascade,
  reminder_stage text not null check(reminder_stage in ('mid_window','final_window')),
  scheduler_run_id text not null,
  status text not null default 'evaluating'
    check(status in ('evaluating','ready','suppressed','sending','sent','failed')),
  item_count integer not null default 0 check(item_count>=0),
  template_version text not null default 'eg006-v1',
  expected_parent_identity_version text,
  idempotency_key text not null unique,
  batch_version bigint not null default 1 check(batch_version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index idx_learning_reminder_batches_parent_stage
  on learning_reminder_batches(parent_id,reminder_stage,status,created_at,id);

create table learning_reminder_items (
  id uuid primary key,
  batch_id uuid not null references learning_reminder_batches(id) on delete cascade,
  parent_id uuid not null references profiles(id) on delete cascade,
  learner_id uuid not null references learners(id) on delete cascade,
  app_id uuid not null references app_registry(id) on delete restrict,
  weekly_key text not null,
  reminder_stage text not null check(reminder_stage in ('mid_window','final_window')),
  observed_weekly_progress integer not null check(observed_weekly_progress in (0,1)),
  remaining_normal_sessions integer not null check(remaining_normal_sessions in (1,2)),
  eligibility_version bigint not null,
  eligibility_digest text not null,
  availability_note text,
  status text not null default 'candidate' check(status in ('candidate','included','suppressed')),
  suppressed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(parent_id,learner_id,app_id,weekly_key,reminder_stage)
);
create index idx_learning_reminder_items_batch
  on learning_reminder_items(batch_id,status,learner_id,app_id);
create index idx_learning_reminder_items_scope
  on learning_reminder_items(parent_id,weekly_key,reminder_stage,learner_id,app_id);

create table learning_reminder_deliveries (
  id uuid primary key,
  batch_id uuid not null unique references learning_reminder_batches(id) on delete cascade,
  provider_message_id text,
  provider_status text not null default 'pending'
    check(provider_status in ('pending','accepted','delivered','uncertain','retry_pending','failed')),
  destination_identity_version text not null,
  destination_email_hash text not null,
  attempt_count integer not null default 0 check(attempt_count between 0 and 3),
  provider_idempotency_key text not null unique,
  api_idempotency_key text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  last_attempt_at timestamptz,
  unique(batch_id,api_idempotency_key)
);
create index idx_learning_reminder_deliveries_status
  on learning_reminder_deliveries(provider_status,updated_at,batch_id);

create table learning_reminder_job_runs (
  principal_id uuid not null references platform_service_principals(id) on delete restrict,
  operation text not null check(operation in ('evaluate','reconcile')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,operation,run_idempotency_key)
);

alter table parent_notification_preferences enable row level security;
alter table parent_notification_preferences force row level security;
alter table learning_reminder_batches enable row level security;
alter table learning_reminder_batches force row level security;
alter table learning_reminder_items enable row level security;
alter table learning_reminder_items force row level security;
alter table learning_reminder_deliveries enable row level security;
alter table learning_reminder_deliveries force row level security;
alter table learning_reminder_job_runs enable row level security;
alter table learning_reminder_job_runs force row level security;
