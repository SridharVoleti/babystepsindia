-- EG-001: trusted, immutable app-owned achievements and safe aggregation.
create table learner_achievements (
  id uuid primary key,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  app_achievement_key text not null,
  achievement_instance_key text not null,
  achievement_contract_version text not null,
  app_achievement_model_version text not null,
  title text not null check(char_length(title) between 1 and 100),
  short_description text check(short_description is null or char_length(short_description)<=240),
  badge_asset_key text,
  category text not null check(category in
    ('milestone','mastery','level','efficiency','challenge','consistency','other')),
  earned_at timestamptz not null,
  source_progress_version bigint,
  source_completion_id text,
  source_session_id uuid references learner_sessions(id) on delete restrict,
  source_release_id uuid not null references app_releases(id) on delete restrict,
  app_key_snapshot text not null,
  app_name_snapshot text not null,
  app_icon_asset_key_snapshot text,
  record_version bigint not null default 1 check(record_version>0),
  state_hash text not null,
  acknowledged_at timestamptz not null,
  revoked_at timestamptz,
  revocation_reason_code text check(revocation_reason_code is null or revocation_reason_code in
    ('app_error','duplicate_emission','invalid_source')),
  revoked_by_principal_id uuid references app_service_principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(learner_id,app_id,achievement_instance_key)
);
create index idx_learner_achievements_feed
  on learner_achievements(learner_id,earned_at desc,id desc);
create index idx_learner_achievements_app
  on learner_achievements(app_id,earned_at desc,id desc);

create or replace function reject_achievement_earned_field_update() returns trigger language plpgsql as $$
begin
  if new.learner_id is distinct from old.learner_id
    or new.app_id is distinct from old.app_id
    or new.environment is distinct from old.environment
    or new.app_achievement_key is distinct from old.app_achievement_key
    or new.achievement_instance_key is distinct from old.achievement_instance_key
    or new.achievement_contract_version is distinct from old.achievement_contract_version
    or new.app_achievement_model_version is distinct from old.app_achievement_model_version
    or new.title is distinct from old.title
    or new.short_description is distinct from old.short_description
    or new.badge_asset_key is distinct from old.badge_asset_key
    or new.category is distinct from old.category
    or new.earned_at is distinct from old.earned_at
    or new.source_progress_version is distinct from old.source_progress_version
    or new.source_completion_id is distinct from old.source_completion_id
    or new.source_session_id is distinct from old.source_session_id
    or new.source_release_id is distinct from old.source_release_id
    or new.app_key_snapshot is distinct from old.app_key_snapshot
    or new.app_name_snapshot is distinct from old.app_name_snapshot
    or new.app_icon_asset_key_snapshot is distinct from old.app_icon_asset_key_snapshot
    or new.state_hash is distinct from old.state_hash
    or new.acknowledged_at is distinct from old.acknowledged_at then
    raise exception 'achievement earned fields are immutable';
  end if;
  return new;
end $$;
create trigger trg_learner_achievements_immutable
before update on learner_achievements
for each row execute function reject_achievement_earned_field_update();

create table achievement_mutation_receipts (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  achievement_id uuid not null references learner_achievements(id) on delete restrict,
  action text not null check(action in ('create','revoke')),
  idempotency_key text not null,
  request_hash text not null,
  response_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(app_id,action,idempotency_key)
);
create index idx_achievement_receipts_achievement
  on achievement_mutation_receipts(achievement_id,action,created_at);

create table app_release_achievement_contracts (
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  achievement_contract_version text not null,
  app_achievement_model_version text not null,
  allowed_badge_asset_keys_json jsonb not null default '[]'::jsonb,
  validation_report_json jsonb,
  status text not null default 'pending' check(status in ('pending','approved','blocked')),
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(app_id,release_id)
);
create index idx_release_achievement_contract_status
  on app_release_achievement_contracts(app_id,status,release_id);

create table achievement_journey_projection_outbox (
  id uuid primary key,
  achievement_id uuid not null references learner_achievements(id) on delete restrict,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  action text not null check(action in ('upsert','remove')),
  source_state_hash text not null,
  status text not null default 'pending' check(status in ('pending','processed','failed')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(achievement_id,action,source_state_hash)
);
create index idx_achievement_journey_outbox_status
  on achievement_journey_projection_outbox(status,created_at,id);

alter table learner_achievements enable row level security;
alter table learner_achievements force row level security;
alter table achievement_mutation_receipts enable row level security;
alter table achievement_mutation_receipts force row level security;
alter table app_release_achievement_contracts enable row level security;
alter table app_release_achievement_contracts force row level security;
alter table achievement_journey_projection_outbox enable row level security;
alter table achievement_journey_projection_outbox force row level security;
-- Server-role only: no browser PostgREST policies.
