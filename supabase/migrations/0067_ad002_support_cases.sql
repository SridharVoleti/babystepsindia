-- AD-002: case-first support workflow. AD-002 owns none of the underlying
-- customer data (rule 34) — parent/learner/billing/progress/notification
-- fields are composed live from their owning domains at read time; this
-- table only ever stores the case's own identity, binding, workflow state
-- and optional exact references.
create table if not exists support_cases (
  id text primary key,
  category text not null check(category in
    ('account_access','learner_access','billing_question','subscription_assignment','payment_refund',
     'app_access','progress_display','technical_issue','notification_delivery','other')),
  status text not null default 'open'
    check(status in ('open','in_progress','waiting_parent','escalated','resolved','closed')),
  priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
  parent_id uuid not null references auth.users(id),
  learner_id text,
  app_id text,
  subscription_id text,
  invoice_id text,
  source_ref text,
  created_from_receipt_id text not null,
  assigned_staff_account_id uuid references staff_accounts(id),
  escalation_role text check(escalation_role in
    ('billing_administrator','operations_administrator','platform_administrator') or escalation_role is null),
  version integer not null default 1,
  reopened_count integer not null default 0,
  created_by_staff_account_id uuid not null references staff_accounts(id),
  created_at text not null,
  updated_at text not null,
  closed_at text
);
create index if not exists idx_support_cases_status on support_cases(status, updated_at);
create index if not exists idx_support_cases_assigned on support_cases(assigned_staff_account_id, status);
create index if not exists idx_support_cases_parent on support_cases(parent_id, created_at desc);
alter table support_cases enable row level security;
alter table support_cases force row level security;

create table if not exists support_case_notes (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  staff_account_id uuid not null references staff_accounts(id),
  note_text text not null,
  idempotency_key text not null,
  created_at text not null,
  unique(case_id, staff_account_id, idempotency_key)
);
create index if not exists idx_support_case_notes_case on support_case_notes(case_id, created_at);
alter table support_case_notes enable row level security;
alter table support_case_notes force row level security;

create table if not exists support_case_activity (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  actor_staff_account_id uuid not null references staff_accounts(id),
  canonical_action text not null,
  underlying_role text,
  resource_safe_id text,
  result text not null,
  request_id text,
  created_at text not null
);
create index if not exists idx_support_case_activity_case on support_case_activity(case_id, created_at);
alter table support_case_activity enable row level security;
alter table support_case_activity force row level security;

create table if not exists support_lookup_receipts (
  id text primary key,
  staff_account_id uuid not null references staff_accounts(id),
  identifier_type text not null check(identifier_type in ('email','subscription_ref','invoice_ref','case_id')),
  identifier_hash text not null,
  result_class text not null check(result_class in ('matched','no_match','duplicate_match')),
  resolved_parent_id uuid references auth.users(id),
  resolved_learner_id text,
  resolved_app_id text,
  resolved_subscription_id text,
  resolved_invoice_id text,
  reason text not null,
  consumed_at text,
  created_at text not null,
  expires_at text not null
);
create index if not exists idx_support_lookup_receipts_staff on support_lookup_receipts(staff_account_id, created_at);
alter table support_lookup_receipts enable row level security;
alter table support_lookup_receipts force row level security;

create table if not exists support_case_mutation_requests (
  actor_staff_account_id uuid not null references staff_accounts(id),
  idempotency_key text not null,
  case_id text not null,
  operation text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  created_at text not null,
  completed_at text,
  primary key (actor_staff_account_id, case_id, idempotency_key)
);
alter table support_case_mutation_requests enable row level security;
alter table support_case_mutation_requests force row level security;
