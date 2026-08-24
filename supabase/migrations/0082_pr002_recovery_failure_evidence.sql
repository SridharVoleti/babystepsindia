-- PR-002: retain safe metadata for every recovery failure class required
-- by production certification, without persisting the capsule payload.
alter table progress_recovery_incidents drop constraint if exists progress_recovery_incidents_category_check;
alter table progress_recovery_incidents add constraint progress_recovery_incidents_category_check check(category in
  ('stale','device_mismatch','expired','corrupted_capsule','schema_migration_required','integrity_blocked','incomplete_receipt'));

drop trigger if exists progress_recovery_receipts_no_update on progress_recovery_receipts;
create trigger progress_recovery_receipts_no_update before update on progress_recovery_receipts
for each row execute function reject_progress_migration_mutation();
drop trigger if exists progress_recovery_receipts_no_delete on progress_recovery_receipts;
create trigger progress_recovery_receipts_no_delete before delete on progress_recovery_receipts
for each row execute function reject_progress_migration_mutation();
