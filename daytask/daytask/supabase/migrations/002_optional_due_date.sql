-- Run once in Supabase (SQL Editor -> New query -> Run) if you already ran schema.sql.
-- Due dates become optional deadlines: a task without one simply has no deadline.
alter table public.tasks alter column due_date drop not null;
