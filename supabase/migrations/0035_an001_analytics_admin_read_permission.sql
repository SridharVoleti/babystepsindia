-- AN-001: separate cohort-analytics reads from run retry authority.
-- Existing retry operators keep read access; future grants may assign
-- analytics_read independently without granting mutation authority.
insert into admin_permissions (user_id, permission)
select user_id, 'analytics_read'
from admin_permissions
where permission = 'analytics_run_retry'
on conflict (user_id, permission) do nothing;

-- Down migration (apply manually to reverse):
-- delete from admin_permissions where permission = 'analytics_read';
