-- Run once in Supabase (SQL Editor -> New query -> Run).
-- Subtask timers: a time entry can belong to one subtask (its own time, not added to the task's).
alter table public.time_entries add column if not exists subtask_id text;
