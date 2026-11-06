-- Run once in Supabase (SQL Editor -> New query -> Run).
-- Optional status shown beside a task's name (subtask statuses live inside the subtasks column).
alter table public.tasks add column if not exists status text check (char_length(status) <= 60);
