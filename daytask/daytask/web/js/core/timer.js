// Time tracking. Pure functions only (unit-tested).
//
// A time entry: { id, taskId, subtaskId, title, context, day: 'YYYY-MM-DD', startedAt, endedAt, seconds, kind }
//   subtaskId null = time on the task itself; set = that subtask's own time (not added to the task's).
//   kind 'timer'  : a stretch of work. endedAt null = running now. Never spans midnight once stopped.
//   kind 'adjust' : a correction (seconds may be negative) so a day's total matches what you set.
//                   One per task per day; the timer entries themselves are never rewritten.
import { localParts, addDays, weekdayOf } from './dates.js';
import { normalizeSettings, switchMinutesFor } from './schedule.js';

/** Local time minus UTC, in ms, at `instant` in time zone `tz`. */
export function tzOffsetMs(instant, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant local midnight starts `ymd` in `tz` (handles daylight-saving changes). */
export function startOfLocalDay(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

/** The instant of local time `minutes` after midnight on `ymd` in `tz`. */
export function localInstant(ymd, minutes, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

/**
 * When a running timer stops by itself: at the end of the work day it was started in (the
 * moment the lists switch to Home, so Extend day / Switch to Home count). A timer started
 * after work hours or on a day off stops at the end of the next work day.
 */
export function autoStopAt(entry, settings, tz) {
  const s = normalizeSettings(settings);
  const start = new Date(entry.startedAt);
  let day = localParts(start, tz).date;
  for (let i = 0; i < 15; i++, day = addDays(day, 1)) {
    if (!s.workDays.includes(weekdayOf(day))) continue;
    const end = localInstant(day, switchMinutesFor(day, s), tz);
    if (end > start) return end;
  }
  return null;
}

/** A stable UUID made from text, so two devices splitting the same timer create the same entry ids. */
export function uuidFrom(text) {
  const part = (seed) => {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const x = part(1) + part(2) + part(3) + part(4);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-5${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

/** Split [start, end) into one piece per local day: [{ day, start, end, seconds }]. */
export function splitByDay(startIso, endIso, tz) {
  const out = [];
  let s = new Date(startIso);
  const e = new Date(endIso);
  while (s < e) {
    const day = localParts(s, tz).date;
    const next = startOfLocalDay(addDays(day, 1), tz);
    const stop = e < next ? e : next;
    out.push({ day, start: s, end: stop, seconds: Math.round((stop - s) / 1000) });
    s = stop;
  }
  return out;
}

/** Every timer running now (several can run at once), newest first. */
export const runningEntries = (entries) => entries.filter((e) => e.kind === 'timer' && !e.endedAt)
  .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
export const runningEntry = (entries) => runningEntries(entries)[0] || null;

/** What a timer belongs to: a task ('taskId|') or one of its subtasks ('taskId|subId'). */
export const timeKey = (taskId, subtaskId = null) => `${taskId}|${subtaskId || ''}`;
export const entryKey = (e) => timeKey(e.taskId, e.subtaskId);

/** Changes that stop one running timer at `now`, adding one entry per extra day if it ran past midnight. */
function stopOne(r, now, tz, changes) {
  const end = now < new Date(r.startedAt) ? new Date(r.startedAt) : now;
  const pieces = splitByDay(r.startedAt, end.toISOString(), tz);
  if (!pieces.length) {
    changes.updates.push({ id: r.id, patch: { endedAt: end.toISOString(), seconds: 0 } });
    return;
  }
  pieces.forEach((p, i) => {
    const fields = { day: p.day, endedAt: p.end.toISOString(), seconds: p.seconds };
    if (i === 0) changes.updates.push({ id: r.id, patch: fields });
    else changes.inserts.push({ id: uuidFrom(`${r.id}:${p.day}`), taskId: r.taskId, subtaskId: r.subtaskId ?? null, title: r.title, context: r.context, kind: 'timer', startedAt: p.start.toISOString(), ...fields });
  });
}

/**
 * Changes that stop running timers at `now`.
 * which: 'all' (default), a single key (timeKey), or an array of keys.
 */
export function stopTimer(entries, now, tz, newId, which = 'all') {
  const changes = { inserts: [], updates: [] };
  const keys = which === 'all' ? null : new Set(Array.isArray(which) ? which : [which]);
  for (const r of runningEntries(entries)) if (!keys || keys.has(entryKey(r))) stopOne(r, now, tz, changes);
  return changes;
}

/**
 * Changes that start a timer at `now`. `task` is { id, title, context, subtaskId? }: with
 * subtaskId it's that subtask's own timer. stop: which running timers to stop first:
 * 'all' (default), 'none' (run alongside them), or an array of keys.
 */
export function startTimer(entries, task, now, tz, newId, { stop = 'all' } = {}) {
  const subtaskId = task.subtaskId ?? null;
  const key = timeKey(task.id, subtaskId);
  if (runningEntries(entries).some((r) => entryKey(r) === key)) return { inserts: [], updates: [] };
  const changes = stop === 'none' ? { inserts: [], updates: [] } : stopTimer(entries, now, tz, newId, stop);
  changes.inserts.push({
    id: newId(), taskId: task.id, subtaskId, title: task.title, context: task.context ?? null, kind: 'timer',
    day: localParts(now, tz).date, startedAt: now.toISOString(), endedAt: null, seconds: 0,
  });
  return changes;
}

/** Apply start/stop/adjust changes to a list of entries (what the app shows straight away). */
export function applyChanges(entries, changes) {
  const byId = new Map(entries.map((e) => [e.id, { ...e }]));
  for (const u of changes.updates) if (byId.has(u.id)) Object.assign(byId.get(u.id), u.patch);
  for (const i of changes.inserts) byId.set(i.id, { ...i });
  return [...byId.values()];
}

/**
 * Seconds per day per task or subtask: { day: { key: { key, taskId, subtaskId, title, context, seconds } } }
 * (key from timeKey). Includes the running timer up to `now`. Subtask time is kept apart from its task's.
 */
export function dayTotals(entries, now, tz) {
  const out = {};
  const add = (day, e, sec) => {
    const d = (out[day] ||= {});
    const k = entryKey(e);
    const t = (d[k] ||= { key: k, taskId: e.taskId, subtaskId: e.subtaskId ?? null, title: e.title, context: e.context, seconds: 0 });
    t.seconds += sec;
  };
  for (const e of entries) {
    if (e.kind === 'timer' && !e.endedAt) {
      for (const p of splitByDay(e.startedAt, (now > new Date(e.startedAt) ? now : new Date(e.startedAt)).toISOString(), tz)) add(p.day, e, p.seconds);
      if (!out[e.day]?.[entryKey(e)]) add(e.day, e, 0); // just started: still listed
    } else {
      add(e.day, e, e.seconds || 0);
    }
  }
  for (const d of Object.values(out)) for (const t of Object.values(d)) t.seconds = Math.max(0, t.seconds);
  return out;
}

export const taskDaySeconds = (entries, taskId, day, now, tz, subtaskId = null) =>
  dayTotals(entries, now, tz)[day]?.[timeKey(taskId, subtaskId)]?.seconds || 0;

/** Changes that make a task's (or, with task.subtaskId, a subtask's) total on `day` equal `targetSeconds` (via that day's one correction entry). */
export function setDayTotal(entries, task, day, targetSeconds, now, tz, newId) {
  const key = timeKey(task.id, task.subtaskId);
  const isAdj = (e) => e.kind === 'adjust' && entryKey(e) === key && e.day === day;
  const base = taskDaySecondsRaw(entries.filter((e) => !isAdj(e)), key, day, now, tz);
  const delta = Math.round(Math.max(0, targetSeconds)) - base;
  const existing = entries.find(isAdj);
  if (existing) return { inserts: [], updates: [{ id: existing.id, patch: { seconds: delta, title: task.title } }] };
  if (delta === 0) return { inserts: [], updates: [] };
  return {
    inserts: [{ id: newId(), taskId: task.id, subtaskId: task.subtaskId ?? null, title: task.title, context: task.context ?? null, kind: 'adjust', day, startedAt: null, endedAt: null, seconds: delta }],
    updates: [],
  };
}
function taskDaySecondsRaw(entries, key, day, now, tz) {
  let s = 0;
  for (const e of entries) {
    if (entryKey(e) !== key) continue;
    if (e.kind === 'timer' && !e.endedAt) {
      for (const p of splitByDay(e.startedAt, now.toISOString(), tz)) if (p.day === day) s += p.seconds;
    } else if (e.day === day) s += e.seconds || 0;
  }
  return s;
}

/** 1:05 (h:mm), or 1:05:09 with seconds. */
export function formatDuration(sec, { seconds = false } = {}) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return seconds ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${h}:${String(m).padStart(2, '0')}`;
}

/** Read what someone typed as a duration: "1:30", "90", "90m", "1.5h", "1h 30m". Returns seconds or null. */
export function parseDuration(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  let m = t.match(/^(\d+):([0-5]?\d)$/);
  if (m) return (+m[1] * 60 + +m[2]) * 60;
  m = t.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/);
  if (m) return Math.round(parseFloat(m[1]) * 3600 + (m[2] ? +m[2] * 60 : 0));
  m = t.match(/^(\d+)\s*m(?:in(?:utes?|s)?)?$/) || t.match(/^(\d+)$/);
  if (m) return +m[1] * 60;
  return null;
}

/** The Monday-to-Sunday week containing `ymd`. */
export function weekDays(ymd) {
  const monday = addDays(ymd, -((weekdayOf(ymd) + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
