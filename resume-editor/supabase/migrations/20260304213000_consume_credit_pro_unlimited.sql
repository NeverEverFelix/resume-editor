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
    analyses_limit = case when bu.plan = 'pro' then null else bu.analyses_limit end,
    updated_at = now()
  where bu.user_id = p_user_id
    and (bu.plan = 'pro' or bu.analyses_limit is null or bu.analyses_used < bu.analyses_limit)
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
