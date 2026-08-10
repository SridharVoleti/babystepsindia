-- PR-002: original-browser pre-expiry recovery of pending meaningful
-- progress, with server-authoritative conflict protection. Genuinely
-- greenfield — PR-004 (0043) explicitly modeled PR-002 as absent.

alter table learner_sessions add column if not exists last_acknowledged_progress_version integer;
alter table learner_sessions add column if not exists last_acknowledged_progress_hash text;
alter table learner_sessions add column if not exists recovery_closed_at timestamptz;
alter table learner_sessions add column if not exists recovery_closed_reason text
  check (recovery_closed_reason in ('finalized','secure_exit','hard_expired','security_revoked','irrecoverable')
    or recovery_closed_reason is null);

-- Append-only, metadata-only per rule 45 — no raw pendingState/current_state
-- is ever persisted here.
create table if not exists progress_recovery_receipts (
  id uuid primary key,
  learner_session_id uuid not null references learner_sessions(id),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  device_session_id text not null,
  recovery_capsule_id text not null,
  recovery_sequence integer not null,
  base_progress_version integer not null,
  base_state_hash text not null,
  new_progress_version integer,
  new_state_hash text,
  release_id uuid,
  deployment_id uuid,
  request_hash text not null,
  idempotency_key text not null,
  result text not null check (result in ('recovered','stale','rejected')),
  result_code text,
  created_at timestamptz not null,
  unique(learner_session_id, idempotency_key)
);
create index if not exists idx_prr_session_sequence on progress_recovery_receipts(learner_session_id, recovery_sequence);
alter table progress_recovery_receipts enable row level security;
alter table progress_recovery_receipts force row level security;

-- Safe metadata-only recovery-attempt incidents (rule 63) — a discrete
-- per-attempt problem log, not a persistent per-learner-app state machine
-- like PR-004's progress_integrity_incidents, so dedup is scoped to
-- (session, category) rather than (learner, app).
create table if not exists progress_recovery_incidents (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  learner_id uuid not null references learners(id),
  learner_session_id uuid not null references learner_sessions(id),
  release_id uuid,
  category text not null check (category in
    ('stale','device_mismatch','schema_migration_required','integrity_blocked','incomplete_receipt')),
  base_progress_version integer,
  base_state_hash text,
  current_progress_version integer,
  current_state_hash text,
  status text not null default 'open' check (status in ('open','resolved')),
  attempt_count integer not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  resolved_at timestamptz
);
create unique index if not exists ux_pri_active on progress_recovery_incidents(learner_session_id, category)
  where status = 'open';
alter table progress_recovery_incidents enable row level security;
alter table progress_recovery_incidents force row level security;

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000007', 'progress-recovery-reconciler',
   'progress-recovery-reconciler-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;
