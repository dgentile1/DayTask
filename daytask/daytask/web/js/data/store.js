// Storage + sync via Supabase (free tier). The only module that knows about Supabase.
import { DAYTASK_CONFIG } from '../../config.js';
import { normalizeSubtasks, sortSubtasks } from '../core/subtasks.js';
import { normalizeRepeat } from '../core/daily.js';

const sb = window.supabase.createClient(DAYTASK_CONFIG.supabaseUrl, DAYTASK_CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'daytask.auth' },
});

const COLS = 'id,title,note,status,due_date,start_date,repeat,priority,context,sort_key,completed_at,completed_on,source,source_ref,subtasks,created_at,updated_at';

const fromRow = (r) => ({
  id: r.id, title: r.title, note: r.note ?? '', status: r.status ?? null, dueDate: r.due_date, startDate: r.start_date ?? null, repeat: normalizeRepeat(r.repeat), priority: r.priority,
  context: r.context, sortKey: Number(r.sort_key), completedAt: r.completed_at, completedOn: r.completed_on,
  source: r.source, sourceRef: r.source_ref, subtasks: sortSubtasks(normalizeSubtasks(r.subtasks)), createdAt: r.created_at, updatedAt: r.updated_at,
});

const FIELD_MAP = {
  id: 'id', // tasks get their id on the device, so they can be created offline
  title: 'title', note: 'note', status: 'status', dueDate: 'due_date', startDate: 'start_date', repeat: 'repeat', priority: 'priority', context: 'context',
  sortKey: 'sort_key', completedAt: 'completed_at', completedOn: 'completed_on', source: 'source', sourceRef: 'source_ref', subtasks: 'subtasks', createdAt: 'created_at',
};
function toRow(patch) {
  const row = {};
  for (const [k, v] of Object.entries(patch)) if (k in FIELD_MAP) row[FIELD_MAP[k]] = v;
  return row;
}
function check({ data, error }) {
  if (error) {
    // Keep Postgres/PostgREST codes: the offline outbox uses them to tell
    // "retry later" (network, expired sign-in) from "the server will never accept this".
    throw Object.assign(new Error(error.message || 'Database request failed'), { code: error.code, status: error.status });
  }
  return data;
}

export const isConfigured = () =>
  !!DAYTASK_CONFIG.supabaseUrl && !DAYTASK_CONFIG.supabaseUrl.includes('YOUR-PROJECT');

export async function getSession() {
  return check(await sb.auth.getSession()).session;
}
export function onAuthChange(cb) {
  sb.auth.onAuthStateChange((_event, session) => cb(session));
}
export async function signIn(email, password) {
  return check(await sb.auth.signInWithPassword({ email, password })).session;
}
export async function signOut() {
  await sb.auth.signOut();
}

/** Open tasks plus anything completed today. */
export async function loadTasks(today) {
  const rows = check(await sb.from('tasks').select(COLS)
    .or(`completed_at.is.null,completed_on.eq.${today}`)
    .order('sort_key', { ascending: true }));
  return rows.map(fromRow);
}
export async function insertTask(task) {
  return fromRow(check(await sb.from('tasks').insert(toRow(task)).select(COLS).single()));
}
export async function updateTask(id, patch) {
  check(await sb.from('tasks').update(toRow(patch)).eq('id', id));
}
/** Many small updates (rollover, re-spacing). Rows are few, so parallel single updates are fine. */
export async function updateMany(patches) {
  await Promise.all(patches.map(({ id, ...patch }) => updateTask(id, patch)));
}
export async function deleteTask(id) {
  check(await sb.from('tasks').delete().eq('id', id));
}

export async function loadSettings() {
  const rows = check(await sb.from('user_settings').select('settings').limit(1));
  return rows[0]?.settings ?? {};
}
export async function saveSettings(settings) {
  const { data: { user } } = await sb.auth.getUser();
  check(await sb.from('user_settings').upsert({ user_id: user.id, settings }));
}

export async function existingImportFingerprints(fps) {
  if (!fps.length) return new Set();
  const rows = check(await sb.from('import_log').select('fingerprint').in('fingerprint', fps));
  return new Set(rows.map((r) => r.fingerprint));
}
export async function logImport(fingerprint, taskId) {
  check(await sb.from('import_log').upsert({ fingerprint, task_id: taskId }, { onConflict: 'user_id,fingerprint' }));
}

/** Live updates from other devices. onStatus receives true (connected) / false. */
export function subscribe(onChange, onStatus) {
  const channel = sb.channel('daytask-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_settings' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries' }, onChange)
    .subscribe((status) => onStatus(status === 'SUBSCRIBED'));
  return () => sb.removeChannel(channel);
}

// ---------------------------------------------------------------- time entries
const ENTRY_COLS = 'id,task_id,subtask_id,title,context,day,started_at,ended_at,seconds,kind';
const entryFromRow = (r) => ({
  id: r.id, taskId: r.task_id, subtaskId: r.subtask_id ?? null, title: r.title ?? '', context: r.context ?? null, day: r.day,
  startedAt: r.started_at, endedAt: r.ended_at, seconds: Number(r.seconds) || 0, kind: r.kind,
});
const ENTRY_MAP = { id: 'id', taskId: 'task_id', subtaskId: 'subtask_id', title: 'title', context: 'context', day: 'day',
  startedAt: 'started_at', endedAt: 'ended_at', seconds: 'seconds', kind: 'kind' };
function entryRow(patch) {
  const row = {};
  for (const [k, v] of Object.entries(patch)) if (k in ENTRY_MAP) row[ENTRY_MAP[k]] = v;
  return row;
}
/** Entries from `fromDay` on, plus any timer still running (whenever it started). */
export async function loadEntries(fromDay) {
  const rows = check(await sb.from('time_entries').select(ENTRY_COLS).or(`day.gte.${fromDay},ended_at.is.null`));
  return rows.map(entryFromRow);
}
export async function insertEntry(entry) { check(await sb.from('time_entries').insert(entryRow(entry))); }
export async function updateEntry(id, patch) { check(await sb.from('time_entries').update(entryRow(patch)).eq('id', id)); }
export async function deleteEntry(id) { check(await sb.from('time_entries').delete().eq('id', id)); }
