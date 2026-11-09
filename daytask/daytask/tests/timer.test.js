import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startOfLocalDay, splitByDay, startTimer, stopTimer, applyChanges, dayTotals, taskDaySeconds,
  setDayTotal, formatDuration, parseDuration, weekDays, runningEntry,
} from '../web/js/core/timer.js';

const TZ = 'America/Chicago';
let n = 0;
const newId = () => `e${++n}`;
const cst = (d, hhmm) => new Date(`${d}T${hhmm}:00-06:00`);
const A = { id: 'A', title: 'Order relay', context: 'work' };
const B = { id: 'B', title: 'Review PR', context: 'work' };

test('local midnight and splitting across days (incl. daylight saving)', () => {
  assert.equal(startOfLocalDay('2026-11-03', TZ).toISOString(), '2026-11-03T06:00:00.000Z');
  assert.equal(startOfLocalDay('2026-11-01', TZ).toISOString(), '2026-11-01T05:00:00.000Z'); // CDT before 2am fall-back
  const parts = splitByDay(cst('2026-11-02', '23:30').toISOString(), cst('2026-11-03', '00:45').toISOString(), TZ);
  assert.deepEqual(parts.map((p) => [p.day, p.seconds]), [['2026-11-02', 1800], ['2026-11-03', 2700]]);
});

test('start, switch tasks, come back: time adds up', () => {
  let e = [];
  e = applyChanges(e, startTimer(e, A, cst('2026-11-03', '09:00'), TZ, newId));
  assert.equal(runningEntry(e).taskId, 'A');
  e = applyChanges(e, startTimer(e, A, cst('2026-11-03', '09:05'), TZ, newId)); // pressing start again: no change
  assert.equal(e.length, 1);
  e = applyChanges(e, startTimer(e, B, cst('2026-11-03', '09:30'), TZ, newId)); // A stops, B starts
  assert.equal(runningEntry(e).taskId, 'B');
  assert.equal(e.find((x) => x.taskId === 'A').seconds, 1800);
  e = applyChanges(e, startTimer(e, A, cst('2026-11-03', '10:00'), TZ, newId)); // back to A
  const now = cst('2026-11-03', '10:15');
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ), 1800 + 900); // added on, running included
  assert.equal(taskDaySeconds(e, 'B', '2026-11-03', now, TZ), 1800);
  e = applyChanges(e, stopTimer(e, now, TZ, newId));
  assert.equal(runningEntry(e), null);
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', cst('2026-11-03', '18:00'), TZ), 2700); // stopped: no more counting
});

test('a timer left running past midnight is split per day when stopped', () => {
  let e = applyChanges([], startTimer([], A, cst('2026-11-02', '23:00'), TZ, newId));
  const t = dayTotals(e, cst('2026-11-03', '01:00'), TZ);
  assert.deepEqual([t['2026-11-02']['A|'].seconds, t['2026-11-03']['A|'].seconds], [3600, 3600]); // while running
  e = applyChanges(e, stopTimer(e, cst('2026-11-03', '01:00'), TZ, newId));
  const timers = e.filter((x) => x.kind === 'timer').map((x) => [x.day, x.seconds, !!x.endedAt]);
  assert.deepEqual(timers.sort(), [['2026-11-02', 3600, true], ['2026-11-03', 3600, true]]);
});

test('adjusting a day total keeps the timer entries and adds one correction', () => {
  let e = applyChanges([], startTimer([], A, cst('2026-11-03', '09:00'), TZ, newId));
  e = applyChanges(e, stopTimer(e, cst('2026-11-03', '09:40'), TZ, newId)); // 40 min
  const now = cst('2026-11-03', '17:00');
  e = applyChanges(e, setDayTotal(e, A, '2026-11-03', 3600, now, TZ, newId)); // make it 1:00
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ), 3600);
  assert.equal(e.filter((x) => x.kind === 'adjust').length, 1);
  e = applyChanges(e, setDayTotal(e, A, '2026-11-03', 1200, now, TZ, newId)); // make it 0:20 (reuses the correction)
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ), 1200);
  assert.deepEqual(e.filter((x) => x.kind === 'adjust').map((x) => x.seconds), [-1200]);
  assert.equal(e.find((x) => x.kind === 'timer').seconds, 2400); // the timer entry itself is untouched
  // Adding time on a day with no timer at all.
  e = applyChanges(e, setDayTotal(e, B, '2026-11-02', 5400, now, TZ, newId));
  assert.equal(taskDaySeconds(e, 'B', '2026-11-02', now, TZ), 5400);
  // Setting to 0 never goes negative.
  e = applyChanges(e, setDayTotal(e, A, '2026-11-03', -50, now, TZ, newId));
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ), 0);
});

test('typing and showing durations; weeks start Monday', () => {
  assert.deepEqual(['1:30', '90', '90m', '1.5h', '1h 30m', '2h', '0:05', 'abc', ''].map(parseDuration),
    [5400, 5400, 5400, 5400, 5400, 7200, 300, null, null]);
  assert.deepEqual([formatDuration(5400), formatDuration(59), formatDuration(3725, { seconds: true })], ['1:30', '0:00', '1:02:05']);
  assert.deepEqual(weekDays('2026-11-05'), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.equal(weekDays('2026-11-08')[0], '2026-11-02'); // Sunday belongs to the week that started Monday
});

test('a running timer stops at the end of the work day it was started in', async () => {
  const { autoStopAt, uuidFrom } = await import('../web/js/core/timer.js');
  const { normalizeSettings } = await import('../web/js/core/schedule.js');
  const S = normalizeSettings({ timezone: TZ, workStart: '08:00', workEnd: '17:00' }); // button 15/15: switch at 17:00
  const at = (d, hhmm) => autoStopAt({ startedAt: cst(d, hhmm).toISOString() }, S, TZ)?.toISOString();
  assert.equal(at('2026-11-03', '10:00'), cst('2026-11-03', '17:00').toISOString()); // Tuesday: 5 PM that day
  assert.equal(at('2026-11-03', '07:15'), cst('2026-11-03', '17:00').toISOString()); // before work: still that day
  assert.equal(at('2026-11-03', '17:30'), cst('2026-11-04', '17:00').toISOString()); // after hours: next work day's end
  assert.equal(at('2026-11-06', '18:00'), cst('2026-11-09', '17:00').toISOString()); // Friday evening: Monday
  assert.equal(at('2026-11-07', '10:00'), cst('2026-11-09', '17:00').toISOString()); // Saturday: Monday
  const ext = { ...S, workExtension: { date: '2026-11-03', endTime: '18:30', ended: false } };
  assert.equal(autoStopAt({ startedAt: cst('2026-11-03', '10:00').toISOString() }, ext, TZ).toISOString(), cst('2026-11-03', '18:30').toISOString()); // extended day
  const ended = { ...S, workExtension: { date: '2026-11-03', endTime: '16:20', ended: true } };
  assert.equal(autoStopAt({ startedAt: cst('2026-11-03', '10:00').toISOString() }, ended, TZ).toISOString(), cst('2026-11-03', '16:20').toISOString()); // switched to Home early
  const longer = { ...S, extendVisibleMinutes: 25 };
  assert.equal(autoStopAt({ startedAt: cst('2026-11-03', '10:00').toISOString() }, longer, TZ).toISOString(), cst('2026-11-03', '17:10').toISOString()); // longer button window
  // Splitting the same timer on two devices makes the same ids (no duplicates).
  assert.equal(uuidFrom('abc:2026-11-03'), uuidFrom('abc:2026-11-03'));
  assert.notEqual(uuidFrom('abc:2026-11-03'), uuidFrom('abc:2026-11-04'));
  assert.match(uuidFrom('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('subtasks have their own timers, separate from the task', async () => {
  const { timeKey } = await import('../web/js/core/timer.js');
  const sub = { id: 'A', subtaskId: 's1', title: 'Get quote', context: 'work' };
  let e = applyChanges([], startTimer([], A, cst('2026-11-03', '09:00'), TZ, newId));        // task A
  e = applyChanges(e, startTimer(e, sub, cst('2026-11-03', '09:20'), TZ, newId));             // its subtask: A stops
  assert.equal(runningEntry(e).subtaskId, 's1');
  e = applyChanges(e, startTimer(e, sub, cst('2026-11-03', '09:25'), TZ, newId));             // same subtask again: no change
  assert.equal(e.length, 2);
  e = applyChanges(e, startTimer(e, B, cst('2026-11-03', '09:50'), TZ, newId));               // another task: subtask stops
  const now = cst('2026-11-03', '10:00');
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ), 1200);                          // task's own time only
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ, 's1'), 1800);                    // subtask's own
  const day = dayTotals(e, now, TZ)['2026-11-03'];
  assert.deepEqual(Object.keys(day).sort(), [timeKey('A'), timeKey('A', 's1'), timeKey('B')].sort());
  assert.equal(Object.values(day).reduce((n, x) => n + x.seconds, 0), 1200 + 1800 + 600);    // day total: all of it
  // Correcting a subtask's time leaves the task's alone.
  e = applyChanges(e, setDayTotal(e, sub, '2026-11-03', 3600, now, TZ, newId));
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ, 's1'), 3600);
  assert.equal(taskDaySeconds(e, 'A', '2026-11-03', now, TZ), 1200);
  // Split at midnight keeps the subtask.
  let m = applyChanges([], startTimer([], sub, cst('2026-11-02', '23:30'), TZ, newId));
  m = applyChanges(m, stopTimer(m, cst('2026-11-03', '00:30'), TZ, newId));
  assert.deepEqual(m.map((x) => [x.day, x.subtaskId]).sort(), [['2026-11-02', 's1'], ['2026-11-03', 's1']]);
});
