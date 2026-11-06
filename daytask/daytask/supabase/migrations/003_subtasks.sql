-- Run once in Supabase (SQL Editor -> New query -> Run).
-- Subtasks are a checklist stored on each task: [{ "id": "...", "title": "...", "done": false }].
alter table public.tasks add column if not exists subtasks jsonb not null default '[]'::jsonb;
