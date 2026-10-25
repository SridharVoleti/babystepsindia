-- PRG-041: parent_notification_preferences.learning_reminder_email_enabled was declared boolean, but every query compares or writes it as the
-- integer 1/0 (SQLite convention shared with the rest of the codebase). PostgreSQL rejects 'COALESCE types boolean and integer cannot be matched',
-- so reminder evaluation could not run at all on Postgres. Same class of fix as 0074 and 0079: convert to integer.
-- BR-003: reviewed-breaking-change
begin;
alter table parent_notification_preferences alter column learning_reminder_email_enabled drop default;
alter table parent_notification_preferences
  alter column learning_reminder_email_enabled type integer using (case when learning_reminder_email_enabled then 1 else 0 end);
alter table parent_notification_preferences alter column learning_reminder_email_enabled set default 1;
commit;
