-- PC-002 — Consent Management
-- Consent is platform/subscription scoped: one purchasing-parent acceptance
-- covers all approved Babysteps purposes. App, learner and session identifiers
-- are deliberately absent. Billing disclosure consent remains a separate BI-002
-- authority and cannot satisfy this table.

create table platform_privacy_consent_policy (
  singleton boolean primary key default true check (singleton),
  material_version text not null,
  notice_revision text not null,
  updated_at timestamptz not null default now()
);

insert into platform_privacy_consent_policy(singleton, material_version, notice_revision)
values (true, 'pc-002-m1', '2026-08-17.1')
on conflict (singleton) do nothing;

create table platform_privacy_consents (
  id uuid primary key,
  parent_id uuid not null references profiles(id),
  material_version text not null,
  notice_revision text not null,
  accepted_at timestamptz not null,
  unique(parent_id, material_version)
);

create index idx_platform_privacy_consents_parent_material
  on platform_privacy_consents(parent_id, material_version);

-- No browser/client policy is intentionally created. Consent evidence is
-- written/read through the authorized Babysteps server boundary only.
alter table platform_privacy_consent_policy enable row level security;
alter table platform_privacy_consents enable row level security;

create or replace function enforce_current_platform_privacy_consent_on_activation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  required_material_version text;
begin
  -- Existing paid access is not interrupted by a copy or policy deployment.
  -- A consent check applies when a subscription enters active state.
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    select material_version into required_material_version
      from platform_privacy_consent_policy where singleton = true;

    if required_material_version is null or not exists (
      select 1 from platform_privacy_consents c
       where c.parent_id = new.purchaser_parent_id
         and c.material_version = required_material_version
    ) then
      raise exception using errcode = 'P0001', message = 'PLATFORM_PRIVACY_CONSENT_REQUIRED';
    end if;
  end if;
  return new;
end;
$$;

create trigger subscriptions_require_platform_privacy_consent
  before insert or update of status on subscriptions
  for each row execute function enforce_current_platform_privacy_consent_on_activation();
