-- DayTask schema. Paste into Supabase: SQL Editor -> New query -> Run.
-- Single-user by design, but every row is owned by an auth user and locked down with RLS,
-- so the public "anon" key in web/config.js can't read anything without signing in.

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 500),
  note          text not null default '' check (char_length(note) <= 10000),
  status        text check (char_length(status) <= 60),     -- optional, shown beside the name
  due_date      date,                                       -- optional deadline
  start_date    date,                                       -- optional: joins the Tasks list on this day
  repeat        jsonb,                                      -- daily tasks: {days, doneOn, subsOn}; null = one-off
  priority      text not null default 'normal' check (priority in ('high', 'normal')),
  context       text constraint tasks_context_check check (context in ('work', 'home', 'app')), -- null = needs sorting (imports)
  sort_key      double precision not null,
  completed_at  timestamptz,
  completed_on  date,                                       -- local date it was completed
  source        text not null default 'manual' check (source in ('manual', 'granola')),
  source_ref    text,
  subtasks      jsonb not null default '[]'::jsonb,         -- checklist [{id, title, done}]
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists tasks_user_open on public.tasks (user_id, sort_key) where completed_at is null;
create index if not exists tasks_user_done on public.tasks (user_id, completed_on);

create table if not exists public.user_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.import_log (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fingerprint  text not null,
  task_id      uuid,
  imported_at  timestamptz not null default now(),
  primary key (user_id, fingerprint)
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();
drop trigger if exists settings_touch on public.user_settings;
create trigger settings_touch before update on public.user_settings for each row execute function public.touch_updated_at();

alter table public.tasks         enable row level security;
alter table public.user_settings enable row level security;
alter table public.import_log    enable row level security;

drop policy if exists own_tasks on public.tasks;
create policy own_tasks on public.tasks for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists own_settings on public.user_settings;
create policy own_settings on public.user_settings for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists own_imports on public.import_log;
create policy own_imports on public.import_log for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Existing databases from the first version: make due_date optional.
alter table public.tasks alter column due_date drop not null;
alter table public.tasks add column if not exists subtasks jsonb not null default '[]'::jsonb;
alter table public.tasks add column if not exists start_date date;
alter table public.tasks add column if not exists repeat jsonb;
alter table public.tasks add column if not exists status text check (char_length(status) <= 60);

-- Live sync between desktop and phone.
do $$ begin
  alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.user_settings;
exception when duplicate_object then null; end $$;

-- Time tracking (also in migrations/007_time_tracking.sql).
create table if not exists public.time_entries (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id     uuid,                       -- no foreign key: history stays if a task is deleted
  subtask_id  text,                       -- set: a subtask's own time (not added to its task's)
  title       text not null default '',   -- task name when logged
  context     text check (context in ('work', 'home')),
  day         date not null,              -- local day the time counts toward
  started_at  timestamptz,
  ended_at    timestamptz,                -- null while a timer is running
  seconds     integer not null default 0, -- corrections may be negative
  kind        text not null default 'timer' check (kind in ('timer', 'adjust')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists time_entries_user_day on public.time_entries (user_id, day);

drop trigger if exists time_entries_touch on public.time_entries;
create trigger time_entries_touch before update on public.time_entries for each row execute function public.touch_updated_at();

alter table public.time_entries enable row level security;
drop policy if exists own_time on public.time_entries;
create policy own_time on public.time_entries for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $$ begin
  alter publication supabase_realtime add table public.time_entries;
exception when duplicate_object then null; end $$;
alter table public.time_entries add column if not exists subtask_id text;

-- App list (also migrations/009_app_list.sql): existing databases.
alter table public.tasks drop constraint if exists tasks_context_check;
alter table public.tasks add constraint tasks_context_check check (context in ('work', 'home', 'app'));
