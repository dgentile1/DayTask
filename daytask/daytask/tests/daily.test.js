import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepeat, dailyShowsToday, dailyDoneToday, dailySubtasks, defaultRepeat } from '../web/js/core/daily.js';
import { scheduleState, normalizeSettings, buildTodayView, tasksForDay, dueSoonItems, carryInfo, listSiblings } from '../web/js/core/schedule.js';
import { themeVars, contrast } from '../web/js/core/colors.js';

const S = normalizeSettings({ timezone: 'America/Chicago' });
const at = (iso) => scheduleState(new Date(iso), S);
const mon = at('2026-11-02T16:00:00Z'), tue = at('2026-11-03T16:00:00Z'), sat = at('2026-11-07T16:00:00Z');

const standup = { id: 'd1', title: 'Standup notes', context: 'work', sortKey: 1, dueDate: null, repeat: defaultRepeat('work') };
const vitamins = { id: 'd2', title: 'Vitamins', context: 'home', sortKey: 1, dueDate: null, repeat: defaultRepeat('home') };
const normal = { id: 'n', title: 'Normal', context: 'work', sortKey: 0, dueDate: null };

test('repeat values are cleaned up', () => {
  assert.equal(normalizeRepeat(null), null);
  assert.deepEqual(normalizeRepeat({ days: 'x', doneOn: 'bad' }), { days: 'all', doneOn: null, subsOn: null });
  assert.deepEqual(defaultRepeat('work').days, 'work');
  assert.deepEqual(defaultRepeat('home').days, 'all');
});

test('daily tasks get their own section at the top of Work / Home', () => {
  const v = buildTodayView([normal, standup, vitamins], mon);
  assert.deepEqual(v.dailyWork.map((t) => t.id), ['d1']);
  assert.deepEqual(v.dailyHome.map((t) => t.id), ['d2']);
  assert.deepEqual(v.work.map((t) => t.id), ['n']);   // not mixed into the normal list
  assert.equal(v.dailyDone(v.dailyWork), 0);
  const none = buildTodayView([normal], mon);
  assert.deepEqual([none.dailyWork, none.dailyHome], [[], []]); // no section until one exists
});

test('checked off: done for today only', () => {
  const done = { ...standup, repeat: { ...standup.repeat, doneOn: '2026-11-02' } };
  assert.equal(dailyDoneToday(done, '2026-11-02'), true);
  assert.equal(dailyDoneToday(done, '2026-11-03'), false); // back tomorrow
  const v = buildTodayView([done], mon);
  assert.deepEqual(v.dailyWork.map((t) => t.id), ['d1']); // still shown, crossed off
  assert.equal(v.dailyDone(v.dailyWork), 1);
  assert.deepEqual(v.done, []); // not in "Done today"
  assert.equal(buildTodayView([done], tue).dailyDone(buildTodayView([done], tue).dailyWork), 0);
});

test('work-days-only tasks skip days off', () => {
  assert.equal(dailyShowsToday(standup, sat), false);
  assert.equal(dailyShowsToday(vitamins, sat), true);
  const v = buildTodayView([standup, vitamins], sat);
  assert.deepEqual([v.dailyWork.length, v.dailyHome.length], [0, 1]);
});

test('daily subtasks start fresh each day', () => {
  const t = { ...standup, repeat: { ...standup.repeat, subsOn: '2026-11-02' },
    subtasks: [{ id: 'a', title: 'A', done: true, dueDate: null, priority: 'normal' }] };
  assert.equal(dailySubtasks(t, '2026-11-02')[0].done, true);
  assert.equal(dailySubtasks(t, '2026-11-03')[0].done, false);
  assert.equal(dailySubtasks({ ...t, repeat: null }, '2026-11-03')[0].done, true); // normal tasks unaffected
});

test('daily tasks stay out of the calendar, reminders, carry-over and normal ordering', () => {
  const dated = { ...standup, dueDate: '2026-10-30' }; // even with a stray due date
  const o = { mode: 'until-due', today: mon.today, timeZone: 'America/Chicago', workDate: mon.workDate, workDayOver: false };
  assert.deepEqual(tasksForDay([standup, dated], mon.today, o), []);
  assert.deepEqual(dueSoonItems([dated], mon.today, 3), []);
  assert.equal(carryInfo(dated, mon).carried, false);
  assert.deepEqual(listSiblings([normal, standup], 'work').map((t) => t.id), ['n']);
});

test('daily colour is customisable and stays readable', () => {
  const v = themeVars({ daily: '#99FFEE' }, 'light');
  assert.equal(v['--daily'], '#99FFEE');
  assert.ok(contrast(v['--daily-text'], '#FFFFFF') >= 4.5);
});

test('Calendar: daily tasks on every day they repeat, from the day added', async () => {
  const { dailyForDay } = await import('../web/js/core/schedule.js');
  const created = '2026-11-02T14:00:00Z'; // Mon 08:00 CST
  const w = { ...standup, createdAt: created }, h = { ...vitamins, createdAt: created };
  const o = { timeZone: 'America/Chicago', workDays: [1, 2, 3, 4, 5] };
  const ids = (day) => dailyForDay([w, h, normal], day, o).map((t) => t.id);
  assert.deepEqual(ids('2026-11-01'), []);           // before it was added
  assert.deepEqual(ids('2026-11-02'), ['d1', 'd2']);
  assert.deepEqual(ids('2026-11-20'), ['d1', 'd2']); // keeps going
  assert.deepEqual(ids('2026-11-07'), ['d2']);       // Saturday: work-days task rests
  assert.deepEqual(dailyForDay([{ ...h, startDate: '2026-11-10' }], '2026-11-09', o), []); // start date respected
});
