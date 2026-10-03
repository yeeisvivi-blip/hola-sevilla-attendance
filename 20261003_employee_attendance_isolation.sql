begin;

-- Execute the view with the signed-in user's permissions so source-table RLS
-- stays effective for employees while managers keep manager access.
alter view public.attendance_daily set (security_invoker = true);

comment on view public.attendance_daily is
  'Daily attendance. security_invoker keeps employees limited to their own RLS-visible records.';

commit;
