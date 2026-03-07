create or replace function public.sync_auth_plan_metadata(p_user_id uuid, p_plan text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  normalized_plan text;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  normalized_plan := lower(trim(coalesce(p_plan, '')));
  if normalized_plan not in ('free', 'pro') then
    raise exception 'Unsupported plan: %', p_plan;
  end if;

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('plan', normalized_plan)
  where id = p_user_id;
end;
$$;
revoke all on function public.sync_auth_plan_metadata(uuid, text) from public;
grant execute on function public.sync_auth_plan_metadata(uuid, text) to service_role;
create or replace function public.sync_auth_plan_metadata_from_billing_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_auth_plan_metadata(new.user_id, new.plan);
  return new;
end;
$$;
drop trigger if exists trg_billing_usage_sync_auth_plan_metadata on public.billing_usage;
create trigger trg_billing_usage_sync_auth_plan_metadata
after insert or update of plan on public.billing_usage
for each row execute function public.sync_auth_plan_metadata_from_billing_usage();
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

  perform public.sync_auth_plan_metadata(p_user_id, normalized_plan);

  return result_row;
end;
$$;
revoke all on function public.set_user_plan(uuid, text) from public;
grant execute on function public.set_user_plan(uuid, text) to service_role;
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    email,
    full_name,
    job_role
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'job_role'
  )
  on conflict (id) do nothing;

  insert into public.billing_usage (user_id, plan, analyses_limit)
  values (new.id, 'free', 5)
  on conflict (user_id) do nothing;

  perform public.sync_auth_plan_metadata(new.id, 'free');

  return new;
end;
$$;
insert into public.billing_usage (user_id, plan, analyses_limit)
select u.id, 'free', 5
from auth.users u
left join public.billing_usage bu on bu.user_id = u.id
where bu.user_id is null;
update auth.users u
set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('plan', bu.plan)
from public.billing_usage bu
where bu.user_id = u.id;
