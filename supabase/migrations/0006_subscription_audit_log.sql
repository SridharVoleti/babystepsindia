-- REQ-08 §7 — safety net for "webhook silently failed", since there is no
-- local double-verification in product apps.

create table subscription_audit_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions(id),
  changed_by text not null,        -- 'webhook' | 'admin:<email>' | 'system:cron'
  change_type text not null,       -- 'created' | 'status_change' | 'manual_override'
  old_status text,
  new_status text,
  note text,
  created_at timestamptz not null default now()
);

alter table subscription_audit_log enable row level security;

-- No public policies: readable/writable only via service role (admin
-- dashboard, webhook handler).
