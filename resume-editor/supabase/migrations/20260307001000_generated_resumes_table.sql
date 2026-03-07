create table if not exists public.generated_resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.resume_runs(id) on delete cascade,
  request_id text,
  template text not null default 'jakes-resume',
  filename text not null,
  latex text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
create index if not exists generated_resumes_user_id_created_at_idx
  on public.generated_resumes (user_id, created_at desc);
create index if not exists generated_resumes_run_id_idx
  on public.generated_resumes (run_id);
create unique index if not exists generated_resumes_run_id_template_uidx
  on public.generated_resumes (run_id, template);
alter table public.generated_resumes enable row level security;
drop policy if exists "generated_resumes_select_own" on public.generated_resumes;
create policy "generated_resumes_select_own"
  on public.generated_resumes
  for select
  to authenticated
  using (auth.uid() = user_id);
drop policy if exists "generated_resumes_insert_own" on public.generated_resumes;
create policy "generated_resumes_insert_own"
  on public.generated_resumes
  for insert
  to authenticated
  with check (auth.uid() = user_id);
drop policy if exists "generated_resumes_update_own" on public.generated_resumes;
create policy "generated_resumes_update_own"
  on public.generated_resumes
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
drop policy if exists "generated_resumes_delete_own" on public.generated_resumes;
create policy "generated_resumes_delete_own"
  on public.generated_resumes
  for delete
  to authenticated
  using (auth.uid() = user_id);
drop trigger if exists trg_generated_resumes_set_updated_at on public.generated_resumes;
create trigger trg_generated_resumes_set_updated_at
before update on public.generated_resumes
for each row
execute function public.set_updated_at();
grant select, insert, update, delete on table public.generated_resumes to authenticated;
grant all on table public.generated_resumes to service_role;
