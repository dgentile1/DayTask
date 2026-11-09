-- Run once in Supabase (SQL Editor -> New query -> Run).
-- A third list, App, for ideas and updates for this app.
alter table public.tasks drop constraint if exists tasks_context_check;
alter table public.tasks add constraint tasks_context_check check (context in ('work', 'home', 'app'));
