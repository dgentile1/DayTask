// Pure scheduling rules. No I/O here, so every rule is unit-tested in tests/.
import { addDays, localParts, weekdayOf } from './dates.js';
import { normalizeColors } from './colors.js';
import { isDaily, dailyShowsToday, dailyDoneToday } from './daily.js';
export { dailyDoneToday };

export const DEFAULT_SETTINGS = Object.freeze({
  workStart: '08:00',
  workEnd: '17:00',
  workDays: [1, 2, 3, 4, 5], // 0 = Sunday
  timezone: null,            // null = this device's time zone
  granolaAliases: ['Derrick'],
  dueSoonDays: 3,            // remind this many days before a due date (0 = only on the day)
  calendarMode: 'due-only',  // 'due-only' | 'until-due'
  theme: 'auto',             // 'auto' (follow the device) | 'light' | 'dark'
  dueBannerStart: 'open',    // due-soon banner when the app opens: 'open' | 'hidden' (until Show)
  extendPromptMinutes: 15,   // "Extend day" button appears this long before work ends
  extendVisibleMinutes: 15,  // ...and stays this long before lists switch to Home on their own
  extendDefaultMinutes: 30,  // default time the button adds
  workExtension: null,       // today's extension: { date, endTime: 'HH:MM', ended: bool }
  colors: {},                // custom colours by key (see core/colors.js); missing = default
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!HHMM.test(s.workStart)) s.workStart = DEFAULT_SETTINGS.workStart;
  if (!HHMM.test(s.workEnd)) s.workEnd = DEFAULT_SETTINGS.workEnd;
  if (s.workEnd <= s.workStart) s.workEnd = DEFAULT_SETTINGS.workEnd; // overnight shifts unsupported in MVP
  s.workDays = Array.isArray(s.workDays)
    ? [...new Set(s.workDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort()
    : [...DEFAULT_SETTINGS.workDays];
  if (!Array.isArray(s.granolaAliases)) s.granolaAliases = [...DEFAULT_SETTINGS.granolaAliases];
  s.granolaAliases = s.granolaAliases.map((a) => String(a).trim()).filter(Boolean);
  const soon = Math.round(Number(s.dueSoonDays));
  s.dueSoonDays = Number.isFinite(soon) ? Math.min(30, Math.max(0, soon)) : DEFAULT_SETTINGS.dueSoonDays;
  if (!['due-only', 'until-due'].includes(s.calendarMode)) s.calendarMode = DEFAULT_SETTINGS.calendarMode;
  if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
  if (!['open', 'hidden'].includes(s.dueBannerStart)) s.dueBannerStart = DEFAULT_SETTINGS.dueBannerStart;
  const mins = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  s.extendPromptMinutes = mins(s.extendPromptMinutes, 1, 120, DEFAULT_SETTINGS.extendPromptMinutes);
  s.extendVisibleMinutes = mins(s.extendVisibleMinutes, 1, 240, DEFAULT_SETTINGS.extendVisibleMinutes);
  s.extendDefaultMinutes = mins(s.extendDefaultMinutes, 5, 480, DEFAULT_SETTINGS.extendDefaultMinutes);
  const x = s.workExtension;
  s.workExtension = x && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && HHMM.test(x.endTime)
    ? { date: x.date, endTime: x.endTime, ended: !!x.ended } : null;
  s.colors = normalizeColors(s.colors);
  return s;
}

export function resolveTimeZone(settings) {
  return settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function nextWorkday(ymd, workDays) {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(ymd, i);
    if (workDays.includes(weekdayOf(d))) return d;
  }
  return addDays(ymd, 1); // no work days configured
}

/**
 * Where "now" sits relative to work hours.
 *  mode     'work' during work hours, otherwise 'home' (home tasks go on top)
 *  workDate the date unfinished work tasks belong to: today until work ends,
 *           then the next work day.
 */
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHHMM = (min) => { const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min))); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/**
 * Where "now" sits relative to work hours.
 *  mode       'work' during work hours, otherwise 'home' (home tasks go on top)
 *  workDate   the date unfinished work tasks belong to: today until work ends, then the next work day
 *  workEnd    today's end of work: the setting, or the extended time if the day was extended
 *  switchAt   when the lists actually switch to Home today: the "Extend day" button appears
 *             extendPromptMinutes before workEnd and stays extendVisibleMinutes; when it goes, Home
 *             goes on top. With the two equal that's exactly workEnd. Ending a day early switches at once.
 *  showExtend whether the "Extend day" button is up right now
 */
export function scheduleState(instant, settings) {
  const s = normalizeSettings(settings);
  const now = localParts(instant, resolveTimeZone(s));
  const isWorkday = s.workDays.includes(now.weekday);
  const ext = s.workExtension && s.workExtension.date === now.date ? s.workExtension : null;
  const workEnd = ext ? ext.endTime : s.workEnd;
  const promptAt = toMin(workEnd) - s.extendPromptMinutes;
  const switchMin = ext?.ended ? toMin(workEnd) : promptAt + s.extendVisibleMinutes;
  const switchAt = switchMin >= 24 * 60 ? '24:00' : toHHMM(switchMin);
  const t = toMin(now.time);
  const isWorkTime = isWorkday && now.time >= s.workStart && now.time < switchAt;
  const workDayStillOpen = isWorkday && now.time < switchAt;
  return {
    today: now.date,
    time: now.time,
    isWorkday,
    isWorkTime,
    beforeWork: isWorkday && now.time < s.workStart,
    workDayOver: isWorkday && now.time >= switchAt, // today's work day has ended (lists switched to Home)
    mode: isWorkTime ? 'work' : 'home',
    workDate: workDayStillOpen ? now.date : nextWorkday(now.date, s.workDays),
    workEnd,
    switchAt,
    extended: !!ext && !ext.ended,
    showExtend: isWorkTime && !ext?.ended && t >= promptAt,
  };
}

/** The extension to save when "Extend day" is pressed with `minutes`. */
export function extendWorkDay(settings, instant, minutes) {
  const st = scheduleState(instant, settings);
  const base = Math.max(toMin(st.workEnd), toMin(st.time));
  return { date: st.today, endTime: toHHMM(base + minutes), ended: false };
}

/** The extension to save when "Switch to Home tasks" is chosen: today's work day ends now. */
export function endWorkDayNow(settings, instant) {
  const st = scheduleState(instant, settings);
  return { date: st.today, endTime: st.time, ended: true };
}

/** True when an extension is the only reason Work is still on top (so reopening the app should ask). */
export function extensionKeepsWorkOnTop(instant, settings) {
  const s = normalizeSettings(settings);
  const withExt = scheduleState(instant, s);
  const without = scheduleState(instant, { ...s, workExtension: null });
  return withExt.extended && withExt.mode === 'work' && without.mode === 'home';
}

// Due dates are deadlines and are never changed automatically. Work hours only
// decide which list is shown first (see buildTodayView).

const NO_DUE = '9999-12-31'; // tasks without a due date sort after dated ones
const dueKey = (t) => t.dueDate || NO_DUE;

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
}

/**
 * How close a task is to its due date.
 * level: 'none' (no due date) | 'later' | 'soon' (within dueSoonDays) | 'today' | 'overdue'
 * days:  days until due (negative when overdue)
 */
export function dueStatus(task, today, dueSoonDays) {
  if (!task.dueDate) return { level: 'none', days: null };
  const days = daysBetween(today, task.dueDate);
  if (days < 0) return { level: 'overdue', days };
  if (days === 0) return { level: 'today', days };
  if (days <= dueSoonDays) return { level: 'soon', days };
  return { level: 'later', days };
}

/**
 * Everything that needs a reminder today: open tasks and open subtasks (of open tasks)
 * that are overdue, due today, or inside the window. Most urgent first; high priority
 * ahead of normal on the same date.
 * Each item: { task, subtask|null, title, dueDate, priority }.
 */
export function dueSoonItems(tasks, today, dueSoonDays) {
  const hot = (x) => ['overdue', 'today', 'soon'].includes(dueStatus(x, today, dueSoonDays).level);
  const items = [];
  for (const t of tasks) {
    if (t.completedAt || isDaily(t)) continue;
    if (hot(t)) items.push({ task: t, subtask: null, title: t.title, dueDate: t.dueDate, priority: t.priority });
    for (const st of t.subtasks || []) {
      if (!st.done && hot(st)) items.push({ task: t, subtask: st, title: st.title, dueDate: st.dueDate, priority: st.priority });
    }
  }
  const rank = (i) => (i.priority === 'high' ? 0 : 1);
  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || rank(a) - rank(b) || a.task.sortKey - b.task.sortKey);
}

/**
 * Carried over: an open task (or an open subtask of it) that wasn't finished in time.
 * Work tasks carry over once work hours end on the due date; home tasks once the date
 * has passed. Nothing is rewritten: it stops as soon as the item is checked off or its
 * due date is moved later.
 * Returns { carried: boolean, since: 'YYYY-MM-DD' | null } (since = the earliest late date).
 */
export function carryInfo(task, state) {
  if (task.completedAt || isDaily(task)) return { carried: false, since: null };
  const dates = [task.dueDate, ...(task.subtasks || []).filter((s) => !s.done).map((s) => s.dueDate)].filter(Boolean);
  if (!dates.length) return { carried: false, since: null };
  const earliest = dates.sort()[0];
  const late = earliest < state.today || (task.context === 'work' && earliest === state.today && state.workDayOver);
  return late ? { carried: true, since: earliest } : { carried: false, since: null };
}

/** List order: carried-over tasks on top (most overdue first, then your order), then everything else in your order. */
export function listOrder(tasks, state) {
  const info = new Map(tasks.map((t) => [t.id, carryInfo(t, state)]));
  return [...tasks].sort((a, b) => {
    const ia = info.get(a.id), ib = info.get(b.id);
    if (ia.carried !== ib.carried) return ia.carried ? -1 : 1;
    if (ia.carried && ia.since !== ib.since) return ia.since.localeCompare(ib.since);
    return bySortKey(a, b);
  });
}

/** Drag group: tasks can only be dragged among others in the same group, so carried-over ones stay on top. */
export function dragGroup(task, state) {
  const c = carryInfo(task, state);
  return c.carried ? `carried:${c.since}` : 'normal';
}

/** A task with a start date joins the Tasks list on that day; until then it's only on the Calendar. */
export const hasStarted = (task, today) => !task.startDate || task.startDate <= today;

/** Open tasks that need a reminder today, most urgent first. */
export function dueSoonTasks(tasks, today, dueSoonDays) {
  return tasks
    .filter((t) => !t.completedAt && ['overdue', 'today', 'soon'].includes(dueStatus(t, today, dueSoonDays).level))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.sortKey - b.sortKey);
}

export const bySortKey = (a, b) => a.sortKey - b.sortKey || String(a.id).localeCompare(String(b.id));

/** Open tasks in the same list (work / home / unsorted), in manual order. */
export function listSiblings(tasks, context, excludeId = null) {
  return tasks
    .filter((t) => !t.completedAt && !isDaily(t) && (t.context ?? null) === (context ?? null) && t.id !== excludeId)
    .sort(bySortKey);
}

/**
 * Initial placement: before the first task in the list that is due later,
 * or due the same day with lower priority. After that the user's drag order wins.
 */
export function initialSortKey(task, siblings) {
  if (siblings.length === 0) return 1000;
  const idx = siblings.findIndex((s) =>
    dueKey(s) > dueKey(task) ||
    (dueKey(s) === dueKey(task) && task.priority === 'high' && s.priority !== 'high'));
  if (idx === -1) return siblings[siblings.length - 1].sortKey + 1000;
  if (idx === 0) return siblings[0].sortKey - 1000;
  return (siblings[idx - 1].sortKey + siblings[idx].sortKey) / 2;
}

/** Key for a task dropped between two neighbours (either may be null). */
export function sortKeyBetween(aboveKey, belowKey) {
  if (aboveKey == null && belowKey == null) return { key: 1000, renormalize: false };
  if (aboveKey == null) return { key: belowKey - 1000, renormalize: false };
  if (belowKey == null) return { key: aboveKey + 1000, renormalize: false };
  const key = (aboveKey + belowKey) / 2;
  return { key, renormalize: Math.abs(belowKey - aboveKey) < 1e-6 };
}

/** Evenly re-spaced keys for a list already in the desired order. */
export function renormalizeKeys(orderedTasks) {
  return orderedTasks.map((t, i) => ({ id: t.id, sortKey: (i + 1) * 1000 }));
}

/**
 * Everything the task screen shows, already ordered. Every open task is listed
 * from the moment it is added until it is checked off, whatever its due date.
 * During work hours Work comes first; otherwise Home does. Within each list,
 * carried-over tasks are pinned to the top.
 */
export function buildTodayView(tasks, state, { includeNotStarted = false } = {}) {
  // The Calendar passes includeNotStarted: a day's list there includes tasks starting that day.
  const started = (t) => includeNotStarted || hasStarted(t, state.today);
  const open = tasks.filter((t) => !t.completedAt && !isDaily(t) && started(t));
  const later = tasks.filter((t) => !t.completedAt && !isDaily(t) && !started(t));
  // Daily tasks: their own section at the top of Work / Home, checked ones stay (crossed off) for the day.
  const daily = tasks.filter((t) => !t.completedAt && dailyShowsToday(t, state)).sort(bySortKey);
  return {
    startsLater: later.sort((a, b) => a.startDate.localeCompare(b.startDate) || bySortKey(a, b)),
    order: state.mode === 'work' ? ['work', 'home'] : ['home', 'work'],
    dailyWork: daily.filter((t) => t.context === 'work'),
    dailyHome: daily.filter((t) => t.context !== 'work'),
    dailyDone: (list) => list.filter((t) => dailyDoneToday(t, state.today)).length,
    work: listOrder(open.filter((t) => t.context === 'work'), state),
    home: listOrder(open.filter((t) => t.context === 'home'), state),
    unsorted: listOrder(open.filter((t) => !t.context), state),
    done: tasks.filter((t) => t.completedAt && t.completedOn === state.today)
      .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt))),
  };
}

/**
 * Open tasks the calendar shows on `day`.
 *  'due-only'  : only on the due date.
 *  'until-due' : every day from the day it was added through its due date. An overdue
 *                open task keeps showing through today, since it's still on your list.
 * A subtask's due date counts too. A task with no due date of its own is on today every
 * day until it's checked off (and in 'until-due' mode on each day since it was added).
 * A start date puts a task on that day and keeps it off every earlier day (in "every day"
 * mode the run begins on the start date instead of the day it was added).
 * After work hours (or on a day off) the next work day also shows every unfinished task
 * without a due date and every carried-over task, since that's tomorrow's list.
 */
export function tasksForDay(tasks, day, { mode, today, timeZone, workDate = today, workDayOver = false }) {
  // Once today's work hours are over (or on a day off), the next work day previews
  // what will be on the list then: everything without a due date, plus anything carried over.
  const nextWorkDay = workDate > today ? workDate : null;
  return tasks.filter((t) => {
    if (t.completedAt || isDaily(t)) return false; // daily tasks would be on every day: not on the calendar
    // A start date puts the task on that day, and nowhere earlier.
    if (t.startDate && day === t.startDate) return true;
    if (t.startDate && day < t.startDate) return false;
    if (day === nextWorkDay && (!t.dueDate || carryInfo(t, { today, workDayOver }).carried)) return true;
    // No due date of its own: it comes along to every new day until it's checked off,
    // so it's always on today (and, in "every day" mode, on each day since it was added).
    if (!t.dueDate && day === today) return true;
    // A task belongs on the calendar on its own due date and on each open subtask's due date.
    const dates = [t.dueDate, ...(t.subtasks || []).filter((st) => !st.done).map((st) => st.dueDate)].filter(Boolean);
    const firstDay = t.startDate || (t.createdAt ? localParts(new Date(t.createdAt), timeZone).date : null);
    if (!dates.length) {
      if (mode !== 'until-due') return false;
      return day >= (firstDay || today) && day <= today;
    }
    if (mode !== 'until-due') return dates.includes(day);
    const sorted = [...dates].sort();
    const last = sorted[sorted.length - 1];
    const end = last < today ? today : last;
    return day >= (firstDay || sorted[0]) && day <= end;
  });
}

/**
 * Saving new work hours: a later end time replaces today's extension if it's past it,
 * including an earlier "switch to Home" (otherwise that choice would block the new hours).
 */
export function applyWorkHoursChange(prev, next, instant) {
  const n = normalizeSettings(next);
  const p = normalizeSettings(prev);
  const today = scheduleState(instant, n).today;
  const ext = n.workExtension;
  if (ext && ext.date === today && n.workEnd > p.workEnd && n.workEnd > ext.endTime) return { ...n, workExtension: null };
  return n;
}

/**
 * True when a change of settings (not the clock) would move Work back to the top right now:
 * the day had switched to Home and the pushed-out end puts us back in work hours.
 */
export function workComesBack(prev, next, instant) {
  const a = scheduleState(instant, prev);
  const b = scheduleState(instant, next);
  return a.mode === 'home' && b.mode === 'work' && a.isWorkday && !a.beforeWork;
}

/**
 * Daily tasks the Calendar shows on `day`: every day they repeat (all days, or the work
 * days in settings), from the day they were added (or their start date) onward.
 */
export function dailyForDay(tasks, day, { timeZone, workDays }) {
  const wd = weekdayOf(day);
  return tasks.filter((t) => {
    if (t.completedAt || !isDaily(t)) return false;
    if (t.repeat.days === 'work' && !workDays.includes(wd)) return false;
    const first = t.startDate || (t.createdAt ? localParts(new Date(t.createdAt), timeZone).date : null);
    return !first || day >= first;
  }).sort(bySortKey);
}
