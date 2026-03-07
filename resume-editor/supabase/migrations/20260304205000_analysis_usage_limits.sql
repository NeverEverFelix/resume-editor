create table if not exists public.billing_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  analyses_used integer not null default 0,
  analyses_limit integer default 5,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint billing_usage_plan_valid check (plan in ('free', 'pro')),
  constraint billing_usage_analyses_used_nonnegative check (analyses_used >= 0),
  constraint billing_usage_analyses_limit_valid check (analyses_limit is null or analyses_limit > 0)
);
alter table public.billing_usage enable row level security;
drop policy if exists "billing_usage_select_own" on public.billing_usage;
create policy "billing_usage_select_own"
  on public.billing_usage
  for select
  to authenticated
  using (auth.uid() = user_id);
drop trigger if exists trg_billing_usage_set_updated_at on public.billing_usage;
create trigger trg_billing_usage_set_updated_at
before update on public.billing_usage
for each row execute function public.set_updated_at();
create or replace function public.consume_analysis_credit(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  usage_row public.billing_usage%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  insert into public.billing_usage (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  update public.billing_usage bu
  set
    analyses_used = bu.analyses_used + 1,
    updated_at = now()
  where bu.user_id = p_user_id
    and (bu.analyses_limit is null or bu.analyses_used < bu.analyses_limit)
  returning bu.* into usage_row;

  if found then
    return jsonb_build_object(
      'allowed', true,
      'plan', usage_row.plan,
      'analyses_used', usage_row.analyses_used,
      'analyses_limit', usage_row.analyses_limit
    );
  end if;

  select * into usage_row
  from public.billing_usage
  where user_id = p_user_id;

  return jsonb_build_object(
    'allowed', false,
    'plan', usage_row.plan,
    'analyses_used', usage_row.analyses_used,
    'analyses_limit', usage_row.analyses_limit
  );
end;
$$;
revoke all on function public.consume_analysis_credit(uuid) from public;
grant execute on function public.consume_analysis_credit(uuid) to service_role;
