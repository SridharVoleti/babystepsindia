-- NT-001: reliable, source-owned transactional parent-email delivery.
-- Server-role only: no browser PostgREST policy. Source domains
-- (BI-002/003/004/005, IA-003) write intents inside their own commit
-- transaction; NT-001 owns everything from here onward (recipient
-- resolution, template rendering, provider send, retry/reconciliation).
create table transactional_notification_intents (
  notification_id uuid primary key,
  parent_id uuid not null references profiles(id) on delete cascade,
  notification_type text not null,
  source_domain text not null,
  source_event_key text not null,
  source_version integer not null,
  template_version text not null,
  safe_variables jsonb not null,
  semantic_hash text not null,
  state text not null default 'pending'
    check(state in ('pending','claimed','sent','blocked_recipient','failed','suppressed_by_policy')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_type,source_domain,source_event_key,parent_id,template_version)
);
create index idx_transactional_notification_intents_claim
  on transactional_notification_intents(state,next_attempt_at,created_at);
create index idx_transactional_notification_intents_source
  on transactional_notification_intents(source_domain,source_event_key);

-- One active delivery row per notification per channel (rule 58; V1 has
-- exactly one channel, email). provider_idempotency_key is the stable key
-- handed to the email provider so retries never double-send (rule 57).
create table transactional_notification_deliveries (
  id uuid primary key,
  notification_id uuid not null references transactional_notification_intents(notification_id) on delete cascade,
  channel text not null default 'email' check(channel='email'),
  provider_message_id text,
  provider_idempotency_key text not null unique,
  state text not null default 'pending'
    check(state in ('pending','sending','accepted','delivered_when_known','temporary_failed','permanent_failed','blocked_recipient','suppressed_by_policy')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  last_error_code text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_id,channel)
);
create index idx_transactional_notification_deliveries_state
  on transactional_notification_deliveries(state,updated_at);

-- Replay guard for API-NT-003 provider webhooks, same shape as
-- deployment_webhook_receipts/financial_dispute_events.
create table notification_provider_webhook_receipts (
  id uuid primary key,
  provider text not null,
  provider_event_id text not null,
  received_at timestamptz not null default now(),
  unique(provider, provider_event_id)
);

alter table transactional_notification_intents enable row level security;
alter table transactional_notification_intents force row level security;
alter table transactional_notification_deliveries enable row level security;
alter table transactional_notification_deliveries force row level security;
alter table notification_provider_webhook_receipts enable row level security;
alter table notification_provider_webhook_receipts force row level security;
