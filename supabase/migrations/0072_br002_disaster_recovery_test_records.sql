-- BR-002: production-side compliance evidence ledger for the ~6-monthly
-- disaster-recovery drill. Never a live restore orchestrator — the drill
-- itself runs against a disposable temp project this app never connects
-- to; this table only records backup chosen/results/teardown.
create table if not exists disaster_recovery_test_records (
  id text primary key,
  initiated_by_staff_account_id uuid not null references staff_accounts(id),
  backup_reference text not null,
  temp_project_reference text not null,
  started_at text not null,
  outbound_processing_suppressed integer not null default 0 check(outbound_processing_suppressed in (0,1)),
  deletion_replay_confirmed integer not null default 0 check(deletion_replay_confirmed in (0,1)),
  deletion_replay_notes text,
  billing_reconciliation_confirmed integer not null default 0 check(billing_reconciliation_confirmed in (0,1)),
  billing_reconciliation_notes text,
  derivable_state_rebuild_confirmed integer not null default 0 check(derivable_state_rebuild_confirmed in (0,1)),
  derivable_state_rebuild_notes text,
  critical_flows_validated integer not null default 0 check(critical_flows_validated in (0,1)),
  critical_flows_notes text,
  completed_at text,
  teardown_confirmed_at text,
  updated_at text not null default (now()::text)
);
create index if not exists idx_disaster_recovery_test_records_started
  on disaster_recovery_test_records(started_at desc);
alter table disaster_recovery_test_records enable row level security;
alter table disaster_recovery_test_records force row level security;
