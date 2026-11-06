// Offline-first data layer. Every change is saved on this device first (cache + outbox)
// and sent to Supabase in order whenever there's a connection. Reads come from Supabase
// when online, with unsent changes shown on top, and from the device cache when not.
import * as store from './store.js';
import { enqueue, applyOutbox, isRetryable, isDuplicate } from '../core/outbox.js';

const CACHE_KEY = 'daytask.cache.v1';
const OUTBOX_KEY = 'daytask.outbox.v1';
const RETRY_MS = 15000;

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('Device storage full or unavailable', e); } };

let cache = read(CACHE_KEY, null);     // { userId, tasks, settings, importFps, savedAt }
let outbox = read(OUTBOX_KEY, []);
let sending = null;                    // opId being sent right now
let seq = 0;                           // bumps whenever an op reaches the server
let reachable = typeof navigator === 'undefined' ? true : navigator.onLine;
let retryTimer = null;
const listeners = new Set();
const errorListeners = new Set();

const notify = () => listeners.forEach((cb) => cb(status()));
const saveOutbox = () => { write(OUTBOX_KEY, outbox); notify(); };

export const status = () => ({ online: reachable, pending: outbox.length, syncing: !!sending });
export const onStatus = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
/** Called when the server permanently rejects a change (it is dropped). */
export const onRejected = (cb) => { errorListeners.add(cb); };
export const writeSeq = () => seq;
export const isSending = () => !!sending;
export const cachedUserId = () => cache?.userId ?? null;
export const hasCache = () => !!cache;

function markReachable(ok) {
  if (reachable !== ok) { reachable = ok; notify(); }
}

const uuid = () => globalThis.crypto?.randomUUID?.()
  ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });

// ---------------------------------------------------------------- reads

/**
 * Tasks (open + completed today) and settings.
 * Returns { tasks, settings, fromCache }. Throws only when offline with nothing cached.
 */
export async function loadAll(today) {
  try {
    const [settings, tasks] = [await store.loadSettings(), await store.loadTasks(today)];
    markReachable(true);
    const merged = applyOutbox(tasks, settings, outbox);
    flush(); // we're online: send anything waiting
    return { ...merged, fromCache: false };
  } catch (err) {
    if (!cache || !isRetryable(err)) throw err;
    markReachable(false);
    const tasks = cache.tasks.filter((t) => !t.completedAt || t.completedOn === today);
    return { ...applyOutbox(tasks, cache.settings, outbox), fromCache: true };
  }
}

/** Keep the device copy current. Called by the app after every load and change. */
export function snapshot(userId, tasks, settings) {
  cache = { userId, tasks, settings, importFps: cache?.importFps ?? [], savedAt: new Date().toISOString() };
  write(CACHE_KEY, cache);
}

// ---------------------------------------------------------------- writes (all instant, never throw for network)

function queue(op) {
  outbox = enqueue(outbox, op, sending);
  saveOutbox();
  flush();
}

export function insertTask(task) {
  const row = {
    ...task,
    id: task.id || uuid(),
    note: task.note ?? '',
    status: task.status ?? null,
    priority: task.priority || 'normal',
    context: task.context ?? null,
    dueDate: task.dueDate ?? null,
    startDate: task.startDate ?? null,
    repeat: task.repeat ?? null,
    subtasks: task.subtasks ?? [],
    completedAt: task.completedAt ?? null,
    completedOn: task.completedOn ?? null,
    source: task.source || 'manual',
    sourceRef: task.sourceRef ?? null,
    createdAt: task.createdAt || new Date().toISOString(),
  };
  queue({ kind: 'insert', taskId: row.id, row });
  return row;
}
export function updateTask(id, patch) { queue({ kind: 'update', taskId: id, patch }); }
export function updateMany(patches) { for (const { id, ...patch } of patches) queue({ kind: 'update', taskId: id, patch }); }
export function deleteTask(id) { queue({ kind: 'delete', taskId: id }); }
export function saveSettings(settings) { queue({ kind: 'settings', settings }); }

export function logImport(fingerprint, taskId) {
  if (cache) { cache.importFps = [...new Set([...(cache.importFps || []), fingerprint])]; write(CACHE_KEY, cache); }
  queue({ kind: 'import', fingerprint, taskId });
}
/** Already-imported Granola items: this device's record, plus the server's when reachable. */
export async function existingImportFingerprints(fps) {
  const local = new Set((cache?.importFps || []).filter((f) => fps.includes(f)));
  for (const o of outbox) if (o.kind === 'import' && fps.includes(o.fingerprint)) local.add(o.fingerprint);
  try {
    for (const f of await store.existingImportFingerprints(fps)) local.add(f);
    markReachable(true);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    markReachable(false);
  }
  return local;
}

// ---------------------------------------------------------------- sending

async function send(op) {
  switch (op.kind) {
    case 'insert':
      try { await store.insertTask(op.row); } catch (err) { if (!isDuplicate(err)) throw err; }
      break;
    case 'update': await store.updateTask(op.taskId, op.patch); break;
    case 'delete': await store.deleteTask(op.taskId); break;
    case 'settings': await store.saveSettings(op.settings); break;
    case 'import': await store.logImport(op.fingerprint, op.taskId); break;
    default: break;
  }
}

let flushing = null;
/** Send queued changes, oldest first. Stops at the first network failure and retries later. */
export function flush() {
  if (flushing) return flushing;
  // Cleared in finally (always asynchronous), so a run that ends instantly can't leave a stale "busy" flag.
  flushing = sendQueued().finally(() => { flushing = null; });
  return flushing;
}

async function sendQueued() {
    while (outbox.length) {
      const op = outbox[0];
      sending = op.opId;
      notify();
      try {
        await send(op);
        markReachable(true);
        outbox = outbox.filter((o) => o.opId !== op.opId);
        seq++;
        saveOutbox();
      } catch (err) {
        if (isRetryable(err)) {
          markReachable(navigator.onLine && !/fetch|network|load failed/i.test(String(err?.message || err)) ? reachable : false);
          scheduleRetry();
          break;
        }
        console.error('Change rejected by the server and dropped', op, err);
        outbox = outbox.filter((o) => o.opId !== op.opId);
        seq++;
        saveOutbox();
        errorListeners.forEach((cb) => cb(err, op));
      }
    }
    sending = null;
    notify();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => flush(), RETRY_MS);
}

/** Forget everything on this device (sign out). */
export function clearDevice() {
  outbox = []; cache = null;
  try { localStorage.removeItem(OUTBOX_KEY); localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
  notify();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flush(); notify(); });
  window.addEventListener('offline', () => markReachable(false));
}
