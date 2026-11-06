-- Run once in Supabase (SQL Editor -> New query -> Run).
-- Daily (repeating) tasks: { "days": "all" | "work", "doneOn": "YYYY-MM-DD" | null, "subsOn": ... } or null.
alter table public.tasks add column if not exists repeat jsonb;
