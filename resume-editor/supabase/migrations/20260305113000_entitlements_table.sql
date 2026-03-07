do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'subscription_status'
  ) then
    create type public.subscription_status as enum ('none', 'active', 'trialing', 'past_due', 'canceled');
  end if;
end
$$;
create table if not exists public.entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  free_runs_remaining integer not null default 5,
  subscription_status public.subscription_status not null default 'none',
  subscription_current_period_end timestamp with time zone,
  credits_balance integer not null default 0,
  plan text not null default 'free',
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint entitlements_free_runs_remaining_nonnegative check (free_runs_remaining >= 0),
  constraint entitlements_credits_balance_nonnegative check (credits_balance >= 0),
  constraint entitlements_plan_valid check (plan in ('free', 'pro'))
);
alter table public.entitlements enable row level security;
drop policy if exists "entitlements_select_own" on public.entitlements;
create policy "entitlements_select_own"
  on public.entitlements
  for select
  to authenticated
  using (auth.uid() = user_id);
drop trigger if exists trg_entitlements_set_updated_at on public.entitlements;
create trigger trg_entitlements_set_updated_at
before update on public.entitlements
for each row execute function public.set_updated_at();
create or replace function public.sync_entitlements_from_billing_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_free_runs_remaining integer;
  next_subscription_status public.subscription_status;
begin
  next_free_runs_remaining := case
    when new.plan = 'free' then greatest(coalesce(new.analyses_limit, 5) - coalesce(new.analyses_used, 0), 0)
    else 0
  end;

  next_subscription_status := case
    when new.plan = 'pro' then 'active'::public.subscription_status
    else 'none'::public.subscription_status
  end;

  insert into public.entitlements (
    user_id,
    free_runs_remaining,
    subscription_status,
    plan,
    updated_at
  )
  values (
    new.user_id,
    next_free_runs_remaining,
    next_subscription_status,
    new.plan,
    now()
  )
  on conflict (user_id) do update
    set
      free_runs_remaining = excluded.free_runs_remaining,
      subscription_status = excluded.subscription_status,
      plan = excluded.plan,
      updated_at = now();

  return new;
end;
$$;
drop trigger if exists trg_billing_usage_sync_entitlements on public.billing_usage;
create trigger trg_billing_usage_sync_entitlements
after insert or update of plan, analyses_used, analyses_limit on public.billing_usage
for each row execute function public.sync_entitlements_from_billing_usage();
insert into public.entitlements (
  user_id,
  free_runs_remaining,
  subscription_status,
  plan
)
select
  u.id as user_id,
  case
    when coalesce(bu.plan, 'free') = 'free'
      then greatest(coalesce(bu.analyses_limit, 5) - coalesce(bu.analyses_used, 0), 0)
    else 0
  end as free_runs_remaining,
  case
    when coalesce(bu.plan, 'free') = 'pro' then 'active'::public.subscription_status
    else 'none'::public.subscription_status
  end as subscription_status,
  coalesce(bu.plan, 'free') as plan
from auth.users u
left join public.billing_usage bu on bu.user_id = u.id
on conflict (user_id) do nothing;
