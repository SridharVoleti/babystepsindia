-- PRG-038: deterministic learner/app activation locking. Rows are upserted in sorted order inside the activation transaction, so on
-- Postgres the row write lock serialises activations for the same learner x app x environment until commit.
create table if not exists entitlement_activation_locks (
  learner_id text not null,
  app_id text not null,
  environment text not null,
  lock_seq integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id, environment)
);
alter table entitlement_activation_locks enable row level security;
alter table entitlement_activation_locks force row level security;
