import * as store from './data/store.js'; // sign-in and live updates
import * as sync from './data/sync.js';   // all task/settings reads and writes (offline-first)
import {
  normalizeSettings, scheduleState, buildTodayView, listSiblings, dueStatus, dueSoonItems, tasksForDay, dailyForDay, carryInfo, dragGroup, isAppTask, contextLabel, extendWorkDay, endWorkDayNow, extensionKeepsWorkOnTop, applyWorkHoursChange, workComesBack,
  initialSortKey, sortKeyBetween, renormalizeKeys, bySortKey, resolveTimeZone,
} from './core/schedule.js';
import { addDays, monthGrid, formatDay, formatClock } from './core/dates.js';
import {
  addSubtask, setSubtaskDone, renameSubtask, removeSubtask, reorderSubtasks, subtaskProgress, updateSubtask, nextDueSubtask, taskAsSubtasks, mergeNotes, sortSubtasks, subtaskGroup, cleanStatus, statusSuggestions,
} from './core/subtasks.js';
import { runGranolaImport } from './integrations/granola/importer.js';
import { host } from './host.js';
import { applyTheme, applyCachedTheme, activeTheme, onThemeChange } from './theme.js';
import { isDaily, dailyDoneToday, dailySubtasks, defaultRepeat } from './core/daily.js';
import {
  startTimer, stopTimer, applyChanges, runningEntry, dayTotals, taskDaySeconds, setDayTotal, autoStopAt, timeKey, entryKey,
  formatDuration, parseDuration, weekDays,
} from './core/timer.js';
import { COLOR_KEYS, COLOR_LABELS, DEFAULT_COLORS } from './core/colors.js';

// ---------------------------------------------------------------- state
const state = {
  settings: normalizeSettings({}),
  sched: null,
  tasks: [],
  view: 'today',
  expandedId: null,
  online: false,
  entries: [],         // time entries (last 9 weeks + anything running)
  timeWeek: null,      // Monday of the week shown on the Time tab
  timeEdit: null,      // { day, taskId } being edited on the Time tab
  timeAddDay: null,    // day with the "Add time" row open
  sync: sync.status(),
  topMost: false,
  cal: { year: 0, month0: 0, selected: null },
  addCtx: null,
  addPrio: 'normal',
  importDraft: { text: '', title: '', date: '' },
  importResult: null,
  importBusy: false,
};
let dragging = false;
let pointerHeld = false; // finger/mouse down on a drag handle: don't redraw the list under it
let settingsDirty = false;   // unsaved edits on the Settings screen: don't redraw it under the user
let focusAfterRender = null;
const subDrafts = {};
const statusOpen = new Set(); // 'task:<id>' / 'sub:<id>:<subId>' — Status toggled on, nothing typed yet
const showTaskStatus = (t) => !!t.status || statusOpen.has(`task:${t.id}`);
const showSubStatus = (t, s) => !!s.status || statusOpen.has(`sub:${t.id}:${s.id}`); // half-typed "Add a subtask" title/date per task, so a sync redraw can't wipe them // selector to refocus after a re-render (rapid subtask entry)

// Which tasks have their subtasks folded away. Per device, kept across launches.
const FOLDED_KEY = 'daytask.foldedSubtasks';
const folded = new Set((() => { try { return JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]'); } catch { return []; } })());
function setFolded(id, isFolded) {
  if (isFolded) folded.add(id); else folded.delete(id);
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])); } catch { /* storage unavailable */ }
}
let renderPending = false;
let unsubscribe = null;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const find = (id) => state.tasks.find((t) => t.id === id);

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = esc(msg) + (action ? ` <button type="button">${esc(action.label)}</button>` : '');
  if (action) el.querySelector('button').onclick = () => { el.classList.remove('show'); action.run(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 3500);
}
async function guarded(fn) {
  try { await fn(); } catch (err) {
    console.error(err);
    toast(`Couldn't save: ${err.message}. Reloading your list.`);
    await reload().catch(() => {});
  }
}

// ---------------------------------------------------------------- data flow
// Every change is saved on this device at once and sent to Supabase when there's a
// connection (data/sync.js). A refresh that overlaps a send is discarded and retried,
// so it can't paint older server data over a change that's just been made.
const db = sync;
let userId = null;
let loadedOnce = false;

async function reload() {
  if (sync.isSending()) { scheduleReload(); return; }
  const seq = sync.writeSeq();
  const today = scheduleState(new Date(), state.settings).today;
  const loaded = await sync.loadAll(today);
  if (sync.isSending() || seq !== sync.writeSeq()) { scheduleReload(); return; }
  const settings = normalizeSettings(loaded.settings);
  const tasks = loaded.tasks;
  state.entries = loaded.entries || [];
  const prevSettings = loadedOnce ? state.settings : null;
  loadedOnce = true;
  state.settings = settings;
  if (!bannerStartApplied) { dueBannerOpen = settings.dueBannerStart !== 'hidden'; bannerStartApplied = true; }
  if (!(state.view === 'settings' && settingsDirty)) applyTheme(state.settings);
  state.sched = scheduleState(new Date(), state.settings);
  state.tasks = tasks;
  await applySchedule();
  render();
  // Hours pushed out on another device after this one switched to Home: ask.
  if (prevSettings) askIfWorkComesBack(prevSettings, settings);
}

/** Recompute the clock state (work or home mode) and send the daily due-date reminder. */
async function applySchedule() {
  const prevMode = state.sched?.mode;
  state.sched = scheduleState(new Date(), state.settings);
  if (prevMode && prevMode !== state.sched.mode && !state.addCtxTouched) state.addCtx = state.sched.mode;
  maybeSendDailyReminder();
  maybeAutoStopTimer();
}

// ---------------------------------------------------------------- due-date reminders
// Nothing here is saved: every time the app is opened the banner starts open and the
// desktop notification is shown again. Within one run, Hide stays hidden until Show.
let dueBannerOpen = true;
let bannerStartApplied = false; // the "open or hidden when the app opens" setting is applied once per launch
let notifiedOn = null; // date of the last Windows notification in this run of the app

function dueLabel(t) {
  const st = dueStatus(t, state.sched.today, state.settings.dueSoonDays);
  const n = Math.abs(st.days ?? 0);
  switch (st.level) {
    case 'overdue': return { cls: 'due-overdue', text: `Overdue by ${n} day${n === 1 ? '' : 's'}` };
    case 'today': return { cls: 'due-today', text: 'Due today' };
    case 'soon': return { cls: 'due-soon', text: n === 1 ? 'Due tomorrow' : `Due in ${n} days` };
    case 'later': return { cls: 'due-later', text: `Due ${formatDay(t.dueDate)}` };
    default: return null;
  }
}

/**
 * Desktop only. One Windows notification each time the app is opened, never otherwise:
 * not when the window is restored from minimized, not on a new day while it stays open,
 * and not when tasks are added or edited.
 */
function maybeSendDailyReminder() {
  if (!host.available || !state.sched || notifiedOn !== null) return;
  const { today } = state.sched;
  notifiedOn = today;
  const list = dueSoonItems(state.tasks, today, state.settings.dueSoonDays);
  if (!list.length) return;
  const lines = list.slice(0, 4).map((i) =>
    `${i.priority === 'high' ? '(High) ' : ''}${i.subtask ? `${i.task.title} › ${i.title}` : i.title}: ${dueLabel(i).text.toLowerCase()}`);
  if (list.length > 4) lines.push(`and ${list.length - 4} more`);
  host.notify(`${list.length} item${list.length === 1 ? '' : 's'} due soon`, lines.join('\n'));
}

function dueBannerHtml() {
  const today = state.sched.today;
  const list = dueSoonItems(state.tasks, today, state.settings.dueSoonDays);
  if (!list.length) return '';
  const overdue = list.filter((i) => i.dueDate < today).length;
  const heading = overdue
    ? `${list.length} due soon, ${overdue} overdue`
    : `${list.length} item${list.length === 1 ? '' : 's'} due soon`;
  return `
  <div class="due-banner${overdue ? ' has-overdue' : ''}${dueBannerOpen ? '' : ' collapsed'}" role="status">
    <div class="due-banner-head">
      <strong>${esc(heading)}</strong>
      <button class="link" data-act="toggle-due-banner" aria-expanded="${dueBannerOpen}" aria-controls="due-list">${dueBannerOpen ? 'Hide' : 'Show'}</button>
    </div>
    <ul id="due-list"${dueBannerOpen ? '' : ' hidden'}>${list.map((i) => {
      const d = dueLabel(i);
      return `<li><span class="due-item">
          <button class="link-plain" data-act="open-task" data-id="${esc(i.task.id)}">${esc(i.title)}</button>
          ${i.priority === 'high' ? '<span class="flag-inline">High</span>' : ''}
          ${i.subtask ? `<span class="parent">in ${esc(i.task.title)}</span>` : ''}
        </span>
        <span class="${d.cls}">${esc(d.text)}</span></li>`;
    }).join('')}</ul>
  </div>`;
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => guarded(reload), 350);
}

// ---------------------------------------------------------------- mutations
async function addTask(fields) {
  const context = fields.context ?? null;
  const dailySibs = state.tasks.filter((x) => isDaily(x) && !x.completedAt && x.context === context).sort(bySortKey);
  const sortKey = fields.repeat
    ? (dailySibs.length ? dailySibs[dailySibs.length - 1].sortKey + 1000 : 1000) // new daily tasks go last in Daily
    : initialSortKey(fields, listSiblings(state.tasks, context));
  const saved = await db.insertTask({ ...fields, context, sortKey, source: fields.source || 'manual' });
  state.tasks.push(saved);
  await applySchedule();
  render();
  return saved;
}

async function patchTask(id, patch) {
  const t = find(id);
  if (!t) return;
  if (patch.context === 'app' && t.context !== 'app') {
    if (t.repeat) patch.repeat = null;                    // App tasks don't repeat
    if (runningTaskId() === id) await stopRunningTimer(); // ...or have timers
  }
  if ('context' in patch && patch.context !== t.context) {
    // Moving to the other list: place it there by due date, like a new task.
    patch.sortKey = initialSortKey({ ...t, ...patch }, listSiblings(state.tasks, patch.context, id));
  }
  Object.assign(t, patch);
  await applySchedule();
  render();
  await db.updateTask(id, patch);
}

async function changeSubtasks(id, fn, { refocus = null } = {}) {
  const t = find(id);
  if (!t) return;
  const current = isDaily(t) ? dailySubtasks(t, state.sched.today) : (t.subtasks || []);
  const before = subtaskProgress(current);
  const next = sortSubtasks(fn(current));
  t.subtasks = next;
  const patch = { subtasks: next };
  if (isDaily(t)) { t.repeat = { ...t.repeat, subsOn: state.sched.today }; patch.repeat = t.repeat; } // ticks count for today
  if (refocus) { focusAfterRender = refocus; render({ force: true }); } else render();
  await db.updateTask(id, patch);
  const after = subtaskProgress(next);
  if (after.allDone && !before.allDone && !t.completedAt && !dailyDoneToday(t, state.sched.today)) {
    toast(`All subtasks done: ${t.title}`, { label: 'Mark task done', run: () => guarded(() => setDone(id, true)) });
  }
}

async function setDone(id, done) {
  const dt = find(id);
  if (done) await stopTimerIfFor(id);
  if (isDaily(dt)) {
    await patchTask(id, { repeat: { ...dt.repeat, doneOn: done ? state.sched.today : null } });
    if (done) toast(`Done for today: ${dt.title}`, { label: 'Undo', run: () => guarded(() => setDone(id, false)) });
    return;
  }
  const patch = done
    ? { completedAt: new Date().toISOString(), completedOn: state.sched.today }
    : { completedAt: null, completedOn: null };
  await patchTask(id, patch);
  if (done) toast(`Done: ${find(id)?.title ?? ''}`, { label: 'Undo', run: () => guarded(() => setDone(id, false)) });
}

async function moveTask(id, aboveId, belowId) {
  const t = find(id);
  const above = aboveId ? find(aboveId) : null;
  const below = belowId ? find(belowId) : null;
  const { key, renormalize } = sortKeyBetween(above?.sortKey ?? null, below?.sortKey ?? null);
  t.sortKey = key;
  let updates = [{ id, sortKey: key }];
  if (renormalize) {
    const sibs = isDaily(t)
      ? state.tasks.filter((x) => isDaily(x) && x.context === t.context).sort(bySortKey)
      : listSiblings(state.tasks, t.context);
    updates = renormalizeKeys(sibs);
    for (const u of updates) find(u.id).sortKey = u.sortKey;
  }
  render();
  await db.updateMany(updates);
}

// ---------------------------------------------------------------- time tracking
const tz = () => resolveTimeZone(state.settings);
const entryId = () => globalThis.crypto?.randomUUID?.() ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** Apply timer changes here at once and queue them for Supabase. */
async function commitTime(changes) {
  if (!changes.inserts.length && !changes.updates.length) return;
  state.entries = applyChanges(state.entries, changes);
  render();
  for (const u of changes.updates) await db.updateEntry(u.id, u.patch);
  for (const i of changes.inserts) await db.insertEntry(i);
}
const runningKey = () => { const r = runningEntry(state.entries); return r ? entryKey(r) : null; };
const runningTaskId = () => runningEntry(state.entries)?.taskId ?? null;
/** What a timer is for: the task itself, or (with subId) one of its subtasks. */
function timerTarget(taskId, subId = null) {
  const t = find(taskId);
  if (!t) return null;
  const st = subId ? (t.subtasks || []).find((x) => x.id === subId) : null;
  if (subId && !st) return null;
  return { id: t.id, subtaskId: subId, title: st ? st.title : t.title, context: t.context };
}
async function startTimerFor(taskId, subId = null) {
  const target = timerTarget(taskId, subId);
  if (target) await commitTime(startTimer(state.entries, target, new Date(), tz(), entryId));
}
/**
 * A timer still running when its work day ends is stopped at that moment (also when the app
 * was closed then: it's stopped at the end time, not when the app is next opened).
 */
function maybeAutoStopTimer() {
  const r = runningEntry(state.entries);
  if (!r || !state.sched) return;
  const at = autoStopAt(r, state.settings, tz());
  if (!at || new Date() < at) return;
  const title = timerLabel(r);
  guarded(async () => {
    await commitTime(stopTimer(state.entries, at, tz(), entryId));
    const when = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz() });
    toast(`Timer stopped at ${when}, the end of work hours: ${title}`);
  });
}

async function stopRunningTimer() { await commitTime(stopTimer(state.entries, new Date(), tz(), entryId)); }
/** Checking off, deleting or nesting a task stops its timer and its subtasks' timers. */
async function stopTimerIfFor(id) { if (runningTaskId() === id) await stopRunningTimer(); }
/** Checking off or deleting a subtask stops its timer. */
async function stopSubTimerIfFor(id, subId) { if (runningKey() === timeKey(id, subId)) await stopRunningTimer(); }
const todaySeconds = (id, subId = null) => taskDaySeconds(state.entries, id, state.sched.today, new Date(), tz(), subId);

/** "Subtask (Task)" for a subtask's timer, the task name for a task's. */
function timerLabel(e) {
  const t = find(e.taskId);
  if (!e.subtaskId) return t?.title ?? e.title;
  const st = (t?.subtasks || []).find((x) => x.id === e.subtaskId);
  return st?.title ?? e.title;
}

function timerButton(t, st = null) {
  const key = timeKey(t.id, st?.id);
  const running = runningKey() === key;
  const secs = todaySeconds(t.id, st?.id);
  const time = running ? formatDuration(secs, { seconds: true }) : secs ? formatDuration(secs) : '';
  const name = st ? st.title : t.title;
  return `<button class="timer-btn${st ? ' sub-timer' : ''}${running ? ' running' : ''}" data-act="timer"${st ? ` data-sub-timer="${esc(st.id)}"` : ''} data-timer-key="${esc(key)}"
    aria-label="${running ? 'Stop timer' : 'Start timer'} for ${esc(name)}" title="${running ? 'Stop timer' : 'Start timer (stops any other)'}"><span class="ti" aria-hidden="true">${running ? '■' : '▶'}</span>${time ? `<span class="tt">${esc(time)}</span>` : ''}</button>`;
}

function bandTimer() {
  const r = runningEntry(state.entries);
  if (!r) return '';
  const title = timerLabel(r);
  return `<button class="band-timer" data-act="timer-stop" title="Stop timer: ${esc(title)}">■ <span class="bt-name">${esc(title)}</span>
    <span class="bt-time" data-live-total>${esc(formatDuration(todaySeconds(r.taskId, r.subtaskId), { seconds: true }))}</span></button>`;
}

/** Once a second: update only the running clock's text (no redraws). */
function tickTimer() {
  const r = runningEntry(state.entries);
  if (!r || !state.sched) return;
  const key = entryKey(r);
  const txt = formatDuration(todaySeconds(r.taskId, r.subtaskId), { seconds: true });
  for (const el of document.querySelectorAll(`[data-timer-key="${CSS.escape(key)}"] .tt, #band [data-live-total], [data-live-time="${CSS.escape(key)}"]`)) el.textContent = txt;
}

async function removeTask(id) {
  await stopTimerIfFor(id);
  const t = find(id);
  state.tasks = state.tasks.filter((x) => x.id !== id);
  state.expandedId = null;
  render();
  await db.deleteTask(id);
  toast(`Deleted: ${t.title}`, {
    label: 'Undo',
    run: () => guarded(async () => {
      const { id: _old, updatedAt, ...rest } = t;
      const saved = await db.insertTask(rest);
      state.tasks.push(saved);
      render();
    }),
  });
}

// ---------------------------------------------------------------- render guard
function isTyping() {
  const a = document.activeElement;
  return !!(a && a.closest('#view, #band') && (a.tagName === 'TEXTAREA' ||
    (a.tagName === 'INPUT' && ['text', 'search', 'email', 'number', 'time', 'tel', 'url', ''].includes(a.type))));
}
function render({ force = false } = {}) {
  if (userId && state.sched) sync.snapshot(userId, state.tasks, state.settings, state.entries);
  if (dragging || pointerHeld || (!force && isTyping())) { renderPending = true; return; }
  renderPending = false;
  renderBand();
  renderAddForm();
  const sugg = document.getElementById('status-suggestions');
  if (sugg) sugg.innerHTML = statusSuggestions(state.tasks).map((x) => `<option value="${esc(x)}"></option>`).join('');
  if (!(state.view === 'settings' && settingsDirty && !force)) renderView();
  const bar = document.querySelector('.topbar');
  if (bar) document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  if (focusAfterRender) { document.querySelector(focusAfterRender)?.focus(); focusAfterRender = null; }
}
document.addEventListener('focusout', () => setTimeout(() => { if (renderPending) render(); }, 0));
document.addEventListener('change', (e) => {
  if (!e.target.matches('#band [data-ext-amount]')) return;
  state.extChoice = e.target.value;
  renderBand();
  if (state.extChoice === 'custom') document.querySelector('[data-ext-custom]')?.select();
});
document.addEventListener('input', (e) => {
  if (e.target.matches('#band [data-ext-custom]')) state.extCustom = e.target.value;
});
document.addEventListener('pointerdown', (e) => { if (e.target.closest('.drag, .sub-drag')) pointerHeld = true; }, true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    setTimeout(() => { if (renderPending && !dragging) render(); }, 0);
  }, true);
}

// ---------------------------------------------------------------- band + add form
const fmtDur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`);
const EXTEND_CHOICES = [15, 30, 45, 60, 90, 120];

function extendControls() {
  const def = state.settings.extendDefaultMinutes;
  const choice = state.extChoice || 'default';
  const opts = [`<option value="default"${choice === 'default' ? ' selected' : ''}>+${esc(fmtDur(def))} (default)</option>`,
    ...EXTEND_CHOICES.filter((m) => m !== def).map((m) => `<option value="${m}"${String(choice) === String(m) ? ' selected' : ''}>+${esc(fmtDur(m))}</option>`),
    `<option value="custom"${choice === 'custom' ? ' selected' : ''}>Custom…</option>`];
  return `<div class="extend-row">
    <button class="extend-btn" data-act="extend-day">Extend day</button>
    <select data-ext-amount aria-label="How much to add">${opts.join('')}</select>
    ${choice === 'custom' ? `<label class="ext-custom"><input type="number" data-ext-custom min="1" max="480" step="5" value="${esc(state.extCustom ?? def)}" aria-label="Minutes to add"> min</label>` : ''}
  </div>`;
}

function renderBand() {
  // Don't redraw under someone typing a custom number of minutes.
  const a = document.activeElement;
  if (a && a.closest('#band') && a.tagName === 'INPUT') { renderPending = true; return; }
  const s = state.sched;
  const set = state.settings;
  let modeText;
  if (s.isWorkTime && s.time >= s.workEnd) modeText = `Work hours ended ${formatClock(s.workEnd)}. Home at ${formatClock(s.switchAt)}`;
  else if (s.isWorkTime && s.extended) modeText = `Work hours until ${formatClock(s.workEnd)} (extended)`;
  else if (s.isWorkTime) modeText = `Work hours until ${formatClock(s.workEnd)}`;
  else if (s.beforeWork) modeText = `Before work, starts ${formatClock(set.workStart)}`;
  else modeText = `After hours. Work list is back ${s.workDate === addDays(s.today, 1) ? 'tomorrow' : formatDay(s.workDate, { weekday: 'long' })}`;
  const band = $('#band');
  band.className = `band ${s.mode}`;
  document.body.classList.toggle('mode-home', s.mode === 'home');
  band.innerHTML = `
    <div class="day">${esc(formatDay(s.today, { weekday: 'long', month: 'short', day: 'numeric' }))}</div>
    <div class="mode">${esc(modeText)}</div>
    ${s.showExtend ? extendControls() : ''}
    <div class="sync-slot" aria-live="polite">${syncPill()}</div>
    <div class="tools">
      ${bandTimer()}
      <span class="conn ${state.online && state.sync.online ? '' : 'off'}" title="${state.online && state.sync.online ? 'Live sync on' : 'Not connected'}"></span>
      ${host.available ? `<button class="pin" data-act="pin" aria-pressed="${state.topMost}" title="Ctrl+Shift+T">${state.topMost ? 'On top' : 'Keep on top'}</button>` : ''}
    </div>`;
  document.querySelector('meta[name=theme-color]').content =
    getComputedStyle(document.documentElement).getPropertyValue(s.mode === 'work' ? '--work' : '--home').trim();
}

// Short status in a fixed spot (right column, level with the work-hours line) so it never
// changes the header's height. "Syncing" only shows if sending takes over a second.
let syncSlow = false;
let syncSlowTimer = null;
function trackSyncSpeed(st) {
  if (st.online && st.pending) {
    if (!syncSlowTimer && !syncSlow) syncSlowTimer = setTimeout(() => { syncSlow = true; syncSlowTimer = null; renderBand(); }, 1200);
  } else {
    clearTimeout(syncSlowTimer); syncSlowTimer = null; syncSlow = false;
  }
}

function syncPill() {
  const { online, pending } = state.sync;
  const n = `${pending} change${pending === 1 ? '' : 's'}`;
  if (!online) {
    const title = pending ? `Offline: ${n} saved on this device, sent when you reconnect` : 'Offline: changes are saved on this device';
    return `<span class="sync-pill" title="${esc(title)}">Offline${pending ? ` · ${pending} saved` : ''}</span>`;
  }
  return pending && syncSlow ? `<span class="sync-pill" title="${esc(`Sending ${n}`)}">Syncing ${pending}</span>` : '';
}

function renderAddForm() {
  const form = $('#add');
  form.hidden = !(state.view === 'today' || state.view === 'calendar');
  if (!state.addCtx) state.addCtx = state.sched.mode;
  for (const b of form.querySelectorAll('[data-ctx]')) b.setAttribute('aria-pressed', String(b.dataset.ctx === state.addCtx));
  form.querySelector('[data-prio]').setAttribute('aria-pressed', String(state.addPrio === 'high'));
  if (state.addCtx === 'app') state.addDaily = false; // App tasks don't repeat
  form.querySelector('[data-daily]').hidden = state.addCtx === 'app';
  form.querySelector('[data-daily]').setAttribute('aria-pressed', String(!!state.addDaily));
  form.querySelector('[data-status-toggle]').setAttribute('aria-pressed', String(!!state.addStatus));
  form.elements.status.hidden = !state.addStatus;
  form.querySelector('.due-pick').hidden = !!state.addDaily; // daily tasks have no due or start date
  form.elements.due.min = state.sched.today;
  form.elements.start.min = addDays(state.sched.today, 1);
  form.querySelector('.start-pick').hidden = state.view !== 'calendar' || !!state.addDaily;
}

function wireAddForm() {
  const form = $('#add');
  form.addEventListener('click', (e) => {
    const ctx = e.target.closest('[data-ctx]');
    if (ctx) { state.addCtx = ctx.dataset.ctx; state.addCtxTouched = true; renderAddForm(); }
    if (e.target.closest('[data-prio]')) { state.addPrio = state.addPrio === 'high' ? 'normal' : 'high'; renderAddForm(); }
    if (e.target.closest('[data-daily]')) { state.addDaily = !state.addDaily; renderAddForm(); }
    if (e.target.closest('[data-status-toggle]')) {
      state.addStatus = !state.addStatus;
      if (!state.addStatus) form.elements.status.value = '';
      renderAddForm();
      if (state.addStatus) form.elements.status.focus();
    }
    if (e.target.closest('[data-toggle-note]')) {
      const note = form.elements.note;
      note.hidden = !note.hidden;
      e.target.textContent = note.hidden ? 'Add note' : 'Hide note';
      if (!note.hidden) note.focus();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = form.elements.title.value.trim();
    if (!title) return;
    const fields = {
      title,
      status: state.addStatus ? cleanStatus(form.elements.status.value) : null,
      note: form.elements.note.value.trim(),
      dueDate: state.addDaily ? null : form.elements.due.value || null,
      repeat: state.addDaily ? defaultRepeat(state.addCtx) : null,
      // Starts: only on the Calendar tab, only for a future day (today or earlier = on the list now).
      startDate: !state.addDaily && state.view === 'calendar' && form.elements.start.value > state.sched.today ? form.elements.start.value : null,
      priority: state.addPrio,
      context: state.addCtx,
    };
    form.elements.title.value = '';
    form.elements.status.value = '';
    state.addStatus = false;
    form.elements.note.value = '';
    form.elements.due.value = ''; // Starts stays on the selected day so several tasks can go there
    form.elements.note.hidden = true;
    form.querySelector('[data-toggle-note]').textContent = 'Add note';
    state.addPrio = 'normal';
    state.addDaily = false;
    guarded(async () => {
      const t = await addTask(fields);
      if (t.repeat) toast(`Added to Daily (${t.repeat.days === 'work' ? 'work days' : 'every day'})`);
      else if (t.startDate) toast(`Added. On your list from ${formatDay(t.startDate)}${t.dueDate ? `, due ${formatDay(t.dueDate)}` : ''}`);
      else if (t.dueDate) toast(`Added, due ${formatDay(t.dueDate)}`);
    });
    form.elements.title.focus();
  });
}

// ---------------------------------------------------------------- task rows
function taskRow(t, { drag = true, showDate = false, showContext = false, grouped = false, dailyDay = null } = {}) {
  const daily = isDaily(t);
  // On the Calendar, a daily task on a day other than today can't be checked off from there.
  const otherDay = daily && dailyDay && dailyDay !== state.sched.today;
  const dailyDone = daily && !otherDay && dailyDoneToday(t, state.sched.today);
  const carry = carryInfo(t, state.sched);
  const ctx = t.context ? `ctx-${t.context}` : 'ctx-none';
  const meta = [];
  if (carry.carried) meta.push('<span class="carried">Carried over</span>');
  if (daily && t.repeat.days === 'work') meta.push('<span class="daily-days">Work days</span>');
  if (!t.completedAt && t.startDate && t.startDate > state.sched.today) meta.push(`<span class="starts">Starts ${esc(formatDay(t.startDate))}</span>`);
  if (t.priority === 'high') meta.push('<span class="flag">High</span>');
  if (showContext && t.context) meta.push(`<span class="ctx-${t.context}">${contextLabel(t.context)}</span>`);
  if (t.completedAt) { if (showDate && t.dueDate) meta.push(`<span>Due ${esc(formatDay(t.dueDate))}</span>`); }
  else if (!grouped && !daily) { const d = dueLabel(t); if (d) meta.push(`<span class="${d.cls}">${esc(d.text)}</span>`); }
  if (!t.completedAt && !t.dueDate && state.expandedId !== t.id) {
    const next = nextDueSubtask(t.subtasks);
    if (next) {
      const d = dueLabel(next);
      meta.push(`<span class="${d.cls} next-sub">Next: ${esc(next.title)}, ${esc(d.text.charAt(0).toLowerCase() + d.text.slice(1))}</span>`);
    }
  }
  if (t.source === 'granola') meta.push('<span class="src">Granola</span>');
  if (t.note && state.expandedId !== t.id) meta.push('<span>Note</span>');
  const open = state.expandedId === t.id;
  const subs = daily ? dailySubtasks(t, otherDay ? dailyDay : state.sched.today) : (t.subtasks || []); // fresh on other days
  const prog = subtaskProgress(subs);
  const isFolded = folded.has(t.id);
  const showSubs = subs.length && !open && !t.completedAt && !dailyDone && !isFolded;
  return `
  <li class="task ${ctx}${t.completedAt ? ' done' : ''}${daily ? ' is-daily' : ''}${dailyDone ? ' daily-done' : ''}${drag ? '' : ' no-drag'}${carry.carried ? ' is-carried' : ''}" data-id="${esc(t.id)}" data-group="${esc(daily ? 'daily' : dragGroup(t, state.sched))}">
    <div class="row">
      ${drag ? '<span class="drag" aria-hidden="true" title="Drag to reorder">⋮⋮</span>' : ''}
      <input type="checkbox" class="check" data-act="done" ${t.completedAt || dailyDone ? 'checked' : ''}${otherDay ? ' disabled title="Daily tasks are checked off on the day"' : ''} aria-label="Mark ${esc(t.title)} done${daily ? ' for today' : ''}">
      <button class="title-btn" data-act="expand" aria-expanded="${open}">
        <span class="t">${esc(t.title)}</span>
        ${meta.length ? `<span class="meta">${meta.join('')}</span>` : ''}
      </button>
      ${!t.completedAt && !dailyDone && !otherDay && !isAppTask(t) ? timerButton(t) : ''}
      ${t.status ? `<button class="status-pill" data-act="edit-status" title="Status: ${esc(t.status)} (tap to change)">${esc(t.status)}</button>` : ''}
      ${prog.total ? `<button class="sub-toggle${prog.allDone ? ' all-done' : ''}" data-act="toggle-subs"
        aria-expanded="${!isFolded}" aria-label="${prog.done} of ${prog.total} subtasks done, ${isFolded ? 'show' : 'hide'} subtasks"
        ${open || t.completedAt || dailyDone ? 'disabled' : ''}>${prog.done}/${prog.total}</button>` : ''}
    </div>
    ${showSubs ? `<ul class="subtasks">${subs.map((s) => `
      <li class="sub${s.done ? ' done' : ''}" data-sub="${esc(s.id)}">
        <label><input type="checkbox" class="sub-check" data-act="sub-done" ${s.done ? 'checked' : ''}${otherDay ? ' disabled' : ''}>
          <span class="sub-body"><span class="sub-title">${esc(s.title)}</span>${subMeta(s)}</span></label>
        ${!s.done && !otherDay && !t.completedAt && !isAppTask(t) ? timerButton(t, s) : ''}
        ${s.status ? `<button class="status-pill sub-status" data-act="edit-sub-status" title="Status: ${esc(s.status)} (tap to change)">${esc(s.status)}</button>` : ''}
      </li>`).join('')}</ul>` : ''}
    ${!t.context && !t.completedAt ? `
      <div class="classify">Which list?
        <button data-act="classify" data-val="work">Work</button>
        <button data-act="classify" data-val="home">Home</button>
        <button data-act="classify" data-val="app">App</button>
      </div>` : ''}
    ${open ? editor(t) : ''}
  </li>`;
}

function subMeta(st) {
  const bits = [];
  if (st.priority === 'high') bits.push('<span class="flag">High</span>');
  if (!st.done) { const d = dueLabel(st); if (d) bits.push(`<span class="${d.cls}">${esc(d.text)}</span>`); }
  else if (st.dueDate) bits.push(`<span>Due ${esc(formatDay(st.dueDate))}</span>`);
  return bits.length ? `<span class="meta">${bits.join('')}</span>` : '';
}

function editor(t) {
  const pressed = (a, b) => `aria-pressed="${a === b}"`;
  return `
    <div class="editor">
      <div class="name-status">
        <label class="name-field">Task<input type="text" data-field="title" value="${esc(t.title)}" maxlength="500"></label>
        ${showTaskStatus(t) ? `<label class="status-field">Status<input type="text" data-field="status" value="${esc(t.status || '')}" list="status-suggestions" maxlength="60" placeholder="e.g. Waiting" autocomplete="off"></label>` : ''}
      </div>
      <label>Note<textarea data-field="note" rows="3" placeholder="Context, links, who asked">${esc(t.note)}</textarea></label>
      <div class="line">
        ${isAppTask(t) ? '' : `<label>Repeats<select data-repeat>
          <option value=""${!isDaily(t) ? ' selected' : ''}>Doesn't repeat</option>
          <option value="all"${isDaily(t) && t.repeat.days === 'all' ? ' selected' : ''}>Every day (Daily)</option>
          <option value="work"${isDaily(t) && t.repeat.days === 'work' ? ' selected' : ''}>Work days only (Daily)</option>
        </select></label>`}
        ${isDaily(t) ? '' : `<label>Starts (optional)<input type="date" data-field="startDate" value="${esc(t.startDate || '')}" title="The day it joins your Tasks list"></label>
        <label>Due (optional)<input type="date" data-field="dueDate" value="${esc(t.dueDate || '')}"></label>`}
        <div class="seg" role="group" aria-label="List">
          <button data-act="ctx" data-val="work" ${pressed(t.context, 'work')}>Work</button>
          <button data-act="ctx" data-val="home" ${pressed(t.context, 'home')}>Home</button>
          <button data-act="ctx" data-val="app" ${pressed(t.context, 'app')}>App</button>
        </div>
        <div class="seg" role="group" aria-label="Priority">
          <button data-act="prio" data-val="normal" ${pressed(t.priority, 'normal')}>Normal</button>
          <button data-act="prio" data-val="high" ${pressed(t.priority, 'high')}>High</button>
        </div>
        <button class="toggle status-toggle" data-act="status-toggle" aria-pressed="${showTaskStatus(t)}" title="Show a status beside the name">Status</button>
      </div>
      <div class="sub-editor">
        <div class="sub-editor-head">Subtasks</div>
        ${(t.subtasks || []).some((x) => x.dueDate) ? '<p class="sub-hint">Kept in due-date order, next one first. Drag to arrange subtasks that share a date.</p>' : ''}
        ${(t.subtasks || []).length ? `<ul class="sub-edit-list" data-for="${esc(t.id)}">${(isDaily(t) ? dailySubtasks(t, state.sched.today) : t.subtasks).map((s) => `
          <li class="sub-edit${s.done ? ' done' : ''}" data-sub="${esc(s.id)}" data-group="${esc(subtaskGroup(s))}">
            <span class="sub-drag" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
            <input type="checkbox" class="sub-check" data-act="sub-done" ${s.done ? 'checked' : ''} aria-label="Done">
            <input type="text" data-sub-title value="${esc(s.title)}" maxlength="500" aria-label="Subtask">
            ${showSubStatus(t, s) ? `<input type="text" data-sub-status value="${esc(s.status || '')}" list="status-suggestions" maxlength="60" placeholder="Status" aria-label="Status for ${esc(s.title)}" autocomplete="off">` : ''}
            <button class="sub-del" data-act="sub-del" aria-label="Remove subtask ${esc(s.title)}">×</button>
            <div class="sub-opts">
              <label class="date-pick">Due <input type="date" data-sub-due value="${esc(s.dueDate || '')}" aria-label="Subtask due date (optional)"></label>
              <button class="toggle" data-act="sub-prio" aria-pressed="${s.priority === 'high'}" title="High priority">High</button>
              <button class="toggle status-toggle" data-act="sub-status-toggle" aria-pressed="${showSubStatus(t, s)}" title="Show a status beside the name">Status</button>
              ${(() => { const d = !s.done && dueLabel(s); return d && d.cls !== 'due-later' ? `<span class="meta"><span class="${d.cls}">${esc(d.text)}</span></span>` : ''; })()}
            </div>
          </li>`).join('')}</ul>` : ''}
        <div class="sub-new">
          <input type="text" data-sub-new="${esc(t.id)}" value="${esc(subDrafts[t.id]?.title || '')}" placeholder="Add a subtask" maxlength="500" aria-label="New subtask">
          <input type="date" data-sub-new-due value="${esc(subDrafts[t.id]?.due || '')}" aria-label="New subtask due date (optional)" title="Due date (optional)">
          <button class="plain" data-act="sub-add">Add</button>
        </div>
      </div>
      <div class="line end">
        <button class="danger" data-act="delete">Delete</button>
        <button class="plain" data-act="collapse">Close</button>
      </div>
    </div>`;
}

function section(key, title, tasks, { secondary = false, emptyText = null, sortable = true, daily = [], dailyDone = 0, dailyDay = null } = {}) {
  if (!tasks.length && !daily.length && !emptyText) return '';
  // Daily tasks: their own block at the top of the list, only once there's at least one.
  const dailyBlock = daily.length ? `
    <div class="daily-block">
      <h3 class="daily-head">Daily <span class="count">${!dailyDay || dailyDay === state.sched.today
        ? `${dailyDone} of ${daily.length} done today` : `${daily.length} daily`}</span></h3>
      <ul class="tasks sortable daily-list" data-list="daily-${key}">${daily.map((t) => taskRow(t, { drag: true, dailyDay })).join('')}</ul>
    </div>` : '';
  return `
  <section class="section${secondary ? ' secondary' : ''}">
    <h2>${esc(title)} <span class="count">${tasks.length || ''}</span></h2>
    ${dailyBlock}
    ${tasks.length
      ? `<ul class="tasks${sortable ? ' sortable' : ''}" data-list="${key}">${tasks.map((t) => taskRow(t, { drag: sortable })).join('')}</ul>`
      : daily.length ? '' : `<p class="empty">${esc(emptyText)}</p>`}
  </section>`;
}

// ---------------------------------------------------------------- views
function renderView() {
  for (const b of document.querySelectorAll('.tabs button')) {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  const view = $('#view');
  if (state.view === 'today') view.innerHTML = todayHtml();
  else if (state.view === 'calendar') view.innerHTML = calendarHtml();
  else if (state.view === 'import') view.innerHTML = importHtml();
  else if (state.view === 'time') view.innerHTML = timeHtml();
  else view.innerHTML = settingsHtml();
  initSortables(view);
  initSubtaskSortables(view);
}

function todayHtml() {
  const v = buildTodayView(state.tasks, state.sched);
  const parts = [dueBannerHtml()];
  if (v.startsLater.length) {
    const first = v.startsLater[0];
    parts.push(`<p class="hint starts-later">${v.startsLater.length === 1
      ? `1 task starts later (${esc(first.title)}, ${esc(formatDay(first.startDate))}).`
      : `${v.startsLater.length} tasks start later, the next on ${esc(formatDay(first.startDate))}.`}
      <button class="link" data-act="go-calendar" data-date="${esc(first.startDate)}">See Calendar</button></p>`);
  }
  if (v.unsorted.length) {
    parts.push(section('none', 'Needs sorting', v.unsorted));
  }
  for (const key of v.order) {
    const primary = key === state.sched.mode;
    const list = v[key];
    const label = contextLabel(key);
    if (key === 'app') { parts.push(section('app', 'App', list, { secondary: true })); continue; } // shown once it has tasks
    const daily = key === 'work' ? v.dailyWork : v.dailyHome;
    const opts = { daily, dailyDone: v.dailyDone(daily) };
    if (primary) parts.push(section(key, label, list, { ...opts, emptyText: key === 'work' ? 'No work tasks left today.' : 'Nothing on the home list.' }));
    // "for the next work day" only once today's work is over (or on a day off), not before work starts.
    else parts.push(section(key, key === 'work' && (state.sched.workDayOver || !state.sched.isWorkday) ? 'Work, for the next work day' : label, list, { ...opts, secondary: true }));
  }
  if (v.done.length) {
    parts.push(`<section class="section secondary"><h2>Done today <span class="count">${v.done.length}</span></h2>
      <ul class="tasks">${v.done.map((t) => taskRow(t, { drag: false, showContext: true })).join('')}</ul></section>`);
  }
  return parts.join('');
}

function calendarHtml() {
  const c = state.cal;
  if (!c.year) {
    const [y, m] = state.sched.today.split('-').map(Number);
    c.year = y; c.month0 = m - 1; c.selected = state.sched.today;
  }
  const mode = state.settings.calendarMode;
  const dayOpts = {
    mode, today: state.sched.today, timeZone: resolveTimeZone(state.settings),
    workDate: state.sched.workDate, workDayOver: state.sched.workDayOver,
  };
  const previewDay = state.sched.workDate > state.sched.today ? state.sched.workDate : null;
  const grid = monthGrid(c.year, c.month0).flat();
  const counts = {};
  const dailyOpts = { timeZone: dayOpts.timeZone, workDays: state.settings.workDays };
  for (const d of grid) {
    const k = { w: 0, h: 0, a: 0, d: dailyForDay(state.tasks, d, dailyOpts).length };
    for (const t of tasksForDay(state.tasks, d, dayOpts)) { if (t.context === 'home') k.h++; else if (t.context === 'app') k.a++; else k.w++; }
    if (k.w || k.h || k.a || k.d) counts[d] = k;
  }
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
    .format(new Date(c.year, c.month0, 1));
  const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="dow" aria-hidden="true">${d}</div>`).join('');
  const days = grid.map((d) => {
    const n = counts[d];
    // One Daily dot (not one per daily task) so dated tasks stay easy to spot.
    const dots = n ? `${n.d ? '<i class="dly"></i>' : ''}${'<i class="w"></i>'.repeat(Math.min(n.w, 3))}${'<i class="h"></i>'.repeat(Math.min(n.h, 3))}${'<i class="ap"></i>'.repeat(Math.min(n.a, 2))}` : '';
    const inMonth = Number(d.slice(5, 7)) === c.month0 + 1;
    const total = n ? n.w + n.h + n.a + n.d : 0;
    return `<button class="cal-day${inMonth ? '' : ' out'}${d === state.sched.today ? ' today' : ''}" data-act="pick-day" data-date="${d}"
      aria-pressed="${d === c.selected}" aria-label="${esc(formatDay(d, { weekday: 'long', month: 'long', day: 'numeric' }))}, ${total} open">
      <span>${Number(d.slice(8))}</span><span class="dots">${dots}</span></button>`;
  }).join('');
  // Same lists and order as the Tasks page: Needs sorting, then Work/Home by work hours, each in your order.
  const v = buildTodayView(tasksForDay(state.tasks, c.selected, dayOpts), state.sched, { includeNotStarted: true });
  const dayDaily = dailyForDay(state.tasks, c.selected, dailyOpts);
  const isToday = c.selected === state.sched.today;
  const total = v.unsorted.length + v.work.length + v.home.length + dayDaily.length;
  const lists = [section('cal-none', 'Needs sorting', v.unsorted)];
  for (const key of v.order) {
    const daily = key === 'app' ? [] : dayDaily.filter((t) => (key === 'work' ? t.context === 'work' : t.context !== 'work'));
    lists.push(section(`cal-${key}`, contextLabel(key), v[key], {
      daily,
      dailyDone: isToday ? daily.filter((t) => dailyDoneToday(t, state.sched.today)).length : 0,
      dailyDay: c.selected,
    }));
  }
  const pressed = (m) => `aria-pressed="${mode === m}"`;
  return `
  <div class="cal">
    <div class="cal-head">
      <h2>${esc(monthLabel)}</h2>
      <div class="nav">
        <button class="plain" data-act="cal-prev" aria-label="Previous month">‹</button>
        <button class="plain" data-act="cal-today">Today</button>
        <button class="plain" data-act="cal-next" aria-label="Next month">›</button>
      </div>
    </div>
    <div class="seg cal-mode" role="group" aria-label="Show tasks on the calendar">
      <button data-act="cal-mode" data-val="until-due" ${pressed('until-due')}>Every day until due</button>
      <button data-act="cal-mode" data-val="due-only" ${pressed('due-only')}>Due date only</button>
    </div>
    <div class="cal-grid">${dows}${days}</div>
  </div>
  <div class="cal-day-head">
    <h2>${esc(formatDay(c.selected, { weekday: 'long', month: 'short', day: 'numeric' }))} <span class="count">${total || ''}</span></h2>
    <p class="hint">${mode === 'until-due'
      ? 'Open tasks from the day they start (or were added) through their due date.'
      : 'Tasks due or starting this day.'}${c.selected === previewDay
      ? ' Also unfinished tasks with no due date and tasks carried over, since they move to this day\'s list.'
      : ''} ${c.selected > state.sched.today
        ? 'Tasks you add above join your Tasks list on this day; set Due as well if there\'s a deadline.'
        : 'Tasks you add above go on your Tasks list now.'}</p>
  </div>
  ${total ? lists.join('') : `<p class="empty">${mode === 'until-due' ? 'No open tasks run through this day.' : 'Nothing due this day.'}</p>`}`;
}

// ---------------------------------------------------------------- Time tab
/** Display name and list for a time line: subtasks show under their task. */
function timeLineInfo(x) {
  const t = find(x.taskId);
  const st = x.subtaskId ? (t?.subtasks || []).find((s2) => s2.id === x.subtaskId) : null;
  return {
    title: x.subtaskId ? (st?.title ?? x.title) : (t?.title ?? x.title ?? 'Task'),
    taskTitle: t?.title ?? null,
    context: t?.context ?? x.context ?? null,
  };
}
const lineFor = (key, day) => Object.values(dayTotals(state.entries, new Date(), tz())[day] || {}).find((x) => x.key === key);
const splitKey = (key) => { const [taskId, subId] = key.split('|'); return { taskId, subtaskId: subId || null }; };

/** Group a day's lines: each task's own time, then its subtasks' times indented under it. */
function groupLines(lines) {
  const groups = new Map();
  for (const x of lines) {
    const g = groups.get(x.taskId) || { taskId: x.taskId, own: null, subs: [], total: 0 };
    if (x.subtaskId) g.subs.push(x); else g.own = x;
    g.total += x.seconds;
    groups.set(x.taskId, g);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

function timeHtml() {
  const today = state.sched.today;
  const days = weekDays(state.timeWeek || today);
  const totals = dayTotals(state.entries, new Date(), tz());
  const runKey = runningKey();
  let weekTotal = 0;
  const perLine = {};
  const lineRow = (x, d, isSub) => {
    const editing = state.timeEdit && state.timeEdit.day === d && state.timeEdit.key === x.key;
    const live = x.key === runKey && d === today;
    return `<li class="time-row${isSub ? ' time-sub' : ''}${live ? ' running' : ''}">
      <span class="time-title">${isSub ? '<span class="sub-mark" aria-hidden="true">›</span>' : `<span class="ctx-dot ctx-${esc(x.context || 'none')}"></span>`}${esc(x.title)}</span>
      ${editing ? `<span class="time-edit">
          <input type="text" data-time-input value="${esc(formatDuration(x.seconds))}" aria-label="Time for ${esc(x.title)} (h:mm)">
          <button class="primary" data-act="time-save">Save</button><button class="plain" data-act="time-cancel">Cancel</button></span>`
        : `<button class="time-val" data-act="time-edit" data-day="${d}" data-key="${esc(x.key)}" title="Change this time"${live ? ` data-live-time="${esc(x.key)}"` : ''}>${esc(formatDuration(x.seconds, { seconds: live }))}</button>`}
    </li>`;
  };
  const dayBlocks = days.map((d) => {
    const lines = Object.values(totals[d] || {})
      .filter((x) => x.seconds > 0 || (x.key === runKey && d === today))
      .map((x) => ({ ...x, ...timeLineInfo(x) }));
    const dayTotal = lines.reduce((n, x) => n + x.seconds, 0); // task and subtask time: all of it
    weekTotal += dayTotal;
    for (const x of lines) (perLine[x.key] ||= { ...x, seconds: 0 }).seconds += x.seconds;
    const rows = groupLines(lines).map((g) => {
      const own = g.own || { key: timeKey(g.taskId), taskId: g.taskId, subtaskId: null, seconds: 0, ...timeLineInfo({ taskId: g.taskId, title: g.subs[0]?.taskTitle }) };
      const ownRow = g.own ? lineRow(own, d, false)
        : `<li class="time-row"><span class="time-title"><span class="ctx-dot ctx-${esc(own.context || 'none')}"></span>${esc(g.subs[0]?.taskTitle ?? own.title)}</span><span class="time-none">–</span></li>`;
      return ownRow + g.subs.sort((a, b) => b.seconds - a.seconds).map((x) => lineRow(x, d, true)).join('');
    }).join('');
    const addOpen = state.timeAddDay === d;
    // Choices for "+ Add time": open tasks and their open subtasks, plus anything with time this week.
    const choices = [];
    for (const t of state.tasks.filter((x) => (!x.completedAt || x.completedOn === today) && !isAppTask(x))) {
      choices.push({ key: timeKey(t.id), label: t.title });
      for (const st of t.subtasks || []) choices.push({ key: timeKey(t.id, st.id), label: `${t.title} › ${st.title}` });
    }
    for (const x of Object.values(perLine)) if (!choices.some((c) => c.key === x.key)) choices.push({ key: x.key, label: x.subtaskId ? `${x.taskTitle ?? 'Task'} › ${x.title}` : x.title });
    return `<section class="time-day${d === today ? ' today' : ''}">
      <h3><span>${esc(formatDay(d, { weekday: 'long', month: 'short', day: 'numeric' }))}</span><span class="time-total">${dayTotal ? esc(formatDuration(dayTotal)) : ''}</span></h3>
      ${rows ? `<ul class="time-list">${rows}</ul>` : '<p class="empty">No time logged.</p>'}
      ${addOpen ? `<div class="time-add">
          <select data-time-task aria-label="Task or subtask">${choices.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</select>
          <input type="text" data-time-add-input placeholder="1:30" aria-label="Time to add (h:mm)">
          <button class="primary" data-act="time-add-save" data-day="${d}">Add</button><button class="plain" data-act="time-cancel">Cancel</button>
        </div>` : `<button class="link" data-act="time-add" data-day="${d}">+ Add time</button>`}
    </section>`;
  }).join('');
  const taskTotals = Object.values(perLine).sort((a, b) => b.seconds - a.seconds)
    .map((x) => `<li><span class="time-title"><span class="ctx-dot ctx-${esc(x.context || 'none')}"></span>${esc(x.subtaskId ? `${x.taskTitle ?? 'Task'} › ${x.title}` : x.title)}</span><span>${esc(formatDuration(x.seconds))}</span></li>`).join('');
  const isThisWeek = days.includes(today);
  return `
  <div class="panel time-panel">
    <div class="time-head">
      <h2>${isThisWeek ? 'This week' : `Week of ${esc(formatDay(days[0], { month: 'short', day: 'numeric' }))}`}</h2>
      <div class="nav">
        <button class="plain" data-act="time-prev" aria-label="Previous week">‹</button>
        ${isThisWeek ? '' : '<button class="plain" data-act="time-this-week">This week</button>'}
        <button class="plain" data-act="time-next" aria-label="Next week"${isThisWeek ? ' disabled' : ''}>›</button>
      </div>
    </div>
    <p class="time-week-total">Week total <strong>${esc(formatDuration(weekTotal))}</strong></p>
    ${taskTotals ? `<details class="time-by-task"${state.timeByTaskOpen ? ' open' : ''}><summary>By task</summary><ul>${taskTotals}</ul></details>` : ''}
    <p class="hint" style="margin:0">Tap a time to correct it. Subtasks have their own times, shown under their task. A timer still running when work hours end stops by itself at that time.</p>
  </div>
  ${dayBlocks}`;
}

function timeTarget(key, line) {
  const { taskId, subtaskId } = splitKey(key);
  const live = timerTarget(taskId, subtaskId);
  return live || { id: taskId, subtaskId, title: line?.title ?? 'Task', context: line?.context ?? null };
}

async function saveTimeEdit() {
  const input = document.querySelector('input[data-time-input]');
  const secs = parseDuration(input?.value);
  if (secs === null) { toast('Enter a time like 1:30, 90m or 1.5h.'); return; }
  const { day, key } = state.timeEdit;
  const info = timeTarget(key, lineFor(key, day));
  state.timeEdit = null;
  document.activeElement?.blur();
  await guarded(() => commitTime(setDayTotal(state.entries, info, day, secs, new Date(), tz(), entryId)));
  toast(`${info.title}: ${formatDuration(secs)} on ${formatDay(day)}`);
}

async function saveTimeAdd() {
  const day = state.timeAddDay;
  const key = document.querySelector('select[data-time-task]')?.value;
  const secs = parseDuration(document.querySelector('input[data-time-add-input]')?.value);
  if (!key) return;
  if (secs === null || secs <= 0) { toast('Enter a time like 1:30, 90m or 1.5h.'); return; }
  const existing = lineFor(key, day);
  const info = timeTarget(key, existing);
  state.timeAddDay = null;
  document.activeElement?.blur();
  await guarded(() => commitTime(setDayTotal(state.entries, info, day, (existing?.seconds || 0) + secs, new Date(), tz(), entryId)));
  toast(`Added ${formatDuration(secs)} to ${info.title}`);
}

const REASONS = {
  other: 'Assigned to someone else',
  unassigned: 'No owner named',
  duplicate: 'Already imported',
  done: 'Already checked off in Granola',
};

function importHtml() {
  const d = state.importDraft;
  const r = state.importResult;
  let result = '';
  if (r) {
    const addable = r.skipped.filter((s) => s.reason === 'other' || s.reason === 'unassigned');
    const rest = r.skipped.filter((s) => s.reason !== 'other' && s.reason !== 'unassigned');
    const needsSort = r.added.filter((t) => !t.context).length;
    result = `
    <div class="result">
      <h3>${r.added.length ? `Added ${r.added.length} from “${esc(r.meetingTitle)}”` : `Nothing new for you in “${esc(r.meetingTitle)}”`}</h3>
      ${!r.foundSection ? '<p class="why">No action items heading found, so only checkbox lines were read.</p>' : ''}
      ${r.added.length ? `<ul>${r.added.map((t) => `<li>${esc(t.title)}</li>`).join('')}</ul>` : ''}
      ${needsSort ? `<p class="why">${needsSort} need a work or home choice. They're at the top of Today under Needs sorting.</p>` : ''}
    </div>
    ${addable.length ? `<div class="result"><h3>Not assigned to you</h3><ul>${addable.map((s) =>
      `<li>${esc(s.item.title)} <span class="why">${esc(s.item.owner ? `Owner: ${s.item.owner}` : REASONS[s.reason])}</span>
       <button class="plain add-anyway" data-act="force-import" data-fp="${esc(s.item.fingerprint)}">Add anyway</button></li>`).join('')}</ul></div>` : ''}
    ${rest.length ? `<div class="result"><h3>Skipped</h3><ul>${rest.map((s) =>
      `<li>${esc(s.item.title)} <span class="why">${esc(REASONS[s.reason])}</span></li>`).join('')}</ul></div>` : ''}`;
  }
  return `
  <div class="panel">
    <h2>Granola import <span class="badge">Manual</span></h2>
    <ol class="steps">
      <li>Open the meeting in Granola once the enhanced notes are ready.</li>
      <li>Copy all of the notes (desktop or phone) and paste them below.</li>
      <li>Items assigned to ${esc(state.settings.granolaAliases.join(' or '))} are added straight away. Re-pasting the same notes won't duplicate them.</li>
    </ol>
    <label>Notes<textarea data-draft="text" rows="10" placeholder="Paste Granola notes here">${esc(d.text)}</textarea></label>
    <div class="two">
      <label>Meeting title (optional)<input type="text" data-draft="title" value="${esc(d.title)}" placeholder="Read from the notes"></label>
      <label>Meeting date<input type="date" data-draft="date" value="${esc(d.date || state.sched.today)}"></label>
    </div>
    <div><button class="primary" data-act="import" ${state.importBusy ? 'disabled' : ''}>${state.importBusy ? 'Importing…' : 'Import action items'}</button></div>
    ${result}
  </div>`;
}

function settingsHtml() {
  const s = state.settings;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `
  <form class="panel" id="settings-form">
    <h2>Work hours</h2>
    <div class="two">
      <label>Start<input type="time" name="workStart" value="${esc(s.workStart)}" required></label>
      <label>End<input type="time" name="workEnd" value="${esc(s.workEnd)}" required></label>
    </div>
    <div class="days" role="group" aria-label="Work days">
      ${names.map((n, i) => `<label><input type="checkbox" name="workDays" value="${i}" ${s.workDays.includes(i) ? 'checked' : ''}>${n}</label>`).join('')}
    </div>
    <label>Time zone<input type="text" name="timezone" value="${esc(resolveTimeZone(s))}"></label>
    <p class="hint" style="margin:0">During work hours your work list is on top. After hours the home list moves to the top and work waits below for the next work day. Due dates never change on their own.</p>
    <h2>End of the work day</h2>
    <label>Show the Extend day button this many minutes before work ends
      <input type="number" name="extendPromptMinutes" min="1" max="120" step="1" value="${esc(s.extendPromptMinutes)}" required></label>
    <label>Keep the button up this many minutes before switching to Home on its own
      <input type="number" name="extendVisibleMinutes" min="1" max="240" step="1" value="${esc(s.extendVisibleMinutes)}" required></label>
    <label>Default time Extend day adds (minutes)
      <input type="number" name="extendDefaultMinutes" min="5" max="480" step="5" value="${esc(s.extendDefaultMinutes)}" required></label>
    <p class="hint" style="margin:0">${esc((() => {
      const end = s.workEnd.split(':').map(Number); const e = end[0] * 60 + end[1];
      const at = (m) => formatClock(`${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
      const shown = e - s.extendPromptMinutes, home = shown + s.extendVisibleMinutes;
      return `With these settings the button appears at ${at(shown)} and Home goes on top at ${at(home)} unless you extend.`;
    })())}</p>
    <div class="reset-day">
      <p class="hint" style="margin:0" id="day-order-now">Right now: ${esc(dayOrderSummary())}</p>
      <div><button type="button" class="plain" data-act="reset-day-order">Reset lists for today's hours</button></div>
      <p class="hint" style="margin:0">Clears today's Extend day or Switch to Home choice so Work and Home follow your work hours above (saving any changes here first). Your own task order isn't changed.</p>
    </div>
    <h2>Due date reminders</h2>
    <label>Remind me this many days before a due date
      <input type="number" name="dueSoonDays" min="0" max="30" step="1" value="${esc(s.dueSoonDays)}" required></label>
    <p class="hint" style="margin:0">Tasks inside this window are listed at the top of Tasks each day and marked on the task.${host.available ? ' The desktop app also shows a Windows notification each time it is opened.' : ''} 0 means only on the due date.</p>
    <fieldset class="radio-set">
      <legend>When the app opens, the due-soon list is</legend>
      <label><input type="radio" name="dueBannerStart" value="open" ${s.dueBannerStart !== 'hidden' ? 'checked' : ''}> Shown</label>
      <label><input type="radio" name="dueBannerStart" value="hidden" ${s.dueBannerStart === 'hidden' ? 'checked' : ''}> Hidden until I press Show</label>
    </fieldset>
    <p class="hint" style="margin:0">Applies the next time you open the app. While it's open, Hide and Show work the same either way.</p>
    <h2>Granola</h2>
    <label>Names that mean you (comma separated)<input type="text" name="aliases" value="${esc(s.granolaAliases.join(', '))}"></label>
    ${host.available ? `<h2>Desktop</h2><div><button type="button" class="plain" data-act="pin">${state.topMost ? 'Turn off keep on top' : 'Keep window on top'}</button></div>` : ''}
    <h2>Colors</h2>
    <div class="seg theme-seg" role="group" aria-label="Theme">
      ${[['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
        `<button type="button" data-act="theme-pick" data-val="${v}" aria-pressed="${s.theme === v}">${l}</button>`).join('')}
    </div>
    <input type="hidden" name="theme" value="${esc(s.theme)}">
    <div class="color-grid">
      ${COLOR_KEYS.map((k) => {
        const custom = !!s.colors[k];
        const value = s.colors[k] || DEFAULT_COLORS[activeTheme(s)][k];
        return `<div class="color-row">
          <input type="color" data-key="${k}" data-custom="${custom ? 1 : 0}" value="${esc(value.toLowerCase())}" aria-label="${esc(COLOR_LABELS[k])} color">
          <span class="name">${esc(COLOR_LABELS[k])}</span>
          <span class="default-tag"${custom ? ' hidden' : ''}>Default</span>
          <button type="button" class="link" data-act="color-reset" data-key="${k}"${custom ? '' : ' hidden'}>Reset</button>
        </div>`;
      }).join('')}
    </div>
    <div class="swatch-preview" aria-label="Preview">
      <span style="color:var(--work-text)">Work</span><span style="color:var(--home-text)">Home</span><span style="color:var(--app-text)">App</span><span style="color:var(--daily-text);border-left:4px solid var(--daily)">Daily</span><span style="color:var(--status);border-color:var(--status);font-weight:700">Waiting</span>
      <span style="color:var(--flag);font-weight:700">High</span><span style="color:var(--soon);font-weight:700">Due in 2 days</span>
      <span style="color:var(--today);font-weight:700">Due today</span><span style="color:var(--danger);font-weight:700">Overdue</span>
      <span style="border-left:4px solid var(--sort)">Needs sorting</span>
    </div>
    <p class="hint" style="margin:0">Changes preview right away; Save settings keeps them on all your devices. Colours are adjusted slightly where needed so text stays readable.</p>
    <div><button type="button" class="plain" data-act="color-reset-all">Reset all colors</button></div>
    <h2>Account</h2>
    <div><button type="button" class="plain" data-act="signout">Sign out</button></div>
    <div class="settings-save"><button class="primary" type="submit">Save settings</button></div>
  </form>`;
}

// ---------------------------------------------------------------- drag and drop
// Dropping a task on the middle of another task offers to make it a subtask of that task.
// The top and bottom quarters of a row still mean "reorder".
const nest = { dragId: null, target: null };

function nestTargetAt(x, y) {
  const li = document.elementFromPoint(x, y)?.closest('li.task');
  if (!li || li.dataset.id === nest.dragId || li.classList.contains('done') || li.classList.contains('sortable-chosen')) return null;
  if (li.classList.contains('is-daily') || isDaily(find(nest.dragId))) return null; // daily tasks don't nest
  const r = li.querySelector('.row').getBoundingClientRect();
  return y > r.top + r.height * 0.25 && y < r.bottom - r.height * 0.25 ? li : null;
}
function trackNestTarget(e) {
  const p = e.touches ? e.touches[0] : e;
  if (!p) return;
  const li = nestTargetAt(p.clientX, p.clientY);
  if (li === nest.target) return;
  nest.target?.classList.remove('nest-target');
  nest.target = li;
  li?.classList.add('nest-target');
}

function initSortables(root) {
  for (const ul of root.querySelectorAll('ul.sortable')) {
    window.Sortable.create(ul, {
      handle: '.drag',
      animation: 150,
      forceFallback: true, // pointer-based dragging: same behaviour in every browser and the desktop shell
      invertSwap: true,    // reorder near a row's edges; its middle is the "add as subtask" zone
      swapThreshold: 0.5,
      // Carried-over tasks stay pinned on top: reorder only among tasks in the same group,
      // except that dropping right after the last carried-over task means "first of the rest".
      onMove: (e) => {
        if (e.related.dataset.group === e.dragged.dataset.group) return true;
        const next = e.related.nextElementSibling === e.dragged ? e.dragged.nextElementSibling : e.related.nextElementSibling;
        return e.willInsertAfter && (!next || next.dataset.group === e.dragged.dataset.group);
      },
      group: { name: ul.dataset.list, pull: false, put: false }, // reorder within work / home only
      onStart: (e) => {
        dragging = true;
        nest.dragId = e.item.dataset.id;
        nest.target = null;
        document.addEventListener('pointermove', trackNestTarget, true);
        document.addEventListener('touchmove', trackNestTarget, { capture: true, passive: true });
      },
      onEnd: (e) => {
        dragging = false;
        document.removeEventListener('pointermove', trackNestTarget, true);
        document.removeEventListener('touchmove', trackNestTarget, { capture: true });
        const target = nest.target;
        nest.target?.classList.remove('nest-target');
        nest.target = null;
        if (target) {
          render({ force: true }); // put the list back as it was; nothing moves unless confirmed
          askToNest(e.item.dataset.id, target.dataset.id);
          return;
        }
        if (e.oldIndex === e.newIndex) { if (renderPending) render(); return; }
        const li = e.item;
        // Only neighbours in the same group count. Carried-over tasks are pinned on top whatever
        // their place in your order, so a task dropped just below them goes first among the rest.
        const same = (n) => (n && n.dataset.group === li.dataset.group ? n.dataset.id : null);
        guarded(() => moveTask(li.dataset.id, same(li.previousElementSibling), same(li.nextElementSibling)));
      },
    });
  }
}

function initSubtaskSortables(root) {
  for (const ul of root.querySelectorAll('ul.sub-edit-list')) {
    window.Sortable.create(ul, {
      handle: '.sub-drag',
      animation: 150,
      forceFallback: true,
      // Only between subtasks with the same due date (or both undated / both done).
      onMove: (e) => e.related.dataset.group === e.dragged.dataset.group,
      group: { name: `subs-${ul.dataset.for}`, pull: false, put: false },
      onStart: () => { dragging = true; },
      onEnd: (e) => {
        dragging = false;
        if (e.oldIndex === e.newIndex) { if (renderPending) render(); return; }
        const ids = [...ul.querySelectorAll('li[data-sub]')].map((li) => li.dataset.sub);
        guarded(() => changeSubtasks(ul.dataset.for, (l) => reorderSubtasks(l, ids)));
      },
    });
  }
}

function askToNest(srcId, targetId) {
  const src = find(srcId), tgt = find(targetId);
  if (!src || !tgt) return;
  const dlg = $('#nest-dialog');
  $('#nest-text').innerHTML = `Make <strong>${esc(src.title)}</strong> a subtask of <strong>${esc(tgt.title)}</strong>?`;
  const notes = [];
  const kept = [src.dueDate ? `due date (${esc(formatDay(src.dueDate))})` : '', src.priority === 'high' ? 'High priority' : ''].filter(Boolean);
  if (kept.length) notes.push(`It keeps its ${kept.join(' and ')}.`);
  const n = (src.subtasks || []).length;
  if (n) notes.push(`Its ${n} subtask${n === 1 ? '' : 's'} move${n === 1 ? 's' : ''} with it.`);
  if (src.note?.trim()) notes.push(`Its note is added to ${esc(tgt.title)}'s note.`);
  if (src.context !== tgt.context && tgt.context) notes.push(`It joins the ${contextLabel(tgt.context)} list with ${esc(tgt.title)}.`);
  $('#nest-details').innerHTML = notes.map((x) => `<li>${x}</li>`).join('');
  $('#nest-details').hidden = !notes.length;
  dlg.returnValue = '';
  dlg.onclose = () => { if (dlg.returnValue === 'add') guarded(() => nestTask(srcId, targetId)); };
  dlg.showModal();
  dlg.querySelector('[value="add"]').focus();
}

async function nestTask(srcId, targetId) {
  const src = find(srcId), tgt = find(targetId);
  if (!src || !tgt) return;
  await stopTimerIfFor(srcId);
  const before = { subtasks: tgt.subtasks || [], note: tgt.note || '' };
  const after = {
    subtasks: sortSubtasks([...before.subtasks, ...taskAsSubtasks(src)]),
    note: mergeNotes(before.note, src.title, src.note),
  };
  Object.assign(tgt, after);
  state.tasks = state.tasks.filter((t) => t.id !== srcId);
  if (state.expandedId === srcId) state.expandedId = null;
  setFolded(targetId, false);
  render();
  await db.updateTask(targetId, after);
  await db.deleteTask(srcId);
  toast(`Added to ${tgt.title}`, {
    label: 'Undo',
    run: () => guarded(async () => {
      const { id: _old, updatedAt, ...rest } = src;
      const restored = await db.insertTask(rest);
      Object.assign(tgt, before);
      await db.updateTask(targetId, before);
      state.tasks.push(restored);
      render();
    }),
  });
}

// ---------------------------------------------------------------- events in #view and band
function wireView() {
  const view = $('#view');

  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.closest('.task')?.dataset.id;
    switch (act) {
      case 'pin': host.toggleTopMost(); break;
      case 'expand': state.expandedId = state.expandedId === id ? null : id; render(); break;
      case 'collapse': state.expandedId = null; render(); break;
      case 'classify': case 'ctx': guarded(() => patchTask(id, { context: btn.dataset.val })); break;
      case 'prio': guarded(() => patchTask(id, { priority: btn.dataset.val })); break;
      case 'delete': guarded(() => removeTask(id)); break;
      case 'pick-day':
        state.cal.selected = btn.dataset.date;
        $('#add').elements.start.value = btn.dataset.date > state.sched.today ? btn.dataset.date : '';
        render(); break;
      case 'cal-prev': case 'cal-next': {
        const d = new Date(state.cal.year, state.cal.month0 + (act === 'cal-next' ? 1 : -1), 1);
        state.cal.year = d.getFullYear(); state.cal.month0 = d.getMonth(); render(); break;
      }
      case 'go-calendar': {
        const [y, m] = btn.dataset.date.split('-').map(Number);
        state.view = 'calendar'; state.expandedId = null;
        state.cal.year = y; state.cal.month0 = m - 1; state.cal.selected = btn.dataset.date;
        $('#add').elements.start.value = btn.dataset.date > state.sched.today ? btn.dataset.date : '';
        render(); break;
      }
      case 'cal-today': state.cal.year = 0; $('#add').elements.start.value = ''; render(); break;
      case 'cal-mode': {
        const next = normalizeSettings({ ...state.settings, calendarMode: btn.dataset.val });
        state.settings = next;
        render();
        guarded(() => db.saveSettings(next));
        break;
      }
      case 'theme-pick': {
        const form = btn.closest('#settings-form');
        form.elements.theme.value = btn.dataset.val;
        settingsDirty = true;
        previewSettingsForm();
        break;
      }
      case 'color-reset': case 'color-reset-all': {
        const form = btn.closest('#settings-form');
        const sel = act === 'color-reset' ? `input[data-key="${btn.dataset.key}"]` : 'input[data-key]';
        for (const inp of form.querySelectorAll(sel)) inp.dataset.custom = '0';
        settingsDirty = true;
        previewSettingsForm();
        break;
      }
      case 'extend-day': {
        const choice = state.extChoice || 'default';
        const minutes = choice === 'default' ? state.settings.extendDefaultMinutes
          : choice === 'custom' ? Math.round(Number(document.querySelector('[data-ext-custom]')?.value ?? state.extCustom)) : Number(choice);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) { toast('Enter between 1 and 480 minutes.'); break; }
        document.activeElement?.blur();
        const ext = extendWorkDay(state.settings, new Date(), minutes);
        guarded(async () => { await saveExtension(ext); toast(`Work day extended to ${formatClock(ext.endTime)}`); });
        break;
      }
      case 'reset-day-order': guarded(resetDayOrder); break;
      case 'status-toggle': {
        const t = find(id); const key = `task:${id}`;
        if (showTaskStatus(t)) {            // off: remove the status
          statusOpen.delete(key);
          if (t.status) guarded(() => patchTask(id, { status: null })); else render();
        } else {                            // on: open the box next to the name
          statusOpen.add(key);
          focusAfterRender = `.task[data-id="${CSS.escape(id)}"] input[data-field="status"]`;
          render({ force: true });
        }
        break;
      }
      case 'sub-status-toggle': {
        const t = find(id); const subId = btn.closest('[data-sub]').dataset.sub;
        const st = (t.subtasks || []).find((x) => x.id === subId); const key = `sub:${id}:${subId}`;
        if (showSubStatus(t, st)) {
          statusOpen.delete(key);
          if (st.status) guarded(() => changeSubtasks(id, (l) => updateSubtask(l, subId, { status: null }))); else render();
        } else {
          statusOpen.add(key);
          focusAfterRender = `.task[data-id="${CSS.escape(id)}"] li.sub-edit[data-sub="${CSS.escape(subId)}"] input[data-sub-status]`;
          render({ force: true });
        }
        break;
      }
      case 'edit-status':
        state.expandedId = id;
        focusAfterRender = `.task[data-id="${CSS.escape(id)}"] input[data-field="status"]`;
        render({ force: true });
        break;
      case 'edit-sub-status': {
        const subId = btn.closest('[data-sub]').dataset.sub;
        state.expandedId = id;
        focusAfterRender = `.task[data-id="${CSS.escape(id)}"] li.sub-edit[data-sub="${CSS.escape(subId)}"] input[data-sub-status]`;
        render({ force: true });
        break;
      }
      case 'timer': {
        const subId = btn.dataset.subTimer || null;
        guarded(() => (runningKey() === timeKey(id, subId) ? stopRunningTimer() : startTimerFor(id, subId)));
        break;
      }
      case 'timer-stop': guarded(stopRunningTimer); break;
      case 'time-prev': case 'time-next':
        state.timeWeek = addDays(weekDays(state.timeWeek || state.sched.today)[0], act === 'time-next' ? 7 : -7);
        state.timeEdit = null; state.timeAddDay = null; render(); break;
      case 'time-this-week': state.timeWeek = null; state.timeEdit = null; state.timeAddDay = null; render(); break;
      case 'time-edit':
        state.timeEdit = { day: btn.dataset.day, key: btn.dataset.key }; state.timeAddDay = null;
        focusAfterRender = 'input[data-time-input]'; render({ force: true }); break;
      case 'time-cancel': state.timeEdit = null; state.timeAddDay = null; render({ force: true }); break;
      case 'time-save': saveTimeEdit(); break;
      case 'time-add':
        state.timeAddDay = btn.dataset.day; state.timeEdit = null;
        focusAfterRender = 'select[data-time-task]'; render({ force: true }); break;
      case 'time-add-save': saveTimeAdd(); break;
      case 'toggle-subs': setFolded(id, !folded.has(id)); render(); break;
      case 'sub-del': {
        const subId = btn.closest('[data-sub]').dataset.sub;
        guarded(async () => { await stopSubTimerIfFor(id, subId); await changeSubtasks(id, (l) => removeSubtask(l, subId)); });
        break;
      }
      case 'sub-prio': {
        const subId = btn.closest('[data-sub]').dataset.sub;
        const cur = find(id)?.subtasks.find((x) => x.id === subId);
        guarded(() => changeSubtasks(id, (l) => updateSubtask(l, subId, { priority: cur?.priority === 'high' ? 'normal' : 'high' })));
        break;
      }
      case 'sub-add': addSubtaskFromInput(btn.closest('.task').querySelector('[data-sub-new]')); break;
      case 'toggle-due-banner': dueBannerOpen = !dueBannerOpen; render(); break;
      case 'open-task':
        state.view = 'today'; state.expandedId = btn.dataset.id; render();
        document.querySelector(`.task[data-id="${CSS.escape(btn.dataset.id)}"]`)?.scrollIntoView({ block: 'center' });
        break;
      case 'import': doImport([]); break;
      case 'force-import': doImport([btn.dataset.fp]); break;
      case 'signout': {
        const n = sync.status().pending;
        if (n && !confirm(`${n} change${n === 1 ? ' hasn\'t' : 's haven\'t'} reached Supabase yet and will be lost if you sign out now. Sign out anyway?`)) break;
        guarded(async () => { unsubscribe?.(); sync.clearDevice(); await store.signOut().catch(() => {}); location.reload(); });
        break;
      }
    }
  });

  view.addEventListener('change', (e) => {
    const el = e.target;
    const id = el.closest('.task')?.dataset.id;
    if (el.dataset.act === 'done') { guarded(() => setDone(id, el.checked)); return; }
    if (el.dataset.act === 'sub-done') {
      const subId = el.closest('[data-sub]').dataset.sub;
      guarded(async () => {
        if (el.checked) await stopSubTimerIfFor(id, subId);
        await changeSubtasks(id, (l) => setSubtaskDone(l, subId, el.checked));
      });
      return;
    }
    if (el.matches('select[data-repeat]') && id) {
      const t = find(id);
      const days = el.value;
      const patch = days
        ? { repeat: { ...(t.repeat || defaultRepeat(t.context)), days }, dueDate: null, startDate: null }
        : { repeat: null };
      guarded(async () => {
        await patchTask(id, patch);
        toast(days ? `Daily: ${days === 'work' ? 'on work days' : 'every day'}` : 'No longer repeats');
      });
      return;
    }
    if (el.hasAttribute('data-sub-status')) {
      const subId = el.closest('[data-sub]').dataset.sub;
      if (!cleanStatus(el.value)) statusOpen.delete(`sub:${id}:${subId}`);
      guarded(() => changeSubtasks(id, (l) => updateSubtask(l, subId, { status: el.value })));
      return;
    }
    if (el.hasAttribute('data-sub-due')) {
      const subId = el.closest('[data-sub]').dataset.sub;
      guarded(() => changeSubtasks(id, (l) => updateSubtask(l, subId, { dueDate: el.value || null })));
      return;
    }
    if (el.hasAttribute('data-sub-title')) {
      const subId = el.closest('[data-sub]').dataset.sub;
      if (!el.value.trim()) { el.value = find(id).subtasks.find((s) => s.id === subId)?.title ?? ''; return; }
      guarded(() => changeSubtasks(id, (l) => renameSubtask(l, subId, el.value)));
      return;
    }
    if (el.hasAttribute('data-sub-new') || el.hasAttribute('data-sub-new-due')) return; // added on Enter / Add, not on blur
    if (el.dataset.field && id) {
      let value = el.value;
      if (el.dataset.field === 'title') { value = value.trim(); if (!value) { el.value = find(id).title; return; } }
      if (el.dataset.field === 'status') { value = cleanStatus(value); if (!value) statusOpen.delete(`task:${id}`); } // blank = no status
      if (el.dataset.field === 'dueDate' && !value) value = null; // cleared: no deadline
      if (el.dataset.field === 'startDate' && (!value || value <= state.sched.today)) value = null; // on the list now
      guarded(async () => {
        await patchTask(id, { [el.dataset.field]: value });
        if (el.dataset.field === 'startDate' && value && state.view === 'today') toast(`Off your list until ${formatDay(value)}`);
      });
    }
  });

  // Enter in "Add a subtask" adds it and keeps the cursor there for the next one.
  view.addEventListener('keydown', (e) => {
    if (e.target.matches('input[data-time-input]')) {
      if (e.key === 'Enter') { e.preventDefault(); saveTimeEdit(); }
      if (e.key === 'Escape') { state.timeEdit = null; document.activeElement.blur(); render({ force: true }); }
    }
    if (e.target.matches('input[data-time-add-input]') && e.key === 'Enter') { e.preventDefault(); saveTimeAdd(); }
    if (e.key === 'Enter' && e.target.hasAttribute('data-sub-new')) { e.preventDefault(); addSubtaskFromInput(e.target); }
    if (e.key === 'Enter' && e.target.hasAttribute('data-sub-new-due')) {
      e.preventDefault(); addSubtaskFromInput(e.target.closest('.sub-new').querySelector('[data-sub-new]'));
    }
  });

  // Remember whether "By task" is open, so refreshes don't fold it away.
  view.addEventListener('toggle', (e) => { if (e.target.matches?.('.time-by-task')) state.timeByTaskOpen = e.target.open; }, true);

  view.addEventListener('input', (e) => {
    const draftFor = e.target.closest('.sub-new')?.querySelector('[data-sub-new]')?.dataset.subNew;
    if (draftFor) {
      const d = (subDrafts[draftFor] ||= { title: '', due: '' });
      if (e.target.hasAttribute('data-sub-new')) d.title = e.target.value;
      if (e.target.hasAttribute('data-sub-new-due')) d.due = e.target.value;
    }
    if (e.target.closest('#settings-form')) {
      settingsDirty = true;
      if (e.target.matches('input[type=color]')) { e.target.dataset.custom = '1'; previewSettingsForm(); }
    }
    const k = e.target.dataset.draft;
    if (k) state.importDraft[k] = e.target.value;
  });

  view.addEventListener('submit', (e) => {
    if (e.target.id !== 'settings-form') return;
    e.preventDefault();
    let next = readSettingsForm(e.target);
    if (!next) return;
    const prevSettings = state.settings;
    next = applyWorkHoursChange(prevSettings, next, new Date());
    guarded(async () => {
      await db.saveSettings(next);
      state.settings = next;
      settingsDirty = false;
      applyTheme(next);
      state.addCtxTouched = false;
      state.addCtx = null;
      document.activeElement?.blur();
      await applySchedule();
      render();
      if (!askIfWorkComesBack(prevSettings, next, { fromSave: true })) toast('Settings saved');
    });
  });
}

/** The Settings form's values as settings, or null (with a message) if something's invalid. */
function readSettingsForm(form) {
    const f = form.elements;
    const next = normalizeSettings({
      ...state.settings,
      workStart: f.workStart.value,
      workEnd: f.workEnd.value,
      extendPromptMinutes: Number(f.extendPromptMinutes.value),
      extendVisibleMinutes: Number(f.extendVisibleMinutes.value),
      extendDefaultMinutes: Number(f.extendDefaultMinutes.value),
      workDays: [...form.querySelectorAll('input[name=workDays]:checked')].map((x) => Number(x.value)),
      timezone: f.timezone.value.trim() || null,
      granolaAliases: f.aliases.value.split(',').map((a) => a.trim()).filter(Boolean),
      dueSoonDays: Number(f.dueSoonDays.value),
      dueBannerStart: f.dueBannerStart.value,
      theme: f.theme.value,
      colors: formColors(form),
    });
    if (next.timezone) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: next.timezone }); } catch { toast(`Unknown time zone: ${next.timezone}`); return null; }
    }
    if (f.workEnd.value <= f.workStart.value) { toast('Work end must be after work start.'); return null; }
    return next;
}

function formColors(form) {
  const colors = {};
  for (const inp of form.querySelectorAll('input[data-key]')) if (inp.dataset.custom === '1') colors[inp.dataset.key] = inp.value;
  return colors;
}

/** Apply what's in the Settings form without saving, and keep the pickers in step. */
function previewSettingsForm() {
  const form = document.getElementById('settings-form');
  if (!form) return;
  const preview = normalizeSettings({ ...state.settings, theme: form.elements.theme.value, colors: formColors(form) });
  applyTheme(preview, { remember: false });
  const theme = activeTheme(preview);
  for (const inp of form.querySelectorAll('input[data-key]')) {
    const custom = inp.dataset.custom === '1';
    if (!custom) inp.value = DEFAULT_COLORS[theme][inp.dataset.key].toLowerCase();
    const row = inp.closest('.color-row');
    row.querySelector('.default-tag').hidden = custom;
    row.querySelector('[data-act="color-reset"]').hidden = !custom;
  }
  for (const b of form.querySelectorAll('[data-act="theme-pick"]')) b.setAttribute('aria-pressed', String(b.dataset.val === form.elements.theme.value));
}

function dayOrderSummary() {
  const st = state.sched, set = state.settings;
  const ext = set.workExtension && set.workExtension.date === st.today ? set.workExtension : null;
  if (st.mode === 'work') return `Work is on top until ${formatClock(st.workEnd)}${st.extended ? ' (extended today)' : ''}.`;
  if (!st.isWorkday) return 'Home is on top. Today isn\'t a work day.';
  if (st.beforeWork) return `Home is on top until work starts at ${formatClock(set.workStart)}.`;
  if (ext?.ended) return `Home is on top. You switched to Home at ${formatClock(ext.endTime)}.`;
  return `Home is on top. Work ended at ${formatClock(st.switchAt === '24:00' ? '23:59' : st.switchAt)}.`;
}

/** Settings button: drop today's extend / switch-to-Home choice so the lists follow the work hours (saving form edits first). */
async function resetDayOrder() {
  const form = document.getElementById('settings-form');
  const base = settingsDirty && form ? readSettingsForm(form) : state.settings;
  if (!base) return;
  const next = normalizeSettings({ ...base, workExtension: null });
  await db.saveSettings(next);
  state.settings = next;
  settingsDirty = false;
  applyTheme(next);
  document.activeElement?.blur();
  await applySchedule();
  render();
  toast(`Lists reset. ${dayOrderSummary()}`);
}

async function saveExtension(workExtension) {
  const next = normalizeSettings({ ...state.settings, workExtension });
  state.settings = next;
  await applySchedule();
  render();
  await db.saveSettings(next);
}

/** The work day had switched to Home and new hours put us back in work time: ask before moving Work up. */
/**
 * fromSave: the change was just saved here, so closing (×, Cancel or Escape) undoes it and
 * leaves what was typed in Settings to fix. From the other device there's nothing to undo:
 * closing just leaves Work on top. Returns true if it asked.
 */
function askIfWorkComesBack(prev, next, { fromSave = false } = {}) {
  const now = new Date();
  const dlg = $('#workback-dialog');
  if (dlg.open || !workComesBack(prev, next, now)) return false;
  const st = scheduleState(now, next);
  const end = formatClock(st.workEnd);
  const nowText = formatClock(st.time);
  $('#workback-text').innerHTML = fromSave
    ? `Work now ends at <strong>${esc(end)}</strong>. It's ${esc(nowText)}, so that puts you back in work hours.`
    : `Your work hours were changed on your other device. Work now ends at <strong>${esc(end)}</strong>, so it's work time again (it's ${esc(nowText)}).`;
  $('#workback-question').textContent = 'Move your Work tasks back to the top?';
  $('#workback-cancel').hidden = !fromSave;
  dlg.querySelector('.dialog-x').setAttribute('aria-label', fromSave ? 'Cancel, undo this change' : 'Close');
  dlg.returnValue = '';
  dlg.onclose = () => {
    const choice = dlg.returnValue || 'cancel'; // Escape closes with no value
    if (choice === 'home') {
      guarded(async () => { await saveExtension(endWorkDayNow(state.settings, new Date())); toast('Staying on Home tasks'); });
    } else if (choice === 'work') {
      toast(`Settings saved. Work is on top until ${end}`);
    } else if (fromSave) {
      guarded(async () => {
        // Put the previous hours back; keep the Settings form as typed so the time can be fixed.
        state.settings = prev;
        await applySchedule();
        settingsDirty = true;
        renderBand();
        await db.saveSettings(prev);
        toast('Not saved. Fix the time and press Save settings.');
        document.querySelector('#settings-form input[name=workEnd]')?.focus();
      });
    }
  };
  dlg.showModal();
  dlg.querySelector('[value="work"]').focus(); // Enter: Work goes back to the top
  return true;
}

/** Reopened while an extension is the only thing keeping Work on top: ask how to carry on. */
function askAboutExtension() {
  if (!extensionKeepsWorkOnTop(new Date(), state.settings)) return;
  const dlg = $('#ext-dialog');
  const end = formatClock(state.sched.workEnd);
  $('#ext-text').textContent = `You extended today's work hours to ${end}. Keep going with work, or switch to your Home tasks now?`;
  dlg.querySelector('[value="keep"]').textContent = `Keep working until ${end}`;
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue === 'home') {
      guarded(async () => { await saveExtension(endWorkDayNow(state.settings, new Date())); toast('Switched to Home tasks'); });
    }
  };
  dlg.showModal();
  dlg.querySelector('[value="keep"]').focus(); // Enter or Escape: carry on as extended
}

function addSubtaskFromInput(input) {
  if (!input || !input.value.trim()) return;
  const id = input.dataset.subNew;
  const title = input.value;
  const dueInput = input.closest('.sub-new').querySelector('[data-sub-new-due]');
  const dueDate = dueInput?.value || null;
  input.value = '';
  if (dueInput) dueInput.value = '';
  delete subDrafts[id];
  guarded(() => changeSubtasks(id, (l) => addSubtask(l, title, { dueDate }), { refocus: `[data-sub-new="${CSS.escape(id)}"]` }));
}

// ---------------------------------------------------------------- Granola import
async function doImport(force, payload = null) {
  const input = payload || {
    text: state.importDraft.text,
    meetingTitle: state.importDraft.title,
    meetingDate: state.importDraft.date || state.sched.today,
  };
  if (!input.text.trim()) { toast('Paste the meeting notes first.'); return; }
  state.importBusy = true;
  document.activeElement?.blur();
  render();
  await guarded(async () => {
    const result = await runGranolaImport({ ...input, force }, {
      aliases: state.settings.granolaAliases,
      today: state.sched.today,
      existingFingerprints: sync.existingImportFingerprints,
      addTask,
      logImport: db.logImport,
    });
    if (force.length && state.importResult) {
      // Keep the earlier summary, fold in the item just added.
      const prev = state.importResult;
      prev.added.push(...result.added);
      prev.skipped = prev.skipped.filter((s) => !force.includes(s.item.fingerprint));
    } else {
      state.importResult = result;
    }
    if (payload) toast(`Granola: added ${result.added.length} item${result.added.length === 1 ? '' : 's'}`);
  });
  state.importBusy = false;
  render();
}

// ---------------------------------------------------------------- startup
async function startApp(uid) {
  userId = uid;
  // A different account than the one cached on this device: start clean.
  if (sync.cachedUserId() && sync.cachedUserId() !== uid) sync.clearDevice();
  $('#signin').hidden = true;
  $('#app').hidden = false;
  sync.onStatus((st) => {
    const cameBack = st.online && !state.sync.online;
    state.sync = st;
    trackSyncSpeed(st);
    if (state.sched) renderBand();
    if (cameBack) scheduleReload(); // pick up what changed elsewhere while we were offline
  });
  sync.onRejected((err) => {
    toast(`A change couldn't be saved (${err.message}). Showing what's stored.`);
    scheduleReload();
  });
  window.addEventListener('online', scheduleReload);
  await reload();
  askAboutExtension();
  unsubscribe?.();
  unsubscribe = store.subscribe(scheduleReload, (ok) => { state.online = ok; renderBand(); });
  setInterval(() => guarded(async () => { await applySchedule(); render(); }), 60_000);
  setInterval(tickTimer, 1000);
  setInterval(scheduleReload, 5 * 60_000);
  // Coming back to the window (restored from minimized, switched back to on the phone) just
  // refreshes the data. The banner stays the way you left it; only opening the app resets it.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleReload(); });
}

function showSignIn(message) {
  $('#app').hidden = true;
  $('#signin').hidden = false;
  if (message) $('#signin-msg').textContent = message;
}

async function main() {
  applyCachedTheme();
  onThemeChange(() => { if (state.sched && !$('#app').hidden) renderBand(); });
  wireAddForm();
  wireView();
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      state.expandedId = null;
      if (settingsDirty) applyTheme(state.settings); // leaving Settings without saving discards the edits and preview
      settingsDirty = false;
      if (state.view === 'today') $('#add').elements.start.value = '';
      if (state.view === 'calendar' && state.cal.selected) $('#add').elements.start.value = state.cal.selected > state.sched.today ? state.cal.selected : '';
      render();
    });
  }
  host.listen({
    topMost: (v) => { state.topMost = v; if (state.sched) render(); },
    // Reserved hook for a future automatic Granola source in the desktop shell.
    granolaNotes: (m) => doImport([], { text: m.text || '', meetingTitle: m.title || '', meetingDate: m.date || state.sched?.today }),
  });

  if (!store.isConfigured()) {
    showSignIn('Setup needed: add your Supabase URL and anon key to web/config.js.');
    $('#signin-form').hidden = false;
    return;
  }
  $('#signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const s = await store.signIn(f.email.value.trim(), f.password.value);
      await startApp(s.user.id);
    } catch (err) {
      $('#signin-msg').textContent = `Sign-in failed: ${err.message}`;
    }
  });
  const session = await store.getSession().catch(() => null);
  const fail = (err) => showSignIn(`Couldn't load your tasks: ${err.message}`);
  if (session) await startApp(session.user.id).catch(fail);
  // Offline (or the sign-in couldn't be refreshed without a connection): open from this device.
  else if (sync.cachedUserId()) await startApp(sync.cachedUserId()).catch(fail);
  else showSignIn(navigator.onLine ? null : "You're offline. Signing in for the first time needs a connection.");
}

// Keep the app's own files on the device so it opens offline (needs https or localhost).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable', err));
}

main();
