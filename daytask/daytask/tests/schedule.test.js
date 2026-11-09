import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleState, initialSortKey, sortKeyBetween, buildTodayView, normalizeSettings, nextWorkday, dueStatus, dueSoonTasks, listSiblings,
} from '../web/js/core/schedule.js';

const S = normalizeSettings({ timezone: 'America/Chicago', workStart: '08:00', workEnd: '17:00' });
// 2026-11-02 is a Monday; Chicago is UTC-6 after DST ends on 2026-11-01.
const at = (iso) => new Date(iso);

test('work hours on a weekday => work mode, work date is today', () => {
  const s = scheduleState(at('2026-11-02T15:00:00Z'), S); // 09:00 local
  assert.equal(s.today, '2026-11-02');
  assert.equal(s.mode, 'work');
  assert.equal(s.workDate, '2026-11-02');
});

test('after hours => home mode, work date moves to next workday', () => {
  const s = scheduleState(at('2026-11-02T23:30:00Z'), S); // 17:30 local
  assert.equal(s.mode, 'home');
  assert.equal(s.workDate, '2026-11-03');
});

test('before work on a weekday => home mode but work tasks stay on today', () => {
  const s = scheduleState(at('2026-11-02T12:30:00Z'), S); // 06:30 local
  assert.equal(s.mode, 'home');
  assert.equal(s.beforeWork, true);
  assert.equal(s.workDate, '2026-11-02');
});

test('Friday evening and weekends roll to Monday', () => {
  assert.equal(scheduleState(at('2026-11-07T00:00:00Z'), S).workDate, '2026-11-09'); // Fri 18:00
  assert.equal(scheduleState(at('2026-11-07T18:00:00Z'), S).workDate, '2026-11-09'); // Sat noon
  assert.equal(nextWorkday('2026-11-06', [1, 2, 3, 4, 5]), '2026-11-09');
});

test('initial placement: by due date, high priority ahead of same-day normal', () => {
  const sib = [
    { id: 'a', dueDate: '2026-11-02', priority: 'normal', sortKey: 1000 },
    { id: 'b', dueDate: '2026-11-02', priority: 'normal', sortKey: 2000 },
    { id: 'c', dueDate: '2026-11-04', priority: 'normal', sortKey: 3000 },
  ];
  assert.equal(initialSortKey({ dueDate: '2026-11-03', priority: 'normal' }, sib), 2500);
  assert.equal(initialSortKey({ dueDate: '2026-11-02', priority: 'high' }, sib), 0);
  assert.equal(initialSortKey({ dueDate: '2026-11-09', priority: 'normal' }, sib), 4000);
  assert.equal(initialSortKey({ dueDate: '2026-11-02', priority: 'normal' }, []), 1000);
});

test('manual order survives: dropped key sits between neighbours', () => {
  assert.equal(sortKeyBetween(1000, 2000).key, 1500);
  assert.equal(sortKeyBetween(null, 1000).key, 0);
  assert.equal(sortKeyBetween(3000, null).key, 4000);
  assert.equal(sortKeyBetween(1, 1 + 1e-9).renormalize, true);
});

test('every open task is listed until checked off, whatever its due date', () => {
  const state = scheduleState(at('2026-11-02T23:30:00Z'), S); // after hours
  const tasks = [
    { id: 'h2', context: 'home', dueDate: null, sortKey: 2000 },
    { id: 'h1', context: 'home', dueDate: '2026-11-02', sortKey: 1000 },
    { id: 'w1', context: 'work', dueDate: '2026-12-15', sortKey: 1000 },
    { id: 'w2', context: 'work', dueDate: '2026-10-20', sortKey: 500 },
    { id: 'wd', context: 'work', dueDate: '2026-11-02', sortKey: 100, completedAt: 'x', completedOn: '2026-11-01' },
    { id: 'u1', context: null, dueDate: null, sortKey: 1000 },
  ];
  const v = buildTodayView(tasks, state);
  assert.deepEqual(v.order, ['home', 'work', 'app']);
  assert.deepEqual(v.home.map((t) => t.id), ['h1', 'h2']);
  assert.deepEqual(v.work.map((t) => t.id), ['w2', 'w1']); // far-future and overdue both shown, manual order
  assert.deepEqual(v.unsorted.map((t) => t.id), ['u1']);
  assert.deepEqual(v.done, []); // completed on another day: gone
  assert.equal(tasks.find((t) => t.id === 'w1').dueDate, '2026-12-15'); // nothing rewrites due dates
});

test('due status uses the reminder window', () => {
  const t = (d) => ({ dueDate: d });
  assert.deepEqual(dueStatus(t(null), '2026-11-02', 3), { level: 'none', days: null });
  assert.deepEqual(dueStatus(t('2026-10-31'), '2026-11-02', 3), { level: 'overdue', days: -2 });
  assert.deepEqual(dueStatus(t('2026-11-02'), '2026-11-02', 3), { level: 'today', days: 0 });
  assert.deepEqual(dueStatus(t('2026-11-05'), '2026-11-02', 3), { level: 'soon', days: 3 });
  assert.deepEqual(dueStatus(t('2026-11-06'), '2026-11-02', 3), { level: 'later', days: 4 });
  assert.equal(dueStatus(t('2026-11-03'), '2026-11-02', 0).level, 'later'); // 0 = only on the day
  assert.equal(dueStatus(t('2027-03-01'), '2026-11-02', 30).level, 'later'); // across DST and year end
});

test('due-soon list: open tasks inside the window, most urgent first', () => {
  const tasks = [
    { id: 'a', dueDate: '2026-11-05', sortKey: 1 },
    { id: 'b', dueDate: '2026-10-30', sortKey: 2 },
    { id: 'c', dueDate: '2026-11-20', sortKey: 3 },
    { id: 'd', dueDate: null, sortKey: 4 },
    { id: 'e', dueDate: '2026-11-02', sortKey: 5, completedAt: 'x' },
    { id: 'f', dueDate: '2026-11-02', sortKey: 6 },
  ];
  assert.deepEqual(dueSoonTasks(tasks, '2026-11-02', 3).map((t) => t.id), ['b', 'f', 'a']);
});

test('reminder setting is clamped to 0..30', () => {
  assert.equal(normalizeSettings({}).dueSoonDays, 3);
  assert.equal(normalizeSettings({ dueSoonDays: 45 }).dueSoonDays, 30);
  assert.equal(normalizeSettings({ dueSoonDays: -1 }).dueSoonDays, 0);
  assert.equal(normalizeSettings({ dueSoonDays: 'x' }).dueSoonDays, 3);
});

test('tasks without a due date are placed after dated ones', () => {
  const sib = [
    { id: 'a', dueDate: '2026-11-04', priority: 'normal', sortKey: 1000 },
    { id: 'b', dueDate: null, priority: 'normal', sortKey: 2000 },
  ];
  assert.equal(initialSortKey({ dueDate: null, priority: 'normal' }, sib), 3000);
  assert.equal(initialSortKey({ dueDate: null, priority: 'high' }, sib), 1500);
  assert.equal(initialSortKey({ dueDate: '2026-11-03', priority: 'normal' }, sib), 0);
});

test('calendar: due-only vs every day until due', async () => {
  const { tasksForDay } = await import('../web/js/core/schedule.js');
  const tz = 'America/Chicago';
  const today = '2026-11-02';
  const tasks = [
    // added Mon Nov 2 (08:00 CST), due Thu Nov 5
    { id: 'a', dueDate: '2026-11-05', createdAt: '2026-11-02T14:00:00Z' },
    // added Sun Nov 1 at 23:30 CST (already Nov 2 in UTC), overdue since Oct 30
    { id: 'b', dueDate: '2026-10-30', createdAt: '2026-11-02T05:30:00Z' },
    { id: 'c', dueDate: null, createdAt: '2026-11-01T14:00:00Z' },
    { id: 'd', dueDate: '2026-11-05', createdAt: '2026-11-01T14:00:00Z', completedAt: 'x' },
  ];
  const ids = (day, mode) => tasksForDay(tasks, day, { mode, today, timeZone: tz }).map((t) => t.id);
  assert.deepEqual(ids('2026-11-05', 'due-only'), ['a']);
  assert.deepEqual(ids('2026-11-04', 'due-only'), []);
  assert.deepEqual(ids('2026-11-04', 'until-due'), ['a']);
  assert.deepEqual(ids('2026-11-01', 'until-due'), ['b', 'c']); // created on local Nov 1 (c: no due date)
  assert.deepEqual(ids('2026-11-02', 'until-due'), ['a', 'b', 'c']); // overdue and undated keep showing through today
  assert.deepEqual(ids('2026-11-02', 'due-only'), ['c']); // undated task is always on today
  assert.deepEqual(ids('2026-11-01', 'due-only'), []); // ...but only today in "due date only" mode
  assert.deepEqual(ids('2026-11-03', 'until-due'), ['a']);   // overdue and undated: not past today
  assert.deepEqual(ids('2026-11-06', 'until-due'), []);
  assert.equal(normalizeSettings({}).calendarMode, 'due-only');
  assert.equal(normalizeSettings({ calendarMode: 'weird' }).calendarMode, 'due-only');
});

test('subtask due dates feed reminders and the calendar', async () => {
  const { dueSoonItems, tasksForDay } = await import('../web/js/core/schedule.js');
  const today = '2026-11-02';
  const tasks = [
    { id: 'p', title: 'Quote', dueDate: '2026-11-20', priority: 'normal', sortKey: 1, createdAt: '2026-11-02T14:00:00Z',
      subtasks: [
        { id: 's1', title: 'Pricing', done: false, dueDate: '2026-11-04', priority: 'normal' },
        { id: 's2', title: 'Disclaimer', done: false, dueDate: '2026-11-04', priority: 'high' },
        { id: 's3', title: 'Old step', done: true, dueDate: '2026-11-03', priority: 'normal' },
        { id: 's4', title: 'Someday', done: false, dueDate: null, priority: 'normal' },
      ] },
    { id: 'q', title: 'Relay', dueDate: '2026-11-03', priority: 'normal', sortKey: 2, subtasks: [] },
    { id: 'x', title: 'Done task', dueDate: null, completedAt: 'x', sortKey: 3,
      subtasks: [{ id: 'z', title: 'Ignored', done: false, dueDate: '2026-11-02', priority: 'normal' }] },
  ];
  const items = dueSoonItems(tasks, today, 3).map((i) => [i.title, i.subtask ? i.task.id : null]);
  // Nov 3 first, then Nov 4 with High ahead of Normal; done subtasks, undated ones and done tasks skipped.
  assert.deepEqual(items, [['Relay', null], ['Disclaimer', 'p'], ['Pricing', 'p']]);

  const opts = { today, timeZone: 'America/Chicago' };
  const ids = (day, mode) => tasksForDay(tasks, day, { ...opts, mode }).map((t) => t.id);
  assert.deepEqual(ids('2026-11-04', 'due-only'), ['p']);   // on a subtask's due date
  assert.deepEqual(ids('2026-11-20', 'due-only'), ['p']);   // and its own
  assert.deepEqual(ids('2026-11-03', 'due-only'), ['q']);   // done subtask's date doesn't count
  const undatedParent = [{ id: 'u', dueDate: null, createdAt: '2026-11-02T14:00:00Z',
    subtasks: [{ id: 'a', title: 'A', done: false, dueDate: '2026-11-06', priority: 'normal' }] }];
  assert.deepEqual(tasksForDay(undatedParent, '2026-11-05', { ...opts, mode: 'until-due' }).map((t) => t.id), ['u']);
  assert.deepEqual(tasksForDay(undatedParent, '2026-11-07', { ...opts, mode: 'until-due' }).map((t) => t.id), []);
  assert.deepEqual(tasksForDay(undatedParent, '2026-11-02', { ...opts, mode: 'due-only' }).map((t) => t.id), ['u']); // undated parent: on today too
});

test('unfinished items carry over to the top until done or re-dated', async () => {
  const { carryInfo, listOrder, dragGroup } = await import('../web/js/core/schedule.js');
  const mon10 = scheduleState(at('2026-11-02T16:00:00Z'), S);   // Mon 10:00, work hours
  const mon1730 = scheduleState(at('2026-11-02T23:30:00Z'), S); // Mon 17:30, work day over
  const tue10 = scheduleState(at('2026-11-03T16:00:00Z'), S);   // Tue 10:00
  const sat = scheduleState(at('2026-11-07T18:00:00Z'), S);     // Sat noon
  const work = { id: 'w', context: 'work', dueDate: '2026-11-02', sortKey: 5 };
  const home = { id: 'h', context: 'home', dueDate: '2026-11-02', sortKey: 5 };
  assert.equal(carryInfo(work, mon10).carried, false);          // still has the rest of the work day
  assert.deepEqual(carryInfo(work, mon1730), { carried: true, since: '2026-11-02' }); // work day ended
  assert.equal(carryInfo(home, mon1730).carried, false);        // home: the day isn't over yet
  assert.equal(carryInfo(home, tue10).carried, true);
  assert.equal(carryInfo({ ...work, completedAt: 'x' }, tue10).carried, false); // checked off
  assert.equal(carryInfo({ ...work, dueDate: '2026-11-05' }, tue10).carried, false); // re-dated later
  assert.equal(carryInfo({ ...work, dueDate: '2026-11-07' }, sat).carried, false); // weekend due date: not until the day passes
  const sub = { id: 's', context: 'home', dueDate: null, sortKey: 1,
    subtasks: [{ id: 'a', title: 'A', done: false, dueDate: '2026-11-01', priority: 'normal' }] };
  assert.deepEqual(carryInfo(sub, mon10), { carried: true, since: '2026-11-01' }); // late subtask carries its task
  assert.equal(carryInfo({ ...sub, subtasks: [{ ...sub.subtasks[0], done: true }] }, mon10).carried, false);

  const list = [
    { id: 'n1', context: 'work', dueDate: null, sortKey: 1 },
    { id: 'c2', context: 'work', dueDate: '2026-11-02', sortKey: 2 },
    { id: 'n2', context: 'work', dueDate: '2026-11-09', sortKey: 3 },
    { id: 'c1', context: 'work', dueDate: '2026-10-30', sortKey: 9 },
    { id: 'c3', context: 'work', dueDate: '2026-11-02', sortKey: 0 },
  ];
  assert.deepEqual(listOrder(list, mon10).map((t) => t.id), ['c1', 'c3', 'n1', 'c2', 'n2']); // c2/c3 not yet carried
  assert.deepEqual(listOrder(list, mon1730).map((t) => t.id), ['c1', 'c3', 'c2', 'n1', 'n2']); // most overdue first, then your order
  assert.equal(dragGroup(list[1], mon1730), 'carried:2026-11-02');
  assert.equal(dragGroup(list[0], mon1730), 'normal');
  const v = buildTodayView(list, mon1730);
  assert.deepEqual(v.work.map((t) => t.id), ['c1', 'c3', 'c2', 'n1', 'n2']);
});

test('banner start setting', () => {
  assert.equal(normalizeSettings({}).dueBannerStart, 'open');
  assert.equal(normalizeSettings({ dueBannerStart: 'hidden' }).dueBannerStart, 'hidden');
  assert.equal(normalizeSettings({ dueBannerStart: 'maybe' }).dueBannerStart, 'open');
});

test('a task with no due date comes along every day until checked off', async () => {
  const { tasksForDay } = await import('../web/js/core/schedule.js');
  const task = { id: 'n', context: 'work', dueDate: null, createdAt: '2026-11-02T14:00:00Z', sortKey: 1 };
  for (const today of ['2026-11-02', '2026-11-03', '2026-11-10', '2027-01-15']) {
    const opts = { today, timeZone: 'America/Chicago' };
    assert.deepEqual(tasksForDay([task], today, { ...opts, mode: 'due-only' }).map((x) => x.id), ['n'], today);
    assert.deepEqual(tasksForDay([task], today, { ...opts, mode: 'until-due' }).map((x) => x.id), ['n'], today);
    const state = scheduleState(new Date(today + 'T16:00:00Z'), S);
    assert.deepEqual(buildTodayView([task], state).work.map((x) => x.id), ['n'], today); // and on the Tasks page
  }
  const done = { ...task, completedAt: '2026-11-03T15:00:00Z', completedOn: '2026-11-03' };
  assert.deepEqual(tasksForDay([done], '2026-11-04', { today: '2026-11-04', timeZone: 'America/Chicago', mode: 'due-only' }), []);
  assert.deepEqual(buildTodayView([done], scheduleState(new Date('2026-11-04T16:00:00Z'), S)).work, []); // checked off: gone
});

test('after work hours the next work day previews tomorrow\'s list', async () => {
  const { tasksForDay } = await import('../web/js/core/schedule.js');
  const tasks = [
    { id: 'undated', context: 'work', dueDate: null, createdAt: '2026-11-02T14:00:00Z' },
    { id: 'undated-home', context: 'home', dueDate: null, createdAt: '2026-11-02T14:00:00Z' },
    { id: 'due-today', context: 'work', dueDate: '2026-11-02', createdAt: '2026-11-02T14:00:00Z' },
    { id: 'overdue', context: 'home', dueDate: '2026-10-30', createdAt: '2026-10-28T14:00:00Z' },
    { id: 'due-wed', context: 'work', dueDate: '2026-11-04', createdAt: '2026-11-02T14:00:00Z' },
    { id: 'done', context: 'work', dueDate: null, completedAt: 'x' },
  ];
  const opts = (iso, mode = 'due-only') => {
    const st = scheduleState(new Date(iso), S);
    return { mode, today: st.today, timeZone: 'America/Chicago', workDate: st.workDate, workDayOver: st.workDayOver };
  };
  const ids = (day, o) => tasksForDay(tasks, day, o).map((t) => t.id);
  // Monday 10:00 (work hours): nothing previewed on Tuesday yet.
  assert.deepEqual(ids('2026-11-03', opts('2026-11-02T16:00:00Z')), []);
  // Monday 17:30: Tuesday shows the undated ones and everything carried over, not future-dated tasks.
  assert.deepEqual(ids('2026-11-03', opts('2026-11-02T23:30:00Z')), ['undated', 'undated-home', 'due-today', 'overdue']);
  assert.deepEqual(ids('2026-11-04', opts('2026-11-02T23:30:00Z')), ['due-wed']); // only the day after that by due date
  assert.deepEqual(ids('2026-11-03', opts('2026-11-02T23:30:00Z', 'until-due')),
    ['undated', 'undated-home', 'due-today', 'overdue', 'due-wed']); // every-day mode also has due-wed running
  // Friday evening and Saturday: previewed on Monday, not on the weekend days.
  const fri = opts('2026-11-07T00:00:00Z'); // Fri 18:00
  assert.deepEqual(ids('2026-11-09', fri).slice(0, 2), ['undated', 'undated-home']);
  assert.deepEqual(ids('2026-11-07', fri), []);
  assert.deepEqual(ids('2026-11-09', opts('2026-11-07T18:00:00Z')).slice(0, 2), ['undated', 'undated-home']);
});

test('start date: the day a task joins the list', async () => {
  const { tasksForDay, hasStarted } = await import('../web/js/core/schedule.js');
  const mon10 = scheduleState(at('2026-11-02T16:00:00Z'), S);
  const thu10 = scheduleState(at('2026-11-05T16:00:00Z'), S);
  const later = { id: 'later', context: 'home', dueDate: null, startDate: '2026-11-05', sortKey: 1, createdAt: '2026-11-02T14:00:00Z' };
  const dated = { id: 'dated', context: 'work', dueDate: '2026-11-09', startDate: '2026-11-05', sortKey: 2, createdAt: '2026-11-02T14:00:00Z' };
  const now = { id: 'now', context: 'home', dueDate: null, sortKey: 3, createdAt: '2026-11-02T14:00:00Z' };
  assert.equal(hasStarted(later, '2026-11-04'), false);
  assert.equal(hasStarted(later, '2026-11-05'), true);
  // Tasks page: not listed before its start day, listed from then on.
  const mon = buildTodayView([later, dated, now], mon10);
  assert.deepEqual([...mon.home, ...mon.work].map((t) => t.id), ['now']);
  assert.deepEqual(mon.startsLater.map((t) => t.id), ['later', 'dated']);
  const thu = buildTodayView([later, dated, now], thu10);
  assert.deepEqual(thu.home.map((t) => t.id), ['later', 'now']);
  assert.deepEqual(thu.work.map((t) => t.id), ['dated']);
  assert.deepEqual(thu.startsLater, []);
  assert.deepEqual(buildTodayView([later], mon10, { includeNotStarted: true }).home.map((t) => t.id), ['later']); // Calendar's day list
  // Calendar (looking from Monday).
  const o = (mode) => ({ mode, today: mon10.today, timeZone: 'America/Chicago', workDate: mon10.workDate, workDayOver: mon10.workDayOver });
  const ids = (day, mode) => tasksForDay([later, dated, now], day, o(mode)).map((t) => t.id);
  assert.deepEqual(ids('2026-11-02', 'due-only'), ['now']);           // not on today before it starts
  assert.deepEqual(ids('2026-11-05', 'due-only'), ['later', 'dated']); // on its start day
  assert.deepEqual(ids('2026-11-09', 'due-only'), ['dated']);          // and its due date
  assert.deepEqual(ids('2026-11-04', 'until-due'), []);                // every-day mode: nothing before the start
  assert.deepEqual(ids('2026-11-07', 'until-due'), ['dated']);         // runs from start to due
  // After work Wednesday, the Thursday preview includes a task starting Thursday... and not one starting Friday.
  const wedEve = scheduleState(at('2026-11-05T00:00:00Z'), S); // Wed 18:00
  const fri = { ...later, id: 'fri', startDate: '2026-11-06' };
  const prev = tasksForDay([later, fri], '2026-11-05', { mode: 'due-only', today: wedEve.today, timeZone: 'America/Chicago', workDate: wedEve.workDate, workDayOver: wedEve.workDayOver });
  assert.deepEqual(prev.map((t) => t.id), ['later']);
});

test('extend the work day: button timing, auto switch, extensions', async () => {
  const { extendWorkDay, endWorkDayNow, extensionKeepsWorkOnTop } = await import('../web/js/core/schedule.js');
  const base = normalizeSettings({ timezone: 'America/Chicago', workStart: '08:00', workEnd: '17:00',
    extendPromptMinutes: 15, extendVisibleMinutes: 15, extendDefaultMinutes: 30 });
  const cst = (hhmm) => new Date(`2026-11-04T${hhmm}:00-06:00`); // a Wednesday
  // Button: from 16:45 until the switch at 17:00.
  assert.equal(scheduleState(cst('16:44'), base).showExtend, false);
  assert.equal(scheduleState(cst('16:45'), base).showExtend, true);
  assert.deepEqual([scheduleState(cst('16:59'), base).mode, scheduleState(cst('17:00'), base).mode], ['work', 'home']);
  assert.equal(scheduleState(cst('17:00'), base).showExtend, false);
  // Visible longer than the lead time: Work stays on top past 17:00 while the button is up.
  const longer = { ...base, extendVisibleMinutes: 25 };
  assert.deepEqual([scheduleState(cst('17:05'), longer).mode, scheduleState(cst('17:05'), longer).showExtend], ['work', true]);
  assert.equal(scheduleState(cst('17:10'), longer).mode, 'home');
  assert.equal(scheduleState(cst('17:10'), longer).workDayOver, true); // carry-over follows the actual switch
  // Extending at 16:50 by 30 -> 17:30; button returns at 17:15; switch at 17:30.
  const ext = { ...base, workExtension: extendWorkDay(base, cst('16:50'), 30) };
  assert.deepEqual(ext.workExtension, { date: '2026-11-04', endTime: '17:30', ended: false });
  const at = (h) => scheduleState(cst(h), ext);
  assert.deepEqual([at('17:10').mode, at('17:10').showExtend, at('17:10').extended, at('17:10').workEnd], ['work', false, true, '17:30']);
  assert.equal(at('17:15').showExtend, true);
  assert.equal(at('17:30').mode, 'home');
  assert.equal(at('17:10').workDate, '2026-11-04'); // still today's work day
  // Extend again from the extended end.
  assert.equal(extendWorkDay(ext, cst('17:20'), 45).endTime, '18:15');
  // Pressed after the normal end (long visible window): adds to now, not to the past end.
  assert.equal(extendWorkDay(longer, cst('17:08'), 30).endTime, '17:38');
  // Reopen question only while the extension is what keeps Work on top.
  assert.equal(extensionKeepsWorkOnTop(cst('16:30'), ext), false); // normal hours anyway
  assert.equal(extensionKeepsWorkOnTop(cst('17:10'), ext), true);
  assert.equal(extensionKeepsWorkOnTop(cst('17:40'), ext), false); // extension over
  // "Switch to Home tasks": ends now, no button, Home on top.
  const ended = { ...ext, workExtension: endWorkDayNow(ext, cst('17:10')) };
  assert.deepEqual([scheduleState(cst('17:10'), ended).mode, scheduleState(cst('17:10'), ended).showExtend], ['home', false]);
  assert.equal(extensionKeepsWorkOnTop(cst('17:12'), ended), false);
  // An extension from another day does nothing.
  assert.equal(scheduleState(new Date('2026-11-05T17:10:00-06:00'), ext).mode, 'home');
  // Late extensions stop at midnight; settings are clamped.
  assert.equal(extendWorkDay(base, cst('16:50'), 480).endTime, '23:59');
  assert.deepEqual([normalizeSettings({ extendPromptMinutes: 0 }).extendPromptMinutes, normalizeSettings({ extendDefaultMinutes: 'x' }).extendDefaultMinutes], [1, 30]);
  assert.equal(normalizeSettings({ workExtension: { date: 'bad' } }).workExtension, null);
});

test('pushing the work end out after the switch to Home', async () => {
  const { applyWorkHoursChange, workComesBack, endWorkDayNow } = await import('../web/js/core/schedule.js');
  const base = normalizeSettings({ timezone: 'America/Chicago', workEnd: '17:00' });
  const cst = (hhmm) => new Date(`2026-11-05T${hhmm}:00-06:00`); // Thursday
  const later = { ...base, workEnd: '18:00' };
  assert.equal(workComesBack(base, later, cst('17:15')), true);           // switched at 17:00, now back in hours
  assert.equal(workComesBack(base, later, cst('16:30')), false);          // was still work anyway
  assert.equal(workComesBack(base, { ...base, workEnd: '17:10' }, cst('17:15')), false); // still past the new end
  assert.equal(workComesBack(later, base, cst('17:15')), false);          // pulled in: no question
  assert.equal(workComesBack(base, later, new Date('2026-11-07T17:15:00-06:00')), false); // Saturday
  // An earlier "Switch to Home tasks" doesn't block a later end time.
  const switched = { ...base, workExtension: endWorkDayNow(base, cst('16:55')) };
  const saved = applyWorkHoursChange(switched, { ...switched, workEnd: '18:00' }, cst('17:15'));
  assert.equal(saved.workExtension, null);
  assert.equal(workComesBack(switched, saved, cst('17:15')), true);
  // An extension already past the new end stays.
  const ext = { ...base, workExtension: { date: '2026-11-05', endTime: '19:00', ended: false } };
  assert.deepEqual(applyWorkHoursChange(ext, { ...ext, workEnd: '18:00' }, cst('17:15')).workExtension, ext.workExtension);
});

test('App list: its own section after Work and Home, carried over like Home', async () => {
  const { isAppTask, contextLabel } = await import('../web/js/core/schedule.js');
  const mon10 = scheduleState(at('2026-11-02T16:00:00Z'), S), mon1730 = scheduleState(at('2026-11-02T23:30:00Z'), S);
  const tasks = [
    { id: 'w', context: 'work', sortKey: 1 }, { id: 'h', context: 'home', sortKey: 1 },
    { id: 'a2', context: 'app', sortKey: 2 }, { id: 'a1', context: 'app', sortKey: 1 },
  ];
  const v = buildTodayView(tasks, mon10);
  assert.deepEqual(v.order, ['work', 'home', 'app']);
  assert.deepEqual(buildTodayView(tasks, mon1730).order, ['home', 'work', 'app']);
  assert.deepEqual(v.app.map((t) => t.id), ['a1', 'a2']);
  assert.deepEqual([v.work.length, v.home.length], [1, 1]);
  const due = { id: 'x', context: 'app', dueDate: '2026-11-02' };
  const { carryInfo } = await import('../web/js/core/schedule.js');
  assert.equal(carryInfo(due, mon1730).carried, false); // not at work end (like Home)
  assert.equal(carryInfo(due, scheduleState(at('2026-11-03T16:00:00Z'), S)).carried, true); // once the day has passed
  assert.equal(isAppTask(due), true);
  assert.deepEqual(['work', 'home', 'app', null].map(contextLabel), ['Work', 'Home', 'App', 'Needs sorting']);
  assert.deepEqual(listSiblings(tasks, 'app').map((t) => t.id), ['a1', 'a2']);
});
