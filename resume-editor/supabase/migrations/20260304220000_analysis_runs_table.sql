create table if not exists public.analysis_runs (
  run_id uuid primary key references public.resume_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_title text not null,
  job_description text not null,
  score integer not null,
  positives text[] not null default '{}',
  negatives text[] not null default '{}',
  created_at timestamp with time zone not null default now(),
  constraint analysis_runs_score_valid check (score >= 0 and score <= 100)
);
alter table public.analysis_runs enable row level security;
drop policy if exists "analysis_runs_select_own" on public.analysis_runs;
create policy "analysis_runs_select_own"
  on public.analysis_runs
  for select
  to authenticated
  using (auth.uid() = user_id);
grant select on table public.analysis_runs to authenticated;
grant all on table public.analysis_runs to service_role;
