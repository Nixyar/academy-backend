-- Course-specific quota for LLM requests.
-- Apply in Supabase SQL editor.

create table if not exists public.llm_course_quota (
  user_id uuid references auth.users not null,
  course_id uuid not null,
  used int4 not null default 0,
  limit int4,
  updated_at timestamptz default now(),
  primary key (user_id, course_id)
);

-- Ensure courses.llm_limit exists (nullable = unlimited).
alter table public.courses
  add column if not exists llm_limit int4;

