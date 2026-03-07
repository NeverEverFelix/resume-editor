create or replace function public.prevent_billing_events_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'billing_events is immutable';
end;
$$;
drop trigger if exists trg_billing_events_no_update on public.billing_events;
create trigger trg_billing_events_no_update
before update on public.billing_events
for each row execute function public.prevent_billing_events_mutation();
drop trigger if exists trg_billing_events_no_delete on public.billing_events;
create trigger trg_billing_events_no_delete
before delete on public.billing_events
for each row execute function public.prevent_billing_events_mutation();
revoke all on table public.billing_events from service_role;
grant select, insert on table public.billing_events to service_role;
grant usage, select on sequence public.billing_events_id_seq to service_role;
