begin;

-- Raw punches and payroll corrections are permanent, append-only evidence.
create or replace function public.prevent_attendance_history_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'ATTENDANCE_HISTORY_IS_APPEND_ONLY'
    using errcode = '55000',
          detail = 'Raw punches and payroll corrections cannot be updated or deleted. Add a new correction revision instead.';
end;
$$;

revoke all on function public.prevent_attendance_history_change() from public;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'protect_attendance_events_history'
      and tgrelid = 'public.attendance_events'::regclass
  ) then
    create trigger protect_attendance_events_history
    before update or delete on public.attendance_events
    for each row execute function public.prevent_attendance_history_change();
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'protect_attendance_corrections_history'
      and tgrelid = 'public.attendance_corrections'::regclass
  ) then
    create trigger protect_attendance_corrections_history
    before update or delete on public.attendance_corrections
    for each row execute function public.prevent_attendance_history_change();
  end if;
end;
$$;

create or replace view public.attendance_daily as
with event_rollup as (
  select
    e.employee_id,
    (e.occurred_at at time zone 'Europe/Madrid')::date as work_date,
    min(e.occurred_at) filter (where e.event_type = 'clock_in'::public.attendance_event_type) as clock_in,
    min(e.occurred_at) filter (where e.event_type = 'break_start'::public.attendance_event_type) as break_start,
    max(e.occurred_at) filter (where e.event_type = 'break_end'::public.attendance_event_type) as break_end,
    max(e.occurred_at) filter (where e.event_type = 'clock_out'::public.attendance_event_type) as clock_out,
    (array_agg(e.store_id order by e.occurred_at))[1] as store_id,
    count(*)::integer as raw_event_count
  from public.attendance_events e
  group by e.employee_id, (e.occurred_at at time zone 'Europe/Madrid')::date
),
latest_correction as (
  select distinct on (c.employee_id, c.work_date)
    c.id,
    c.employee_id,
    c.work_date,
    c.corrected_clock_in,
    c.corrected_break_start,
    c.corrected_break_end,
    c.corrected_clock_out,
    c.reason,
    c.correction_kind,
    c.revision_no,
    c.supersedes_correction_id,
    c.corrected_by,
    c.created_at
  from public.attendance_corrections c
  order by c.employee_id, c.work_date, c.created_at desc, c.id desc
),
attendance_days as (
  select r.employee_id, r.work_date from event_rollup r
  union
  select c.employee_id, c.work_date
  from latest_correction c
  where c.correction_kind <> 'void'
)
select
  d.employee_id,
  p.employee_no,
  p.full_name as employee_name,
  d.work_date,
  coalesce(r.store_id, sh.store_id, p.home_store_id) as store_id,
  st.name as store_name,
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_clock_in, r.clock_in) end as clock_in,
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_break_start, r.break_start) end as break_start,
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_break_end, r.break_end) end as break_end,
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_clock_out, r.clock_out) end as clock_out,
  c.employee_id is not null and c.correction_kind <> 'void' as corrected,
  c.reason as correction_reason,
  c.correction_kind,
  c.id as correction_id,
  c.revision_no as correction_revision,
  c.supersedes_correction_id,
  c.corrected_by,
  c.created_at as correction_created_at,

  -- Immutable employee punch evidence.
  r.clock_in as actual_clock_in,
  r.break_start as actual_break_start,
  r.break_end as actual_break_end,
  r.clock_out as actual_clock_out,
  r.store_id as actual_store_id,
  coalesce(r.raw_event_count, 0) as actual_event_count,

  -- Verified values used for payroll. Existing clock_* columns remain aliases
  -- for backwards compatibility with older clients.
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_clock_in, r.clock_in) end as payroll_clock_in,
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_break_start, r.break_start) end as payroll_break_start,
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_break_end, r.break_end) end as payroll_break_end,
  case when c.correction_kind = 'absence' then null else coalesce(c.corrected_clock_out, r.clock_out) end as payroll_clock_out,
  case
    when c.correction_kind = 'absence' then 'verified_absence'
    when c.employee_id is not null and c.correction_kind <> 'void' then 'verified_correction'
    else 'actual_punches'
  end as payroll_source
from attendance_days d
join public.profiles p on p.user_id = d.employee_id
left join event_rollup r using (employee_id, work_date)
left join latest_correction c using (employee_id, work_date)
left join public.schedules sh using (employee_id, work_date)
left join public.stores st on st.id = coalesce(r.store_id, sh.store_id, p.home_store_id);

comment on table public.attendance_events is
  'Immutable actual punch events created by employees. Never contains payroll edits.';
comment on table public.attendance_corrections is
  'Append-only verified payroll revisions. A new revision supersedes the prior revision; raw punches remain unchanged.';
comment on view public.attendance_daily is
  'Daily attendance with two independent datasets: actual_* immutable punches and payroll_* verified payroll values.';

commit;
