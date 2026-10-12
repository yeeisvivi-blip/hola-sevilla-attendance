begin;

alter table public.profiles
  add column if not exists email text,
  add column if not exists address text;

comment on column public.profiles.email is 'Employee contact email; it is not the synthetic Supabase Auth login email.';
comment on column public.profiles.address is 'Employee postal address supplied by the employee.';

create or replace function public.update_my_profile(
  p_nif text,
  p_email text,
  p_phone text,
  p_address text
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_digits text;
  v_phone text;
begin
  if v_user_id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = v_user_id and role = 'employee' and active = true
  ) then
    raise exception 'EMPLOYEE_NOT_ACTIVE' using errcode = '42501';
  end if;

  if trim(coalesce(p_phone, '')) <> '' then
    v_digits := regexp_replace(p_phone, '[^0-9]', '', 'g');
    if left(v_digits, 2) = '00' then v_digits := substring(v_digits from 3); end if;
    if length(v_digits) = 9 then v_digits := '34' || v_digits; end if;
    if length(v_digits) < 9 or length(v_digits) > 15 then
      raise exception 'INVALID_PHONE' using errcode = '22023';
    end if;
    v_phone := '+' || v_digits;
  end if;

  if trim(coalesce(p_nif, '')) <> '' and (length(trim(p_nif)) < 3 or length(trim(p_nif)) > 20) then
    raise exception 'INVALID_NIF' using errcode = '22023';
  end if;
  if trim(coalesce(p_email, '')) <> '' and (
     trim(p_email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or length(trim(p_email)) > 254) then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;
  if trim(coalesce(p_address, '')) <> '' and (length(trim(p_address)) < 5 or length(trim(p_address)) > 300) then
    raise exception 'INVALID_ADDRESS' using errcode = '22023';
  end if;

  update public.profiles
  set nif = nullif(upper(trim(p_nif)), ''),
      email = nullif(lower(trim(p_email)), ''),
      phone = coalesce(v_phone, phone),
      address = nullif(trim(p_address), '')
  where user_id = v_user_id;

  if v_phone is not null then
    update auth.users
    set email = 'p' || v_digits || '@attendance.invalid',
        updated_at = now()
    where id = v_user_id;
  end if;
end;
$$;

revoke all on function public.update_my_profile(text, text, text, text) from public;
grant execute on function public.update_my_profile(text, text, text, text) to authenticated;

create or replace function public.manager_update_employee_profile(
  p_employee_id uuid,
  p_full_name text,
  p_employee_no text,
  p_nif text,
  p_email text,
  p_phone text,
  p_address text,
  p_home_store_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_manager_id uuid := auth.uid();
  v_digits text;
  v_phone text;
begin
  if v_manager_id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = v_manager_id and role = 'manager' and active = true
  ) then
    raise exception 'MANAGER_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where user_id = p_employee_id and role = 'employee'
  ) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.stores
    where id = p_home_store_id and coalesce(active, true) = true
  ) then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if trim(coalesce(p_phone, '')) <> '' then
    v_digits := regexp_replace(p_phone, '[^0-9]', '', 'g');
    if left(v_digits, 2) = '00' then v_digits := substring(v_digits from 3); end if;
    if length(v_digits) = 9 then v_digits := '34' || v_digits; end if;
    if length(v_digits) < 9 or length(v_digits) > 15 then
      raise exception 'INVALID_PHONE' using errcode = '22023';
    end if;
    v_phone := '+' || v_digits;
  end if;

  if length(trim(coalesce(p_full_name, ''))) < 2 or length(trim(p_full_name)) > 120 then
    raise exception 'INVALID_NAME' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_employee_no, ''))) < 1 or length(trim(p_employee_no)) > 40 then
    raise exception 'INVALID_EMPLOYEE_NO' using errcode = '22023';
  end if;
  if trim(coalesce(p_nif, '')) <> '' and (length(trim(p_nif)) < 3 or length(trim(p_nif)) > 20) then
    raise exception 'INVALID_NIF' using errcode = '22023';
  end if;
  if trim(coalesce(p_email, '')) <> '' and (
     trim(p_email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or length(trim(p_email)) > 254) then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;
  if trim(coalesce(p_address, '')) <> '' and (length(trim(p_address)) < 5 or length(trim(p_address)) > 300) then
    raise exception 'INVALID_ADDRESS' using errcode = '22023';
  end if;

  update public.profiles
  set full_name = trim(p_full_name),
      employee_no = trim(p_employee_no),
      nif = nullif(upper(trim(p_nif)), ''),
      email = nullif(lower(trim(p_email)), ''),
      phone = coalesce(v_phone, phone),
      address = nullif(trim(p_address), ''),
      home_store_id = p_home_store_id
  where user_id = p_employee_id and role = 'employee';

  if v_phone is not null then
    update auth.users
    set email = 'p' || v_digits || '@attendance.invalid',
        updated_at = now()
    where id = p_employee_id;
  end if;
end;
$$;

revoke all on function public.manager_update_employee_profile(uuid, text, text, text, text, text, text, uuid) from public;
grant execute on function public.manager_update_employee_profile(uuid, text, text, text, text, text, text, uuid) to authenticated;

commit;
