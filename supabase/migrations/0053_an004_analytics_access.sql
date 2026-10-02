-- AN-004 — Analytics Access & Reporting
-- Analytics remains aggregate, read-only and non-authoritative. This schema
-- grants explicit scoped reporting authority; it never grants access to raw
-- learner/event source tables.

create table if not exists public.analytics_access_grants (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null,
  role_key text not null check (role_key in ('super_admin','analytics_viewer')),
  app_id uuid null references public.app_registry(id),
  level_key text null,
  age_band text null,
  can_export boolean not null default false,
  active boolean not null default true,
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz null
);

create index if not exists analytics_access_grants_active_idx
  on public.analytics_access_grants(admin_user_id, active);

alter table public.analytics_access_grants enable row level security;

comment on table public.analytics_access_grants is
  'AN-004 explicit least-privilege aggregate analytics grants. NULL scope dimensions mean all approved values for that dimension; no learner identity/raw-data authority is represented here.';

-- Cohort suppression is a platform invariant, not a caller preference.
create or replace function public.an004_cohort_is_reportable(active_learners integer)
returns boolean
language sql
immutable
as $$ select active_learners >= 5 $$;

revoke all on function public.an004_cohort_is_reportable(integer) from public;
