-- PR-001: registered transforms and per-learner migration evidence are
-- append-only. A deployed migration can never be rewritten underneath an
-- existing release or learner receipt.
create or replace function reject_progress_migration_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'progress migration evidence is immutable';
end $$;

drop trigger if exists app_progress_schema_migrations_no_update on app_progress_schema_migrations;
create trigger app_progress_schema_migrations_no_update before update on app_progress_schema_migrations
for each row execute function reject_progress_migration_mutation();
drop trigger if exists app_progress_schema_migrations_no_delete on app_progress_schema_migrations;
create trigger app_progress_schema_migrations_no_delete before delete on app_progress_schema_migrations
for each row execute function reject_progress_migration_mutation();
drop trigger if exists learner_progress_migration_receipts_no_update on learner_progress_migration_receipts;
create trigger learner_progress_migration_receipts_no_update before update on learner_progress_migration_receipts
for each row execute function reject_progress_migration_mutation();
drop trigger if exists learner_progress_migration_receipts_no_delete on learner_progress_migration_receipts;
create trigger learner_progress_migration_receipts_no_delete before delete on learner_progress_migration_receipts
for each row execute function reject_progress_migration_mutation();
