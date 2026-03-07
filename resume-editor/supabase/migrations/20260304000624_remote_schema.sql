revoke delete on table "public"."documents" from "anon";
revoke insert on table "public"."documents" from "anon";
revoke references on table "public"."documents" from "anon";
revoke select on table "public"."documents" from "anon";
revoke trigger on table "public"."documents" from "anon";
revoke truncate on table "public"."documents" from "anon";
revoke update on table "public"."documents" from "anon";
revoke delete on table "public"."documents" from "authenticated";
revoke insert on table "public"."documents" from "authenticated";
revoke references on table "public"."documents" from "authenticated";
revoke select on table "public"."documents" from "authenticated";
revoke trigger on table "public"."documents" from "authenticated";
revoke truncate on table "public"."documents" from "authenticated";
revoke update on table "public"."documents" from "authenticated";
revoke delete on table "public"."embeddings" from "anon";
revoke insert on table "public"."embeddings" from "anon";
revoke references on table "public"."embeddings" from "anon";
revoke select on table "public"."embeddings" from "anon";
revoke trigger on table "public"."embeddings" from "anon";
revoke truncate on table "public"."embeddings" from "anon";
revoke update on table "public"."embeddings" from "anon";
revoke delete on table "public"."embeddings" from "authenticated";
revoke insert on table "public"."embeddings" from "authenticated";
revoke references on table "public"."embeddings" from "authenticated";
revoke select on table "public"."embeddings" from "authenticated";
revoke trigger on table "public"."embeddings" from "authenticated";
revoke truncate on table "public"."embeddings" from "authenticated";
revoke update on table "public"."embeddings" from "authenticated";
revoke delete on table "public"."roles" from "anon";
revoke insert on table "public"."roles" from "anon";
revoke references on table "public"."roles" from "anon";
revoke select on table "public"."roles" from "anon";
revoke trigger on table "public"."roles" from "anon";
revoke truncate on table "public"."roles" from "anon";
revoke update on table "public"."roles" from "anon";
revoke delete on table "public"."roles" from "authenticated";
revoke insert on table "public"."roles" from "authenticated";
revoke references on table "public"."roles" from "authenticated";
revoke trigger on table "public"."roles" from "authenticated";
revoke truncate on table "public"."roles" from "authenticated";
revoke update on table "public"."roles" from "authenticated";
set check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.claim_next_resume_run()
 RETURNS SETOF public.resume_runs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with next_run as (
    select rr.id
    from public.resume_runs rr
    where rr.status = 'queued'
    order by rr.created_at asc, rr.id asc
    for update skip locked
    limit 1
  )
  update public.resume_runs rr
  set
    status = 'extracting',
    error_code = null,
    error_message = null
  from next_run
  where rr.id = next_run.id
  returning rr.*;
end;
$function$;
