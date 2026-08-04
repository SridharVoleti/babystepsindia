-- AR-001 — admin-managed canonical app registration and soft deletion.
-- Mirrors src/lib/db/schema.sql column for column.

create table app_registry (
  id uuid primary key default gen_random_uuid(),
  app_key text not null unique
    check (app_key ~ '^[a-z][a-z0-9-]{1,49}$'),
  display_name text not null
    check (char_length(display_name) between 1 and 80),
  short_description text
    check (short_description is null or char_length(short_description) between 1 and 240),
  icon_asset_key text,
  category text,
  owning_team text,
  internal_notes text,
  registry_status text not null default 'draft'
    check (registry_status in ('draft','active','soft_deleted')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  soft_deleted_at timestamptz,
  soft_delete_reason_code text
);

create index idx_app_registry_status on app_registry(registry_status);

alter table app_registry enable row level security;

-- Safe-metadata read policy: anyone (including anon/learning-app
-- credentials) may read active apps' non-sensitive columns. internal_notes
-- is excluded at the application/query layer (the safe read model never
-- selects it), not by RLS column masking — Postgres RLS is row-level only.
create policy "active apps are readable"
  on app_registry for select
  using (registry_status = 'active');

-- No insert/update/delete policy for anon/authenticated: all mutation
-- goes through the service-role-backed admin API, never client-side.

-- Admin-scoped idempotency for every registry mutation (create/edit/
-- activate/soft-delete/restore share one table, distinguished by
-- `operation`).
create table app_registry_mutation_requests (
  admin_user_id uuid not null,
  idempotency_key uuid not null,
  operation text not null
    check (operation in ('create','edit','activate','soft_delete','restore')),
  app_id uuid references app_registry(id),
  request_hash text not null,
  result_app_id uuid,
  result_version integer,
  status text not null check (status in ('processing','completed','failed')),
  safe_response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (admin_user_id, idempotency_key)
);

alter table app_registry_mutation_requests enable row level security;

-- Minimal local stand-in for the "approved platform asset registry"
-- AR-001 assumes exists (business rule 8).
create table approved_app_icons (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table approved_app_icons enable row level security;

create policy "approved app icons are readable"
  on approved_app_icons for select
  using (true);

-- Minimal, queryable audit trail (business rule 32 / AC25/AC30): IDs,
-- key, operation, admin, reason code, version transition, timestamp
-- only — never a full metadata snapshot.
create table app_registry_audit_log (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null,
  app_key text not null,
  operation text not null,
  admin_user_id uuid not null,
  reason_code text,
  version_from integer,
  version_to integer,
  created_at timestamptz not null default now()
);

create index idx_app_registry_audit_log_app on app_registry_audit_log(app_id);

alter table app_registry_audit_log enable row level security;

-- Granular admin permissions layered on top of the existing coarse
-- "is platform admin" flag.
create table admin_permissions (
  user_id uuid not null references auth.users(id) on delete cascade,
  permission text not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

alter table admin_permissions enable row level security;

-- Down migration (apply manually to reverse):
--
-- drop table if exists admin_permissions;
-- drop table if exists app_registry_audit_log;
-- drop table if exists approved_app_icons;
-- drop table if exists app_registry_mutation_requests;
-- drop table if exists app_registry;
