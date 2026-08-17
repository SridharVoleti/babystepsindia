-- BR-003: reviewed-breaking-change
-- IA-002 stores learner attributes on learners, never on the parent profile.
-- The baseline migration no longer creates these legacy columns; this
-- forward migration reconciles databases created from an older baseline.

alter table profiles
  drop column if exists date_of_birth,
  drop column if exists class_level;

-- Profile writes must pass through the server endpoint so E.164 validation,
-- consent recording, status transition and auditing remain one operation.
-- Service-role repository access bypasses RLS; browser clients retain only
-- the owner-select policy from the baseline migration.
drop policy if exists "profiles are updatable by owner" on profiles;

-- Down migration (apply manually to reverse):
-- alter table profiles add column date_of_birth date;
-- alter table profiles add column class_level text;
-- create policy "profiles are updatable by owner" on profiles for update using (auth.uid() = id);
