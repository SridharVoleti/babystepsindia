-- EN-004: automatic repair from verified source truth, conflict quarantine
-- and cross-domain integrity monitoring. Every repair calls through to the
-- same EN-001 (applyPaidCycle), EN-002 (recomputeEffectiveEntitlement),
-- EN-003 (applyLifecycleEvent) or SC-002
-- (ensureEntitlementPeriodStandardAllocation) domain functions normal event
-- processing already uses — nothing here inserts a ready entitlement,
-- changes a credit count or sets an effective allowed flag directly.

-- One row per source record compared against its expected target, whether
-- the result was healthy/no-op, an applied repair, a deferred transient
-- failure or an opened incident (rules 8-9, 43).
create table entitlement_reconciliation_receipts (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check(source_type in
    ('paid_cycle','entitlement_period','effective_entitlement','lifecycle_event','credit_batch')),
  source_id text not null,
  source_version integer,
  source_hash text,
  expected_target_hash text,
  action text not null check(action in ('healthy','repair','defer','incident')),
  target_type text,
  target_id text,
  target_version integer,
  result text not null check(result in ('applied','no_op','failed')),
  attempt_count integer not null default 1,
  principal_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, source_id, source_version, target_type)
);
create index idx_entitlement_reconciliation_receipts_source
  on entitlement_reconciliation_receipts(source_type, source_id);

-- Rule 59 dedup at the whole-page-run grain, same shape as
-- progress_integrity_sweep_runs — a retried sweep call with the same
-- runIdempotencyKey+cursor returns the cached page result instead of
-- reprocessing and double-counting (rules 6, 55).
create table entitlement_integrity_sweep_runs (
  run_idempotency_key text not null,
  cursor text not null default '',
  environment text not null,
  source_domains_json text not null default '[]',
  window_from timestamptz,
  window_to timestamptz,
  principal_id uuid not null,
  processed integer not null,
  healthy_count integer not null default 0,
  repaired_count integer not null default 0,
  deferred_count integer not null default 0,
  incidents_opened_count integer not null default 0,
  errors_count integer not null default 0,
  next_cursor text,
  created_at timestamptz not null default now(),
  primary key(run_idempotency_key, cursor)
);

-- Rules 22, 31, 36, 38, 45: a narrowly-scoped operations incident queue for
-- genuine conflicts reconciliation must not silently resolve on its own —
-- mismatched identities, a ready target with no verified source, or a
-- used/mismatched batch. Safe technical identifiers and a mismatch category
-- only; no sensitive provider payload, payment instrument or progress data.
create table entitlement_integrity_incidents (
  id uuid primary key default gen_random_uuid(),
  environment text not null,
  category text not null check(category in
    ('MISSING_ENTITLEMENT','INCOMPLETE_ENTITLEMENT','PRODUCT_SNAPSHOT_MISMATCH','LEARNER_MISMATCH',
     'PERIOD_MISMATCH','SOURCE_HASH_MISMATCH','APP_SET_MISMATCH','ENTITLEMENT_WITHOUT_VERIFIED_SOURCE',
     'MISSING_EFFECTIVE_ENTITLEMENT','MISSING_LIFECYCLE_EVENT','MISSING_ALLOCATION_BATCH',
     'EXTRA_BATCH_UNKNOWN_SOURCE','BATCH_ATTRIBUTE_MISMATCH')),
  source_type text not null,
  source_id text not null,
  target_type text,
  target_id text,
  expected_hash text,
  actual_hash text,
  severity text not null check(severity in ('low','medium','high','critical')),
  status text not null default 'open' check(status in
    ('open','investigating','resolved_repaired','resolved_false_positive','routed_refund_case')),
  remediation_workflow text not null default 'none'
    check(remediation_workflow in ('none','refund_case','manual_source_correction')),
  remediation_reference text,
  assigned_operator_id uuid references auth.users(id),
  attempt_count integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- Rule 22: exactly one active incident per source record under review.
create unique index ux_eii_active on entitlement_integrity_incidents(source_type, source_id)
  where status in ('open','investigating');

create table entitlement_integrity_incident_actions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references entitlement_integrity_incidents(id),
  action text not null check(action in ('retry','resolve_false_positive','open_refund_case')),
  actor_admin_id uuid not null references auth.users(id),
  reauthenticated_at timestamptz not null,
  expected_version integer not null,
  idempotency_key text not null,
  reason_category text,
  evidence_refs text not null default '[]',
  result text not null check(result in ('applied','rejected','no_op')),
  result_code text,
  prior_incident_status text,
  new_incident_status text,
  created_at timestamptz not null default now(),
  unique(incident_id,idempotency_key)
);

-- Rules 41-42, 51-52: 'repair_in_progress' blocks new sessions while a
-- verified-but-incomplete source is being reconciled; 'quarantined' blocks
-- them while a genuine conflict is under incident review.
alter table learner_app_effective_entitlements
  add column if not exists integrity_state text not null default 'healthy'
    check(integrity_state in ('healthy','repair_in_progress','quarantined')),
  add column if not exists last_reconciled_source_version integer,
  add column if not exists last_reconciled_at timestamptz;

-- Rules 36-38: a batch belonging to a suppressed/unknown source is frozen
-- from new funding rather than deleted (counters/history preserved).
alter table learner_app_standard_credit_batches
  add column if not exists funding_disabled_at timestamptz,
  add column if not exists funding_disabled_reason text,
  add column if not exists reconciliation_receipt_id uuid references entitlement_reconciliation_receipts(id);

alter table entitlement_reconciliation_receipts enable row level security;
alter table entitlement_integrity_sweep_runs enable row level security;
alter table entitlement_integrity_incidents enable row level security;
alter table entitlement_integrity_incident_actions enable row level security;
alter table entitlement_reconciliation_receipts force row level security;
alter table entitlement_integrity_sweep_runs force row level security;
alter table entitlement_integrity_incidents force row level security;
alter table entitlement_integrity_incident_actions force row level security;

-- No browser policies — these are entirely service-role-written and read;
-- parents/admins see only the safe views the API layer derives from them.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values
  (gen_random_uuid(),'entitlement-integrity-monitor-service','kms://babysteps/entitlement-integrity-monitor/v1','',
   'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;
