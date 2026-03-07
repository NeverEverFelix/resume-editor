do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'billing_event_type'
  ) then
    create type public.billing_event_type as enum (
      'free_decrement',
      'credit_decrement',
      'grant_credits',
      'subscription_activated',
      'subscription_trialing',
      'subscription_past_due',
      'subscription_canceled'
    );
  end if;
end
$$;
create table if not exists public.billing_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type public.billing_event_type not null,
  run_id uuid references public.analysis_runs(run_id) on delete set null,
  stripe_event_id text unique,
  delta integer not null,
  created_at timestamp with time zone not null default now()
);
create index if not exists billing_events_user_created_at_idx
  on public.billing_events (user_id, created_at desc);
alter table public.billing_events enable row level security;
drop policy if exists "billing_events_select_own" on public.billing_events;
create policy "billing_events_select_own"
  on public.billing_events
  for select
  to authenticated
  using (auth.uid() = user_id);
grant select on table public.billing_events to authenticated;
grant all on table public.billing_events to service_role;
