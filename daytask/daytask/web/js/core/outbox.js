// Offline outbox: the list of changes saved on this device and not yet sent to Supabase.
// Pure functions only, so the merge and replay rules are unit-tested.
//
// Op shapes (all carry a unique opId):
//   { kind: 'insert',   taskId, row }            row = full task (camelCase), id included
//   { kind: 'update',   taskId, patch }          only the fields that changed
//   { kind: 'delete',   taskId }
//   { kind: 'settings', settings }               whole settings object
//   { kind: 'import',   fingerprint, taskId }    Granola de-duplication log
// insert / update / delete may carry table: 'time_entries' (taskId then holds the entry's id);
// without it they're for tasks.

let counter = 0;
const tableOf = (o) => o.table || 'tasks';
const sameTarget = (a, b) => tableOf(a) === tableOf(b) && a.taskId === b.taskId;
export const newOpId = () => `op-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Add an op to the queue, folding it into earlier unsent ops where that's safe.
 * `lockedOpId` is the op currently being sent; it is never modified.
 */
export function enqueue(queue, op, lockedOpId = null) {
  const q = [...queue];
  const editable = (o) => o.opId !== lockedOpId;
  const withId = { opId: op.opId || newOpId(), ...op };

  if (op.kind === 'update') {
    // Fold into the latest unsent insert/update of the same task, if nothing for it is locked after.
    for (let i = q.length - 1; i >= 0; i--) {
      const o = q[i];
      if (!sameTarget(o, op) || (o.kind !== 'insert' && o.kind !== 'update' && o.kind !== 'delete')) continue;
      if (!editable(o) || o.kind === 'delete') break;
      if (o.kind === 'insert') { q[i] = { ...o, row: { ...o.row, ...op.patch } }; return q; }
      q[i] = { ...o, patch: { ...o.patch, ...op.patch } };
      return q;
    }
    return [...q, withId];
  }

  if (op.kind === 'delete') {
    // Never sent at all? Then drop every queued op for it and send nothing.
    const insertIdx = q.findIndex((o) => o.kind === 'insert' && sameTarget(o, op));
    if (insertIdx !== -1 && editable(q[insertIdx])) {
      return q.filter((o) => !(sameTarget(o, op) && (o.kind === 'insert' || o.kind === 'update' || o.kind === 'delete') && editable(o)));
    }
    // Otherwise unsent updates are pointless: drop them, then delete.
    return [...q.filter((o) => !(o.kind === 'update' && sameTarget(o, op) && editable(o))), withId];
  }

  if (op.kind === 'settings') {
    // Only the latest settings matter.
    return [...q.filter((o) => !(o.kind === 'settings' && editable(o))), withId];
  }

  return [...q, withId];
}

/** Show queued changes on top of data fetched from the server (or the device cache). */
export function applyOutbox(tasks, settings, queue) {
  let list = tasks.map((t) => ({ ...t }));
  let s = settings;
  for (const o of queue) {
    if (o.table && o.table !== 'tasks') continue;
    if (o.kind === 'insert') {
      if (!list.some((t) => t.id === o.taskId)) list.push({ ...o.row });
    } else if (o.kind === 'update') {
      const t = list.find((x) => x.id === o.taskId);
      if (t) Object.assign(t, o.patch);
    } else if (o.kind === 'delete') {
      list = list.filter((t) => t.id !== o.taskId);
    } else if (o.kind === 'settings') {
      s = o.settings;
    }
  }
  return { tasks: list, settings: s };
}

/** Network trouble (or an expired sign-in that will refresh once online): keep the op and retry. */
export function isRetryable(err) {
  if (!err) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (isPermanent(err)) return false;
  return true; // unknown errors are retried rather than risk losing a change
}

/**
 * Errors that will never succeed on retry: the database rejected the data itself
 * (Postgres classes 22 = bad data, 23 = constraint, 42 = bad column/table).
 */
export function isPermanent(err) {
  return /^(22|23|42)\w{3}$/.test(String(err?.code || ''));
}

/** Inserting a task that already exists: an earlier attempt got through but the reply was lost. */
export const isDuplicate = (err) => String(err?.code || '') === '23505';

/** Queued time-entry changes on top of fetched entries. */
export function applyEntryOutbox(entries, queue) {
  let list = entries.map((e) => ({ ...e }));
  for (const o of queue) {
    if (o.table !== 'time_entries') continue;
    if (o.kind === 'insert') { if (!list.some((e) => e.id === o.taskId)) list.push({ ...o.row }); }
    else if (o.kind === 'update') { const e = list.find((x) => x.id === o.taskId); if (e) Object.assign(e, o.patch); }
    else if (o.kind === 'delete') list = list.filter((e) => e.id !== o.taskId);
  }
  return list;
}
