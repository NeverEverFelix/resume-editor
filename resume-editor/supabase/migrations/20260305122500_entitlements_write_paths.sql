create or replace function public.set_entitlement_subscription(
  p_user_id uuid,
  p_subscription_status public.subscription_status,
  p_subscription_current_period_end timestamp with time zone default null,
  p_plan text default null,
  p_stripe_event_id text default null
)
returns public.entitlements
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_plan text;
  normalized_event_id text;
  event_type public.billing_event_type;
  result_row public.entitlements%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  normalized_event_id := nullif(trim(coalesce(p_stripe_event_id, '')), '');
  if normalized_event_id is not null and exists (
    select 1
    from public.billing_events
    where stripe_event_id = normalized_event_id
  ) then
    select * into result_row
    from public.entitlements
    where user_id = p_user_id;

    if not found then
      insert into public.entitlements (user_id)
      values (p_user_id)
      on conflict (user_id) do nothing;

      select * into result_row
      from public.entitlements
      where user_id = p_user_id;
    end if;

    return result_row;
  end if;

  normalized_plan := nullif(lower(trim(coalesce(p_plan, ''))), '');
  if normalized_plan is not null and normalized_plan not in ('free', 'pro') then
    raise exception 'Unsupported plan: %', p_plan;
  end if;

  insert into public.entitlements (
    user_id,
    subscription_status,
    subscription_current_period_end,
    plan,
    updated_at
  )
  values (
    p_user_id,
    p_subscription_status,
    p_subscription_current_period_end,
    coalesce(
      normalized_plan,
      case
        when p_subscription_status in (
          'active'::public.subscription_status,
          'trialing'::public.subscription_status,
          'past_due'::public.subscription_status
        ) then 'pro'
        else 'free'
      end
    ),
    now()
  )
  on conflict (user_id) do update
    set
      subscription_status = excluded.subscription_status,
      subscription_current_period_end = excluded.subscription_current_period_end,
      plan = coalesce(normalized_plan, public.entitlements.plan),
      updated_at = now()
  returning * into result_row;

  event_type := case p_subscription_status
    when 'active' then 'subscription_activated'::public.billing_event_type
    when 'trialing' then 'subscription_trialing'::public.billing_event_type
    when 'past_due' then 'subscription_past_due'::public.billing_event_type
    when 'canceled' then 'subscription_canceled'::public.billing_event_type
    else null
  end;

  if event_type is not null then
    insert into public.billing_events (user_id, type, delta, stripe_event_id)
    values (p_user_id, event_type, 0, normalized_event_id)
    on conflict (stripe_event_id) do nothing;
  end if;

  return result_row;
end;
$$;
revoke all on function public.set_entitlement_subscription(uuid, public.subscription_status, timestamp with time zone, text, text) from public;
grant execute on function public.set_entitlement_subscription(uuid, public.subscription_status, timestamp with time zone, text, text) to service_role;
create or replace function public.adjust_entitlement_credits(
  p_user_id uuid,
  p_delta integer,
  p_run_id uuid default null,
  p_stripe_event_id text default null
)
returns public.entitlements
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_event_id text;
  event_type public.billing_event_type;
  result_row public.entitlements%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  if p_delta = 0 then
    raise exception 'p_delta must not be 0';
  end if;

  normalized_event_id := nullif(trim(coalesce(p_stripe_event_id, '')), '');
  if normalized_event_id is not null and exists (
    select 1
    from public.billing_events
    where stripe_event_id = normalized_event_id
  ) then
    select * into result_row
    from public.entitlements
    where user_id = p_user_id;

    if not found then
      insert into public.entitlements (user_id)
      values (p_user_id)
      on conflict (user_id) do nothing;

      select * into result_row
      from public.entitlements
      where user_id = p_user_id;
    end if;

    return result_row;
  end if;

  insert into public.entitlements (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  update public.entitlements e
  set
    credits_balance = e.credits_balance + p_delta,
    updated_at = now()
  where e.user_id = p_user_id
    and e.credits_balance + p_delta >= 0
  returning * into result_row;

  if not found then
    raise exception 'Insufficient credits for user_id=%', p_user_id;
  end if;

  event_type := case
    when p_delta > 0 then 'grant_credits'::public.billing_event_type
    else 'credit_decrement'::public.billing_event_type
  end;

  insert into public.billing_events (user_id, type, run_id, delta, stripe_event_id)
  values (p_user_id, event_type, p_run_id, p_delta, normalized_event_id)
  on conflict (stripe_event_id) do nothing;

  return result_row;
end;
$$;
revoke all on function public.adjust_entitlement_credits(uuid, integer, uuid, text) from public;
grant execute on function public.adjust_entitlement_credits(uuid, integer, uuid, text) to service_role;
