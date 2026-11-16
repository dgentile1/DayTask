// Subtasks are a checklist stored on the task itself:
// [{ id, title, done, archived, dueDate: 'YYYY-MM-DD' | null, priority: 'normal' | 'high', status: string | null }].
// Every helper returns a new array, so a task's list is replaced in one write.
// Archiving puts a finished subtask out of sight without deleting it: it keeps its
// record (and its tracked time) but drops out of the list and the x/y count.

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
      archived: !!s.archived,
      dueDate: YMD.test(s.dueDate ?? '') ? s.dueDate : null,
      priority: s.priority === 'high' ? 'high' : 'normal',
      status: cleanStatus(s.status),
    }));
}

export function addSubtask(list, title, { dueDate = null, priority = 'normal' } = {}) {
  const t = String(title || '').trim();
  if (!t) return list;
  const id = newId();
  return placeByDate([...list, {
    id, title: t.slice(0, 500), done: false, archived: false,
    dueDate: YMD.test(dueDate ?? '') ? dueDate : null,
    priority: priority === 'high' ? 'high' : 'normal',
    status: null,
  }], id);
}

/** Checked off: drops to the bottom. Unchecked: slots back in by its due date (and out of the archive). */
export function setSubtaskDone(list, id, done) {
  const next = list.map((s) => (s.id === id ? { ...s, done: !!done, archived: done ? s.archived : false } : s));
  return done ? sortSubtasks(next) : placeByDate(next, id);
}

/**
 * Put a subtask out of sight (or bring it back). Archiving counts as finishing it, so a
 * subtask archived straight from the list is checked off too; restoring leaves it checked
 * off, at the bottom with the other finished ones, ready to be unchecked.
 */
export function setSubtaskArchived(list, id, archived) {
  const on = !!archived;
  return sortSubtasks(list.map((s) => (s.id === id ? { ...s, archived: on, done: on ? true : s.done } : s)));
}

/** Archive every finished subtask at once (the "Archive done" button). */
export const archiveDoneSubtasks = (list) =>
  sortSubtasks(list.map((s) => (s.done ? { ...s, archived: true } : s)));

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

/** The x/y shown on a task. Archived subtasks are out of the list, so they're out of the count. */
export function subtaskProgress(list) {
  const live = (list || []).filter((s) => !s.archived);
  const done = live.filter((s) => s.done).length;
  return { done, total: live.length, allDone: live.length > 0 && done === live.length, archived: (list?.length ?? 0) - live.length };
}

/** Set a subtask's due date (YYYY-MM-DD, or null/'' to clear), priority and/or status. */
export function updateSubtask(list, id, { dueDate, priority, status } = {}) {
  const before = list.find((s) => s.id === id);
  const next = list.map((s) => {
    if (s.id !== id) return s;
    const next = { ...s };
    if (dueDate !== undefined) next.dueDate = YMD.test(dueDate ?? '') ? dueDate : null;
    if (priority !== undefined) next.priority = priority === 'high' ? 'high' : 'normal';
    if (status !== undefined) next.status = cleanStatus(status);
    return next;
  });
  // A date set or changed slots it in by date; anything else (or clearing a date) leaves it where it is.
  const after = next.find((s) => s.id === id);
  return after && after.dueDate && after.dueDate !== before?.dueDate ? placeByDate(next, id) : next;
}

const NO_DATE = '9999-12-31';

/** Still on the list: not checked off and not archived. */
export const isOpenSubtask = (s) => !s.done && !s.archived;

/** Drag groups: open subtasks can be arranged freely among themselves; checked-off ones stay below. */
export const subtaskGroup = (s) => (s.archived ? 'archived' : s.done ? 'done' : 'open');

/**
 * The order subtasks are kept in: your order, with checked-off ones moved to the bottom and
 * archived ones below those. Due dates only decide where a subtask lands when a date is set
 * or it's unchecked (see placeByDate); after that your dragging wins.
 */
export function sortSubtasks(list) {
  const l = list || [];
  return [...l.filter(isOpenSubtask), ...l.filter((s) => s.done && !s.archived), ...l.filter((s) => s.archived)];
}

/**
 * Put subtask `id` where its due date says among the open ones: before the first open
 * subtask that's due later or has no date (so after any due the same day). Without a
 * date it goes after the open ones. Everything else keeps its place.
 */
export function placeByDate(list, id) {
  const item = list.find((s) => s.id === id);
  if (!item || !isOpenSubtask(item)) return sortSubtasks(list);
  const rest = sortSubtasks(list.filter((s) => s.id !== id));
  const openCount = rest.filter(isOpenSubtask).length;
  let at = openCount;
  if (item.dueDate) {
    const i = rest.findIndex((s) => isOpenSubtask(s) && (!s.dueDate || s.dueDate > item.dueDate));
    if (i !== -1) at = i;
  }
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

/** The next subtask to finish that has a due date (the first dated one in list order), or null. */
export function nextDueSubtask(list) {
  return sortSubtasks(list).find((s) => isOpenSubtask(s) && s.dueDate) || null;
}

/**
 * What a task turns into when it's dropped onto another task. Subtasks are one level
 * deep, so the task becomes one subtask (keeping its due date and priority) and its
 * own subtasks follow it, flattened, in order.
 */
export function taskAsSubtasks(task) {
  const head = { id: newId(), title: String(task.title).trim().slice(0, 500), done: false, archived: false,
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
    for (const st of t.subtasks || []) if (st.status && !st.archived) used.push(st.status);
  }
  const seen = new Set();
  return [...COMMON_STATUSES, ...used].filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
