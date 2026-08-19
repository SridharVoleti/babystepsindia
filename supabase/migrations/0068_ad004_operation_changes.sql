-- AD-004: immutable human-operations change/audit spine. Never a second
-- AR-001/AR-002/UL-004/AU-004 state machine — scope/type/reason are frozen
-- at creation; only workflow fields (status/assignment/schedule) version.
create table if not exists platform_operation_changes (
  id text primary key,
  change_type text not null check(change_type in
    ('app_registry_change','release_promotion','manual_rollback','planned_maintenance',
     'emergency_availability_change','machine_principal_change','machine_credential_change')),
  status text not null default 'planned'
    check(status in ('planned','ready','executing','succeeded','failed','cancelled')),
  environment text not null,
  app_id text,
  primary_resource_type text,
  primary_resource_id text,
  reason text not null,
  scheduled_for text,
  linked_support_case_id text references support_cases(id),
  assigned_staff_account_id uuid references staff_accounts(id),
  source_reference text,
  version integer not null default 1,
  created_by_staff_account_id uuid not null references staff_accounts(id),
  created_at text not null,
  updated_at text not null,
  terminal_at text,
  retention_due_at text
);
create index if not exists idx_platform_operation_changes_status on platform_operation_changes(status, updated_at);
create index if not exists idx_platform_operation_changes_app on platform_operation_changes(app_id, environment);
alter table platform_operation_changes enable row level security;
alter table platform_operation_changes force row level security;

create table if not exists platform_operation_activity (
  id text primary key,
  operation_change_id text not null references platform_operation_changes(id) on delete cascade,
  staff_account_id uuid not null references staff_accounts(id),
  canonical_action text not null,
  underlying_role text,
  resource_safe_id text,
  result text not null,
  request_id text,
  created_at text not null
);
create index if not exists idx_platform_operation_activity_change on platform_operation_activity(operation_change_id, created_at);
alter table platform_operation_activity enable row level security;
alter table platform_operation_activity force row level security;
