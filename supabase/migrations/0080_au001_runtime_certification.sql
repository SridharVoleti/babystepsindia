-- AU-001 production certification: legacy public tables discovered in the
-- staging catalog must also enforce RLS for table-owner execution. They have
-- no browser policies and remain fail-closed.
do $$
declare table_name text;
begin
  foreach table_name in array array['app_progress','app_sessions','auth_tokens','bookings','students','usage_sessions']
  loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('alter table public.%I force row level security', table_name);
    end if;
  end loop;
end $$;
