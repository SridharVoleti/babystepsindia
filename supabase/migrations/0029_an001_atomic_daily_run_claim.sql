-- AN-001 AC10: exactly one scheduler worker may claim an activity date.
-- INSERT conflict handling serializes first creation; FOR UPDATE serializes
-- failed-run reclamation and ensures only one worker increments run_version.
create or replace function claim_analytics_daily_run(
  p_activity_date date,
  p_started_at timestamptz default now()
)
returns table(claimed boolean, run_row analytics_daily_runs)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run analytics_daily_runs;
begin
  insert into analytics_daily_runs(activity_date, status, run_version, started_at)
  values (p_activity_date, 'running', 1, p_started_at)
  on conflict (activity_date) do nothing;

  if found then
    select * into v_run
      from analytics_daily_runs
      where activity_date = p_activity_date;
    return query select true, v_run;
    return;
  end if;

  select * into v_run
    from analytics_daily_runs
    where activity_date = p_activity_date
    for update;

  if v_run.status = 'failed' then
    update analytics_daily_runs
      set status = 'running',
          run_version = run_version + 1,
          started_at = p_started_at,
          completed_at = null,
          failure_code = null
      where activity_date = p_activity_date
        and status = 'failed'
      returning * into v_run;
    return query select true, v_run;
  else
    return query select false, v_run;
  end if;
end;
$$;

revoke all on function claim_analytics_daily_run(date, timestamptz) from public, anon, authenticated;
grant execute on function claim_analytics_daily_run(date, timestamptz) to service_role;

-- Down migration (apply manually to reverse; existing run/aggregate rows remain intact):
-- drop function if exists claim_analytics_daily_run(date, timestamptz);
