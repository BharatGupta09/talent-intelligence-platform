-- =====================================================================
-- 0002_rls.sql
-- Row Level Security. This is the authoritative authorization boundary.
-- API-layer guards mirror these rules; the database is what enforces them.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper predicates.
-- SECURITY DEFINER so that reading `profiles` inside a `profiles` policy
-- does not recurse. STABLE so the planner caches per-statement.
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Request identity.
-- MIGRATION NOTE: replaces the Supabase app_user_id() function. The
-- application issues, on every authenticated request:
--     BEGIN; SET LOCAL app.user_id = '<uuid>'; ...; COMMIT;
-- SET LOCAL is transaction-scoped, so a pooled connection cannot carry
-- one request's identity into the next. The `true` second argument makes
-- a missing setting return NULL instead of raising, so an unauthenticated
-- request yields NULL and every policy fails closed.
-- ---------------------------------------------------------------------
create or replace function app_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function auth_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = app_user_id() and is_active
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth_role() = 'admin', false)
$$;

create or replace function is_recruiter() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth_role() = 'recruiter', false)
$$;

create or replace function my_candidate_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from candidate_profiles where user_id = app_user_id()
$$;

-- A recruiter owns a job outright.
create or replace function owns_job(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from jobs where id = target and recruiter_id = app_user_id())
$$;

-- §13: a recruiter reaches a candidate ONLY through an application to their job.
create or replace function owns_application(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a
    join jobs j on j.id = a.job_id
    where a.id = target and j.recruiter_id = app_user_id()
  )
$$;

-- Candidate is visible to the current recruiter only via an application.
create or replace function candidate_visible_to_me(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a
    join jobs j on j.id = a.job_id
    where a.candidate_id = target and j.recruiter_id = app_user_id()
  )
$$;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere. Default posture is deny.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','candidate_profiles','candidate_experience','candidate_education',
    'candidate_projects','candidate_certifications','skills','candidate_skills',
    'jobs','job_requirements','job_analyses','resumes','resume_analyses',
    'applications','application_analyses','application_scores','application_events',
    'recruiter_notes','application_tags','interview_kits','interview_preps',
    'interview_practice','notifications','ai_jobs','ai_usage','system_events','ai_settings'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Service access.
-- MIGRATION NOTE: Supabase's service-role key bypassed RLS outright. Neon has
-- no equivalent: the application connects as the table owner, and every table
-- above is FORCE'd, so even the owner is subject to its policies. Rather than
-- dropping FORCE (which would make an accidental owner-context query a silent
-- full-table read), the background worker gets one explicit, auditable escape
-- on the same transaction-scoped GUC mechanism as identity.
--
-- Only lib/db/session.ts#runAsService sets this flag, and only the AI queue
-- drain and admin tooling call it. A normal request never sets it, so a normal
-- request is still bound by the policies below.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','candidate_profiles','candidate_experience','candidate_education',
    'candidate_projects','candidate_certifications','skills','candidate_skills',
    'jobs','job_requirements','job_analyses','resumes','resume_analyses',
    'applications','application_analyses','application_scores','application_events',
    'recruiter_notes','application_tags','interview_kits','interview_preps',
    'interview_practice','notifications','ai_jobs','ai_usage','system_events','ai_settings'
  ] loop
    execute format(
      'create policy %I_service on %I for all '
      'using (current_setting(''app.service_op'', true) = ''on'') '
      'with check (current_setting(''app.service_op'', true) = ''on'')',
      t || '_svc', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
create policy profiles_self_read on profiles for select
  using (id = app_user_id() or is_admin());

-- A recruiter may read the identity of candidates who applied to their jobs.
create policy profiles_recruiter_read_applicants on profiles for select
  using (
    is_recruiter() and exists (
      select 1 from candidate_profiles cp
      where cp.user_id = profiles.id and candidate_visible_to_me(cp.id)
    )
  );

create policy profiles_self_update on profiles for update
  using (id = app_user_id()) with check (id = app_user_id() and role = auth_role());

create policy profiles_admin_all on profiles for all
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- candidate_profiles and children  (§94 strict isolation)
-- ---------------------------------------------------------------------
create policy cp_owner_all on candidate_profiles for all
  using (user_id = app_user_id()) with check (user_id = app_user_id());

create policy cp_recruiter_read on candidate_profiles for select
  using (is_recruiter() and candidate_visible_to_me(id));

create policy cp_admin_read on candidate_profiles for select using (is_admin());

do $$
declare t text;
begin
  foreach t in array array[
    'candidate_experience','candidate_education','candidate_projects',
    'candidate_certifications','candidate_skills'
  ] loop
    execute format($f$
      create policy %1$s_owner_all on %1$I for all
        using (candidate_id = my_candidate_id())
        with check (candidate_id = my_candidate_id());
    $f$, t);
    execute format($f$
      create policy %1$s_recruiter_read on %1$I for select
        using (is_recruiter() and candidate_visible_to_me(candidate_id));
    $f$, t);
    execute format($f$
      create policy %1$s_admin_read on %1$I for select using (is_admin());
    $f$, t);
  end loop;
end $$;

-- Shared skill vocabulary is readable by any signed-in user; only admin writes.
create policy skills_read on skills for select using (app_user_id() is not null);
create policy skills_admin_write on skills for all
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- jobs  (§18 public board, §26 recruiter edit, §59 closure)
-- ---------------------------------------------------------------------
create policy jobs_public_read on jobs for select
  using (status = 'active');

create policy jobs_owner_all on jobs for all
  using (recruiter_id = app_user_id()) with check (recruiter_id = app_user_id());

create policy jobs_admin_all on jobs for all
  using (is_admin()) with check (is_admin());

-- A candidate keeps read access to a job they applied to, even once closed.
create policy jobs_applicant_read on jobs for select
  using (exists (
    select 1 from applications a
    where a.job_id = jobs.id and a.candidate_id = my_candidate_id()
  ));

create policy jobreq_public_read on job_requirements for select
  using (exists (select 1 from jobs j where j.id = job_id and j.status = 'active'));
create policy jobreq_owner_all on job_requirements for all
  using (owns_job(job_id)) with check (owns_job(job_id));
create policy jobreq_admin_all on job_requirements for all
  using (is_admin()) with check (is_admin());
create policy jobreq_applicant_read on job_requirements for select
  using (exists (
    select 1 from applications a
    where a.job_id = job_requirements.job_id and a.candidate_id = my_candidate_id()
  ));

-- Scoring dimensions are internal: recruiter-owner and admin only.
create policy jobanalysis_owner_read on job_analyses for select using (owns_job(job_id));
create policy jobanalysis_admin_all on job_analyses for all
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- resumes  (§63 storage authorization mirrors this)
-- ---------------------------------------------------------------------
create policy resumes_owner_all on resumes for all
  using (candidate_id = my_candidate_id()) with check (candidate_id = my_candidate_id());

-- Recruiter reads only the exact resume attached to an application they own.
create policy resumes_recruiter_read on resumes for select
  using (is_recruiter() and exists (
    select 1 from applications a join jobs j on j.id = a.job_id
    where a.resume_id = resumes.id and j.recruiter_id = app_user_id()
  ));

create policy resumes_admin_read on resumes for select using (is_admin());

create policy ranalysis_owner_read on resume_analyses for select
  using (candidate_id = my_candidate_id());
create policy ranalysis_recruiter_read on resume_analyses for select
  using (is_recruiter() and exists (
    select 1 from applications a join jobs j on j.id = a.job_id
    where a.resume_id = resume_analyses.resume_id and j.recruiter_id = app_user_id()
  ));
create policy ranalysis_admin_read on resume_analyses for select using (is_admin());

-- ---------------------------------------------------------------------
-- applications  (§33 no withdrawal -> no candidate DELETE policy at all)
-- ---------------------------------------------------------------------
create policy apps_candidate_read on applications for select
  using (candidate_id = my_candidate_id());

create policy apps_candidate_insert on applications for insert
  with check (
    candidate_id = my_candidate_id()
    and exists (select 1 from jobs j where j.id = job_id and j.status = 'active')
    and exists (select 1 from resumes r where r.id = resume_id and r.candidate_id = my_candidate_id())
  );

create policy apps_recruiter_read on applications for select using (owns_application(id));
create policy apps_recruiter_update on applications for update
  using (owns_application(id)) with check (owns_application(id));
create policy apps_admin_all on applications for all
  using (is_admin()) with check (is_admin());

create policy appanalysis_candidate_read on application_analyses for select
  using (exists (select 1 from applications a
                 where a.id = application_id and a.candidate_id = my_candidate_id()));
create policy appanalysis_recruiter_read on application_analyses for select
  using (owns_application(application_id));
create policy appanalysis_admin_all on application_analyses for all
  using (is_admin()) with check (is_admin());

create policy appscore_candidate_read on application_scores for select
  using (exists (select 1 from applications a
                 where a.id = application_id and a.candidate_id = my_candidate_id()));
create policy appscore_recruiter_read on application_scores for select
  using (owns_application(application_id));
create policy appscore_admin_all on application_scores for all
  using (is_admin()) with check (is_admin());

create policy appevent_candidate_read on application_events for select
  using (exists (select 1 from applications a
                 where a.id = application_id and a.candidate_id = my_candidate_id()));
create policy appevent_recruiter_all on application_events for all
  using (owns_application(application_id)) with check (owns_application(application_id));
create policy appevent_admin_all on application_events for all
  using (is_admin()) with check (is_admin());

-- §57: recruiter notes and tags are never visible to candidates. No candidate policy.
create policy notes_recruiter_all on recruiter_notes for all
  using (owns_application(application_id) and recruiter_id = app_user_id())
  with check (owns_application(application_id) and recruiter_id = app_user_id());
create policy notes_admin_read on recruiter_notes for select using (is_admin());

create policy tags_recruiter_all on application_tags for all
  using (owns_application(application_id)) with check (owns_application(application_id));
create policy tags_admin_read on application_tags for select using (is_admin());

-- ---------------------------------------------------------------------
-- interview intelligence
-- ---------------------------------------------------------------------
create policy kits_recruiter_all on interview_kits for all
  using (owns_application(application_id)) with check (owns_application(application_id));
create policy kits_admin_read on interview_kits for select using (is_admin());

create policy preps_owner_all on interview_preps for all
  using (candidate_id = my_candidate_id()) with check (candidate_id = my_candidate_id());
create policy preps_admin_read on interview_preps for select using (is_admin());

create policy practice_owner_all on interview_practice for all
  using (candidate_id = my_candidate_id()) with check (candidate_id = my_candidate_id());
create policy practice_admin_read on interview_practice for select using (is_admin());

-- ---------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------
create policy notif_owner_read on notifications for select using (user_id = app_user_id());
create policy notif_owner_update on notifications for update
  using (user_id = app_user_id()) with check (user_id = app_user_id());
create policy notif_admin_all on notifications for all
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- AI operations: admin-visible only. Workers use the service role,
-- which bypasses RLS by design.
-- ---------------------------------------------------------------------
create policy aijobs_admin_all on ai_jobs for all using (is_admin()) with check (is_admin());
create policy aiusage_admin_read on ai_usage for select using (is_admin());
create policy sysevents_admin_read on system_events for select using (is_admin());
create policy aisettings_read on ai_settings for select using (app_user_id() is not null);
create policy aisettings_admin_write on ai_settings for update
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- users (credential store)
-- MIGRATION NOTE: this table did not exist under Supabase; it replaces the
-- managed auth user table. It holds email and password hash, so no ordinary
-- request may read it. RLS is enabled AND forced (the application connects
-- as the table owner on Neon, and FORCE is what stops the owner bypassing
-- the policies).
--
-- The only way in is the authentication path, which opens a transaction and
-- sets `app.auth_op` for the duration of that statement group. A normal
-- request never sets it, so every normal request is denied. This is the same
-- transaction-scoped GUC mechanism used for identity, deliberately: there is
-- exactly one escape hatch in the system and it is auditable.
-- ---------------------------------------------------------------------
alter table users enable row level security;
alter table users force row level security;

create policy users_auth_read on users for select
  using (current_setting('app.auth_op', true) = 'on');

create policy users_auth_insert on users for insert
  with check (current_setting('app.auth_op', true) = 'on');

create policy users_auth_update on users for update
  using (current_setting('app.auth_op', true) = 'on')
  with check (current_setting('app.auth_op', true) = 'on');
