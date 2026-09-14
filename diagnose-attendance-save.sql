-- HOLA SEVILLA: read-only inspection for failed schedule/correction saves.
-- Run in Supabase > SQL Editor and return all result rows.
-- Reads schema metadata only. Does not change records or constraints.
begin read only;

select 'column' as category, table_name as object_name, column_name as item,
       json_build_object('type', data_type, 'nullable', is_nullable, 'default', column_default)::text as definition
from information_schema.columns
where table_schema = 'public' and table_name in ('schedules', 'attendance_corrections')
union all
select 'constraint', c.relname, con.conname, pg_get_constraintdef(con.oid)
from pg_constraint con join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('schedules', 'attendance_corrections')
union all
select 'index', tablename, indexname, indexdef
from pg_indexes where schemaname = 'public' and tablename in ('schedules', 'attendance_corrections')
union all
select 'trigger', c.relname, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('schedules', 'attendance_corrections') and not t.tgisinternal
union all
select 'view', viewname, viewname, definition
from pg_views where schemaname = 'public' and
(definition ilike '%attendance_corrections%' or definition ilike '%schedules%')
order by category, object_name, item;

rollback;
