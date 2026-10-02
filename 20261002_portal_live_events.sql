begin;

-- Stable server-side read path for today's immutable punch events.
-- Employees can read only their own events. Active managers can read all.
create or replace function public.hola_portal_today_events_v1()
returns table (
  id uuid,
  employee_id uuid,
  store_id uuid,
  event_type text,
  source text,
  occurred_at timestamptz,
  metadata jsonb,
  store_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_day date := (now() at time zone 'Europe/Madrid')::date;
  v_start timestamptz := v_day::timestamp at time zone 'Europe/Madrid';
  v_end timestamptz := (v_day + 1)::timestamp at time zone 'Europe/Madrid';
begin
  select p.role::text into v_role
  from public.profiles p
  where p.user_id = auth.uid() and p.active = true;

  if auth.uid() is null or v_role not in ('manager', 'employee') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return query
  select
    e.id,
    e.employee_id,
    e.store_id,
    e.event_type::text,
    e.source::text,
    e.occurred_at,
    coalesce(e.metadata, '{}'::jsonb),
    s.name
  from public.attendance_events e
  left join public.stores s on s.id = e.store_id
  where e.occurred_at >= v_start
    and e.occurred_at < v_end
    and (v_role = 'manager' or e.employee_id = auth.uid())
  order by e.occurred_at;
end;
$$;

-- Keep the RPC signature stable if the migration is run again after a schema refresh.

revoke all on function public.hola_portal_today_events_v1() from public;
grant execute on function public.hola_portal_today_events_v1() to authenticated;

comment on function public.hola_portal_today_events_v1() is
  'Today Europe/Madrid punches: own events for employees, all events for active managers.';

commit;
