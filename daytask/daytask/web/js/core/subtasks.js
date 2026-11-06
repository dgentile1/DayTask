// Subtasks are a checklist stored on the task itself:
// [{ id, title, done, dueDate: 'YYYY-MM-DD' | null, priority: 'normal' | 'high', status: string | null }].
// Every helper returns a new array, so a task's list is replaced in one write.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A status is optional short text shown beside a name; blank means none. */
export function cleanStatus(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t || null;
}

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

export function normalizeSubtasks(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({
      id: String(s.id || newId()),
      title: s.title.trim().slice(0, 500),
      done: !!s.done,
      dueDate: YMD.test(s.dueDate ?? '') ? s.dueDate : null,
      priority: s.priority === 'high' ? 'high' : 'normal',
      status: cleanStatus(s.status),
    }));
}

export function addSubtask(list, title, { dueDate = null, priority = 'normal' } = {}) {
  const t = String(title || '').trim();
  if (!t) return list;
  return [...list, {
    id: newId(), title: t.slice(0, 500), done: false,
    dueDate: YMD.test(dueDate ?? '') ? dueDate : null,
    priority: priority === 'high' ? 'high' : 'normal',
    status: null,
  }];
}

export const setSubtaskDone = (list, id, done) => list.map((s) => (s.id === id ? { ...s, done: !!done } : s));

export function renameSubtask(list, id, title) {
  const t = String(title || '').trim();
  return t ? list.map((s) => (s.id === id ? { ...s, title: t.slice(0, 500) } : s)) : list;
}

export const removeSubtask = (list, id) => list.filter((s) => s.id !== id);

/** Reorder to match `ids` (the order on screen). Unknown ids are ignored; missing ones keep their place at the end. */
export function reorderSubtasks(list, ids) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  return [...ordered, ...list.filter((s) => !ids.includes(s.id))];
}

export function subtaskProgress(list) {
  const total = list?.length ?? 0;
  const done = list?.filter((s) => s.done).length ?? 0;
  return { done, total, allDone: total > 0 && done === total };
}

/** Set a subtask's due date (YYYY-MM-DD, or null/'' to clear), priority and/or status. */
export function updateSubtask(list, id, { dueDate, priority, status } = {}) {
  return list.map((s) => {
    if (s.id !== id) return s;
    const next = { ...s };
    if (dueDate !== undefined) next.dueDate = YMD.test(dueDate ?? '') ? dueDate : null;
    if (priority !== undefined) next.priority = priority === 'high' ? 'high' : 'normal';
    if (status !== undefined) next.status = cleanStatus(status);
    return next;
  });
}

const NO_DATE = '9999-12-31';

/** Which ordering group a subtask belongs to: its due date, 'none' (undated) or 'done'. */
export const subtaskGroup = (s) => (s.done ? 'done' : s.dueDate || 'none');

/**
 * The order subtasks are kept in: open ones by due date (earliest first, undated last),
 * then checked-off ones. Within the same date (and among undated or done ones) the
 * existing order is kept, so that's where your manual dragging applies.
 */
export function sortSubtasks(list) {
  return (list || [])
    .map((s, i) => [s, i])
    .sort(([a, i], [b, j]) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done) return i - j;
      return (a.dueDate || NO_DATE).localeCompare(b.dueDate || NO_DATE) || i - j;
    })
    .map(([s]) => s);
}

/** The next subtask to finish that has a due date (the first dated one in list order), or null. */
export function nextDueSubtask(list) {
  return sortSubtasks(list).find((s) => !s.done && s.dueDate) || null;
}

/**
 * What a task turns into when it's dropped onto another task. Subtasks are one level
 * deep, so the task becomes one subtask (keeping its due date and priority) and its
 * own subtasks follow it, flattened, in order.
 */
export function taskAsSubtasks(task) {
  const head = { id: newId(), title: String(task.title).trim().slice(0, 500), done: false,
    dueDate: YMD.test(task.dueDate ?? '') ? task.dueDate : null, priority: task.priority === 'high' ? 'high' : 'normal',
    status: cleanStatus(task.status) };
  const children = normalizeSubtasks(task.subtasks).map((s) => ({ ...s, id: newId() }));
  return [head, ...children];
}

/** The target's note with the moved task's note appended (unchanged if it had none). */
export function mergeNotes(targetNote, movedTitle, movedNote) {
  const extra = String(movedNote || '').trim();
  if (!extra) return targetNote || '';
  const block = `From "${movedTitle}":\n${extra}`;
  return (targetNote || '').trim() ? `${targetNote.trim()}\n\n${block}` : block;
}

/** Status suggestions: common ones first, then any in use (newest-looking first), no repeats. */
export const COMMON_STATUSES = ['In progress', 'Waiting', 'Blocked', 'On hold', 'Needs review'];
export function statusSuggestions(tasks) {
  const used = [];
  for (const t of tasks || []) {
    if (t.status) used.push(t.status);
    for (const st of t.subtasks || []) if (st.status) used.push(st.status);
  }
  const seen = new Set();
  return [...COMMON_STATUSES, ...used].filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
