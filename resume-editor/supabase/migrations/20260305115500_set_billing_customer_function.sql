create or replace function public.set_billing_customer(p_user_id uuid, p_stripe_customer_id text)
returns public.billing_customers
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_customer_id text;
  result_row public.billing_customers%rowtype;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  normalized_customer_id := trim(coalesce(p_stripe_customer_id, ''));
  if normalized_customer_id = '' then
    raise exception 'p_stripe_customer_id is required';
  end if;

  insert into public.billing_customers (user_id, stripe_customer_id)
  values (p_user_id, normalized_customer_id)
  on conflict (user_id) do update
    set stripe_customer_id = excluded.stripe_customer_id
  returning * into result_row;

  return result_row;
end;
$$;
revoke all on function public.set_billing_customer(uuid, text) from public;
grant execute on function public.set_billing_customer(uuid, text) to service_role;
