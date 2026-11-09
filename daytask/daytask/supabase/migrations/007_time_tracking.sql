-- Run once in Supabase (SQL Editor -> New query -> Run).
-- Time tracking: one row per stretch of work (or per correction), kept per day.
create table if not exists public.time_entries (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id     uuid,                       -- no foreign key: history stays if a task is deleted
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
