-- EN-003 / minimal BI-005: one versioned entitlement-transition domain
-- consuming verified billing/identity/app-registry/security lifecycle
-- events. Cancellation (BI-004) and grace (BI-003) keep their existing
-- lazy-lapse mechanism entirely unchanged — expireCancellationState/
-- expireGraceSubscriptionState gain one added call each into this ledger
-- so every transition, old and new, is immutable and auditable (rules 8,
-- 68). This ledger is the sole writer of the terminal states BI-005
-- introduces: inactive_refunded, suspended_financial, suspended_security
-- (already present, unused, in learner_app_effective_entitlements.state's
-- CHECK constraint since migration 0032).

create table entitlement_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check(source in
    ('billing_cancellation','billing_grace','billing_refund','billing_chargeback',
     'billing_dispute','billing_reassignment','platform_security','reconciliation')),
  event_id text not null,
  event_type text not null,
  source_version integer not null,
  effective_at timestamptz not null,
  subscription_id uuid references subscriptions(id),
  paid_cycle_id text,
  refund_case_id uuid,
  dispute_id uuid,
  reassignment_case_id uuid references subscription_reassignment_cases(id),
  learner_id uuid not null references learners(id),
  -- The set of apps this event affects. Not a strict FK array (an app set
  -- snapshot, same reasoning as entitlement_cycles.app_ids_json) — the
  -- affected (learner,app,environment) rows are re-resolved from
  -- authoritative source tables at apply time, this is only the recorded
  -- input snapshot for audit/idempotency hashing.
  app_ids_json text not null,
  -- null = platform-level event (security revocation, reassignment audit)
  -- applying across every environment for this learner+app, not scoped to
  -- one provider environment.
  environment text,
  reason_category text not null,
  policy_effect text check(policy_effect is null or policy_effect in ('terminate_now','no_change')),
  fraud_or_security_risk integer not null default 0,
  payload_hash text not null,
  status text not null default 'pending' check(status in ('pending','applied','quarantined','rejected')),
  quarantine_reason text,
  conflicting_event_id uuid references entitlement_lifecycle_events(id),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, event_id)
);
create index idx_entitlement_lifecycle_events_status on entitlement_lifecycle_events(status, effective_at);
create index idx_entitlement_lifecycle_events_learner on entitlement_lifecycle_events(learner_id, created_at);
create index idx_entitlement_lifecycle_events_subscription on entitlement_lifecycle_events(subscription_id, source_version);

-- Append-only per rule 8/68 ("financial and entitlement history remain
-- immutable and auditable") — mirrors BI-001's
-- reject_subscription_assignment_audit_mutation trigger on
-- subscription_assignment_audit.
create table entitlement_state_transitions (
  id uuid primary key default gen_random_uuid(),
  effective_entitlement_id uuid not null references learner_app_effective_entitlements(id),
  lifecycle_event_id uuid not null references entitlement_lifecycle_events(id),
  previous_state text not null,
  new_state text not null,
  effective_at timestamptz not null,
  session_effect text not null check(session_effect in
    ('preserve_to_hard_expiry','cancel_starting','immediate_revoke','none')),
  reason_category text not null,
  transition_version integer not null,
  result text not null check(result in ('applied','duplicate','superseded','quarantined')),
  created_at timestamptz not null default now(),
  unique(effective_entitlement_id, lifecycle_event_id)
);
create index idx_entitlement_state_transitions_entitlement
  on entitlement_state_transitions(effective_entitlement_id, created_at);

create or replace function reject_entitlement_state_transition_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'entitlement state transition history is immutable';
end;
$$;
create trigger entitlement_state_transitions_no_update_delete
before update or delete on entitlement_state_transitions
for each row execute function reject_entitlement_state_transition_mutation();

-- Idempotency receipts, mirroring EN-001's entitlement_application_receipts.
create table entitlement_transition_receipts (
  lifecycle_event_id uuid primary key references entitlement_lifecycle_events(id),
  request_hash text not null,
  idempotency_status text not null check(idempotency_status in ('processing','completed','failed')),
  result_json jsonb,
  error_code text,
  attempt_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table learner_app_effective_entitlements
  add column if not exists scheduled_transition_at timestamptz,
  add column if not exists scheduled_transition_type text,
  add column if not exists lifecycle_version integer not null default 0,
  add column if not exists last_lifecycle_event_id uuid references entitlement_lifecycle_events(id),
  add column if not exists revoked_before timestamptz;

-- Minimal BI-005: admin-driven refund case + provider-confirmation, modeled
-- on subscription_reassignment_cases. No dispute-resolution workflow, no
-- new payment-gateway integration — reuses BI-001's provider-adapter shape.
create table refund_cases (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  refund_type text not null check(refund_type in ('full','partial')),
  amount integer,
  entitlement_effect text check(entitlement_effect is null or entitlement_effect in ('terminate_now','no_change')),
  reason_category text not null,
  status text not null default 'pending_provider_confirmation'
    check(status in ('pending_provider_confirmation','confirmed','reversed','rejected')),
  provider_refund_ref text,
  refund_confirmed_at timestamptz,
  version integer not null default 1 check(version>0),
  administrator_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- rule 36: entitlement_effect is required (and meaningful) only for a
  -- partial refund; a full refund's effect is implicitly terminate_now.
  check((refund_type='partial')=(entitlement_effect is not null))
);
create index idx_refund_cases_subscription on refund_cases(subscription_id, status);

-- Minimal BI-005: signed chargeback/dispute webhook receipts, mirroring
-- deployment_webhook_receipts' shape (AR-002 session 2).
create table financial_dispute_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null check(event_type in ('chargeback_confirmed','chargeback_reversed','dispute_opened')),
  subscription_id uuid not null references subscriptions(id),
  fraud_or_security_risk integer not null default 0,
  occurred_at timestamptz not null,
  payload_hash text not null,
  status text not null default 'received' check(status in ('received','processed','rejected')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);
create index idx_financial_dispute_events_subscription on financial_dispute_events(subscription_id, created_at);

-- process-due-transitions / reconcile-lifecycle bounded-sweep job ledger,
-- same shape as BI-002's billing_job_runs, scoped to this domain rather
-- than widening that table's job_type CHECK constraint.
create table entitlement_lifecycle_job_runs (
  principal_id uuid not null,
  job_type text not null check(job_type in ('sweep','reconcile')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('running','completed','failed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,job_type,run_idempotency_key)
);

alter table entitlement_lifecycle_events enable row level security;
alter table entitlement_state_transitions enable row level security;
alter table entitlement_transition_receipts enable row level security;
alter table refund_cases enable row level security;
alter table financial_dispute_events enable row level security;
alter table entitlement_lifecycle_job_runs enable row level security;
alter table entitlement_lifecycle_events force row level security;
alter table entitlement_state_transitions force row level security;
alter table entitlement_transition_receipts force row level security;
alter table refund_cases force row level security;
alter table financial_dispute_events force row level security;
alter table entitlement_lifecycle_job_runs force row level security;

-- No browser policies — these are entirely service-role-written and read;
-- parents/admins see only the safe views the API layer derives from them.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values
  (gen_random_uuid(),'entitlement-lifecycle-service','kms://babysteps/entitlement-lifecycle/v1','',
   'active',now(),now()+interval '365 days',1),
  (gen_random_uuid(),'entitlement-reconciliation-service','kms://babysteps/entitlement-reconciliation/v1','',
   'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;
