-- Run once in Supabase (SQL Editor -> New query -> Run).
-- Optional start date: the day a task joins your Tasks list (it stays on the Calendar until then).
alter table public.tasks add column if not exists start_date date;
