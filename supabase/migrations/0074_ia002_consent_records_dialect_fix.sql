-- Fixes two pre-existing bugs in consent_records, both dating back to
-- 0009_ia002_parent_phone_consent.sql (not introduced by this migration):
--
-- 1. `granted` was declared `boolean`, but every query against it
--    (src/lib/db/consent.ts) uses the literal integer 1/0 baked directly
--    into the SQL text (e.g. `values (?, ?, ?, ?, 1, ?)`,
--    `where consent_records.granted = 0`), matching the SQLite/
--    schema.sql convention of `granted integer`. Postgres rejects an
--    integer literal against a boolean column
--    ('column "granted" is of type boolean but expression is of type
--    integer'), which is what broke production signup.
--
-- 2. The consent_type check constraint never included
--    'processing_envelope' (added later in schema.sql for PC-002), so
--    recordProcessingEnvelopeConsent — called right after every signup —
--    would have failed the check constraint immediately after fix #1.
--
-- Already applied to production (see the git history of this file) —
-- `granted` genuinely never held anything but 0/1 in practice, confirmed
-- via introspection before this migration was written, so the type
-- narrowing carries no real data-loss risk.
-- BR-003: reviewed-breaking-change

begin;

alter table consent_records
  alter column granted drop default;
alter table consent_records
  alter column granted type integer using (case when granted then 1 else 0 end);
alter table consent_records
  alter column granted set default 1;

alter table consent_records
  drop constraint if exists consent_records_consent_type_check;
alter table consent_records
  add constraint consent_records_consent_type_check
  check (consent_type in ('terms_of_service', 'privacy_policy', 'processing_envelope'));

commit;

-- Down migration (apply manually to reverse):
--
-- begin;
-- alter table consent_records drop constraint if exists consent_records_consent_type_check;
-- alter table consent_records add constraint consent_records_consent_type_check
--   check (consent_type in ('terms_of_service', 'privacy_policy'));
-- alter table consent_records alter column granted drop default;
-- alter table consent_records alter column granted type boolean using (granted <> 0);
-- alter table consent_records alter column granted set default true;
-- commit;
