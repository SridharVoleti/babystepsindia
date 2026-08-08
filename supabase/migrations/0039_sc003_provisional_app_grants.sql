-- GAP-048/089 (SC-003 amendment): a session-start grant must begin
-- provisional — scoped only to session.usable_launch — and be atomically
-- upgraded to 'active' with the full app-service scope set only once
-- confirmUsableLaunch succeeds. 0017 only allowed ('active','revoked',
-- 'expired'); this widens the check constraint to add 'provisional'.
alter table app_session_grants drop constraint app_session_grants_status_check;
alter table app_session_grants add constraint app_session_grants_status_check
  check (status in ('provisional','active','revoked','expired'));
