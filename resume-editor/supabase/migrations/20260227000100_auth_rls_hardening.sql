-- Enforce per-user access with Supabase RLS.

alter table if exists public.applications enable row level security;
alter table if exists public.resume_runs enable row level security;
-- applications policies
do $$
begin
  if to_regclass('public.applications') is not null then
    execute 'drop policy if exists "applications_select_own" on public.applications';
    execute 'create policy "applications_select_own"
      on public.applications
      for select
      to authenticated
      using (user_id = auth.uid())';

    execute 'drop policy if exists "applications_insert_own" on public.applications';
    execute 'create policy "applications_insert_own"
      on public.applications
      for insert
      to authenticated
      with check (user_id = auth.uid())';

    execute 'drop policy if exists "applications_update_own" on public.applications';
    execute 'create policy "applications_update_own"
      on public.applications
      for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid())';

    execute 'drop policy if exists "applications_delete_own" on public.applications';
    execute 'create policy "applications_delete_own"
      on public.applications
      for delete
      to authenticated
      using (user_id = auth.uid())';
  end if;
end $$;
-- resume_runs policies
do $$
begin
  if to_regclass('public.resume_runs') is not null then
    execute 'drop policy if exists "resume_runs_select_own" on public.resume_runs';
    execute 'create policy "resume_runs_select_own"
      on public.resume_runs
      for select
      to authenticated
      using (user_id = auth.uid())';

    execute 'drop policy if exists "resume_runs_insert_own" on public.resume_runs';
    execute 'create policy "resume_runs_insert_own"
      on public.resume_runs
      for insert
      to authenticated
      with check (user_id = auth.uid())';

    execute 'drop policy if exists "resume_runs_update_own" on public.resume_runs';
    execute 'create policy "resume_runs_update_own"
      on public.resume_runs
      for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid())';

    execute 'drop policy if exists "resume_runs_delete_own" on public.resume_runs';
    execute 'create policy "resume_runs_delete_own"
      on public.resume_runs
      for delete
      to authenticated
      using (user_id = auth.uid())';
  end if;
end $$;
-- Storage object policies for the Resumes bucket.
-- Path convention expected by app: <user_id>/<request_id>/<filename>
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "resumes_bucket_select_own" on storage.objects';
    execute 'create policy "resumes_bucket_select_own"
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = ''Resumes''
        and (storage.foldername(name))[1] = auth.uid()::text
      )';

    execute 'drop policy if exists "resumes_bucket_insert_own" on storage.objects';
    execute 'create policy "resumes_bucket_insert_own"
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = ''Resumes''
        and (storage.foldername(name))[1] = auth.uid()::text
      )';

    execute 'drop policy if exists "resumes_bucket_update_own" on storage.objects';
    execute 'create policy "resumes_bucket_update_own"
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = ''Resumes''
        and (storage.foldername(name))[1] = auth.uid()::text
      )
      with check (
        bucket_id = ''Resumes''
        and (storage.foldername(name))[1] = auth.uid()::text
      )';

    execute 'drop policy if exists "resumes_bucket_delete_own" on storage.objects';
    execute 'create policy "resumes_bucket_delete_own"
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = ''Resumes''
        and (storage.foldername(name))[1] = auth.uid()::text
      )';
  end if;
end $$;
