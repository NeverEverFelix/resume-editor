create or replace function public.set_user_plan(p_user_id uuid, p_plan text)
returns public.billing_usage
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_plan text;
  next_limit integer;
  result_row public.billing_usage%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  normalized_plan := lower(trim(coalesce(p_plan, '')));
  if normalized_plan not in ('free', 'pro') then
    raise exception 'Unsupported plan: %', p_plan;
  end if;

  next_limit := case when normalized_plan = 'pro' then null else 5 end;

  insert into public.billing_usage (user_id, plan, analyses_limit)
  values (p_user_id, normalized_plan, next_limit)
  on conflict (user_id) do update
    set
      plan = excluded.plan,
      analyses_limit = excluded.analyses_limit,
      updated_at = now()
  returning * into result_row;

  return result_row;
end;
$$;
revoke all on function public.set_user_plan(uuid, text) from public;
grant execute on function public.set_user_plan(uuid, text) to service_role;
do $$
declare
  target_user_id constant uuid := '67c44f57-f07f-4075-a076-d429673ae189';
begin
  if exists (
    select 1
    from auth.users
    where id = target_user_id
  ) then
    perform public.set_user_plan(target_user_id, 'pro');
  end if;
end
$$;
