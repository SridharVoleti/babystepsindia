-- PRG-029/PRG-043: 0014 created a table-level check allowing only source 'normal' and 'replacement'. 0023 widened the column-level source check
-- to 'technical_credit' and 'standard_monthly' but left this one, so on a fresh PostgreSQL no standard-monthly or technical-credit session
-- could ever be inserted (violates check constraint "learner_sessions_check"). Recreate it covering all four sources with their intended shape:
-- only normal sessions carry a weekly slot; replacement sessions carry the replacement credit; standard sessions carry their credit batch.
-- BR-003: reviewed-breaking-change
begin;
alter table learner_sessions drop constraint if exists learner_sessions_check;
alter table learner_sessions add constraint learner_sessions_check check (
  (source='normal' and weekly_slot_number is not null and replacement_credit_id is null)
  or (source='replacement' and weekly_slot_number is null and replacement_credit_id is not null)
  or (source='technical_credit' and weekly_slot_number is null)
  or (source='standard_monthly' and weekly_slot_number is null and standard_credit_batch_id is not null)
);
commit;
