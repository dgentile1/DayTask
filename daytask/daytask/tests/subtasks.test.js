import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSubtasks, addSubtask, setSubtaskDone, renameSubtask, removeSubtask, reorderSubtasks, subtaskProgress,
} from '../web/js/core/subtasks.js';

test('add, check, rename, remove, reorder, progress', () => {
  let l = [];
  l = addSubtask(l, '  Pull CAN logs ');
  l = addSubtask(l, 'Flash unit');
  l = addSubtask(l, '   '); // ignored
  assert.deepEqual(l.map((s) => s.title), ['Pull CAN logs', 'Flash unit']);
  const [a, b] = l;
  l = setSubtaskDone(l, a.id, true);
  assert.deepEqual(subtaskProgress(l), { done: 1, total: 2, allDone: false });
  l = renameSubtask(l, b.id, 'Flash both units');
  l = renameSubtask(l, b.id, ''); // blank rename keeps the old title
  assert.equal(l.find((s) => s.id === b.id).title, 'Flash both units');
  assert.deepEqual(l.map((s) => s.id), [b.id, a.id]); // a (checked off) dropped to the bottom
  l = reorderSubtasks(l, [b.id, a.id]);
  assert.deepEqual(l.map((s) => s.id), [b.id, a.id]);
  l = setSubtaskDone(l, b.id, true);
  assert.equal(subtaskProgress(l).allDone, true);
  l = removeSubtask(l, a.id);
  assert.deepEqual(l.map((s) => s.id), [b.id]);
  assert.deepEqual(subtaskProgress([]), { done: 0, total: 0, allDone: false });
});

test('normalize tolerates bad stored data', () => {
  assert.deepEqual(normalizeSubtasks(null), []);
  const n = normalizeSubtasks([{ id: 'x', title: ' A ', done: 1 }, { title: '' }, null, { title: 'B' }]);
  assert.deepEqual(n.map((s) => [s.title, s.done]), [['A', true], ['B', false]]);
  assert.ok(n[1].id);
});

test('subtask due date and priority', async () => {
  const { updateSubtask } = await import('../web/js/core/subtasks.js');
  let l = addSubtask([], 'Pull logs');
  assert.equal(l[0].dueDate, null);
  assert.equal(l[0].priority, 'normal');
  const id = l[0].id;
  l = updateSubtask(l, id, { dueDate: '2026-11-04', priority: 'high' });
  assert.deepEqual([l[0].dueDate, l[0].priority], ['2026-11-04', 'high']);
  l = updateSubtask(l, id, { dueDate: 'nonsense' });
  assert.equal(l[0].dueDate, null); // invalid -> cleared
  l = updateSubtask(l, id, { dueDate: '2026-11-04' });
  l = updateSubtask(l, id, { priority: 'normal' });
  assert.deepEqual([l[0].dueDate, l[0].priority], ['2026-11-04', 'normal']); // untouched fields kept
  const n = normalizeSubtasks([{ title: 'A', dueDate: '2026-1-4', priority: 'urgent' }]);
  assert.deepEqual([n[0].dueDate, n[0].priority], [null, 'normal']);
});

test('dropping a task onto another: becomes subtasks, note kept', async () => {
  const { taskAsSubtasks, mergeNotes, nextDueSubtask, addSubtask: add } = await import('../web/js/core/subtasks.js');
  const moved = { title: 'Order parts', dueDate: '2026-11-06', priority: 'high', note: 'Use the Digikey cart',
    subtasks: [{ id: 'a', title: 'Relay', done: true, dueDate: null, priority: 'normal' },
               { id: 'b', title: 'Fuses', done: false, dueDate: '2026-11-04', priority: 'normal' }] };
  const subs = taskAsSubtasks(moved);
  assert.deepEqual(subs.map((s) => [s.title, s.done, s.dueDate, s.priority]), [
    ['Order parts', false, '2026-11-06', 'high'],
    ['Relay', true, null, 'normal'],
    ['Fuses', false, '2026-11-04', 'normal'],
  ]);
  assert.equal(new Set(subs.map((s) => s.id)).size, 3);
  assert.equal(mergeNotes('', 'Order parts', 'Use the Digikey cart'), 'From "Order parts":\nUse the Digikey cart');
  assert.equal(mergeNotes('Existing', 'Order parts', 'X'), 'Existing\n\nFrom "Order parts":\nX');
  assert.equal(mergeNotes('Existing', 'Order parts', '  '), 'Existing');

  assert.equal(nextDueSubtask([]), null);
  let l = add([], 'Later', { dueDate: '2026-11-09' });
  l = add(l, 'Soon normal', { dueDate: '2026-11-04' });
  l = add(l, 'Soon high', { dueDate: '2026-11-04', priority: 'high' });
  l = add(l, 'No date');
  assert.equal(nextDueSubtask(l).title, 'Soon normal'); // same date: your order decides, not priority
  assert.equal(add([], 'x', { dueDate: 'bad' })[0].dueDate, null);
});

test('dates place a subtask when set; after that your order wins', async () => {
  const { sortSubtasks, subtaskGroup, updateSubtask, setSubtaskDone, reorderSubtasks } = await import('../web/js/core/subtasks.js');
  const names = (l) => l.map((s) => s.title);
  let l = ['File form', 'Emissions test', 'Pay fee'].reduce((acc, t) => addSubtask(acc, t), []);
  const id = (t) => l.find((s) => s.title === t).id;
  assert.deepEqual(names(l), ['File form', 'Emissions test', 'Pay fee']);                       // added in order
  l = updateSubtask(l, id('Pay fee'), { dueDate: '2026-12-05' });
  assert.deepEqual(names(l), ['Pay fee', 'File form', 'Emissions test']);                       // dated: ahead of undated
  l = updateSubtask(l, id('File form'), { dueDate: '2026-12-01' });
  assert.deepEqual(names(l), ['File form', 'Pay fee', 'Emissions test']);                       // earlier date: ahead of later
  l = updateSubtask(l, id('Emissions test'), { dueDate: '2026-12-01' });
  assert.deepEqual(names(l), ['File form', 'Emissions test', 'Pay fee']);                       // same date: after the others
  l = sortSubtasks(reorderSubtasks(l, [id('Pay fee'), id('File form'), id('Emissions test')]));
  assert.deepEqual(names(l), ['Pay fee', 'File form', 'Emissions test']);                       // drag a later date to the top: stays
  l = addSubtask(l, 'Call DMV');
  l = sortSubtasks(reorderSubtasks(l, [id('Call DMV') ?? l[3].id, ...l.filter((s) => s.title !== 'Call DMV').map((s) => s.id)].filter(Boolean)));
  l = sortSubtasks(reorderSubtasks(l, [l.find((s) => s.title === 'Call DMV').id, ...l.filter((s) => s.title !== 'Call DMV').map((s) => s.id)]));
  assert.deepEqual(names(l), ['Call DMV', 'Pay fee', 'File form', 'Emissions test']);           // undated above dated: stays
  l = updateSubtask(l, l[0].id, { priority: 'high' });
  assert.deepEqual(names(l), ['Call DMV', 'Pay fee', 'File form', 'Emissions test']);           // other edits don't move anything
  l = setSubtaskDone(l, id('File form'), true);
  assert.deepEqual(names(l), ['Call DMV', 'Pay fee', 'Emissions test', 'File form']);           // done: to the bottom
  l = setSubtaskDone(l, id('File form'), false);
  assert.deepEqual(names(l), ['File form', 'Call DMV', 'Pay fee', 'Emissions test']);           // unchecked: slots in by date
  l = updateSubtask(l, id('Pay fee'), { dueDate: null });
  assert.deepEqual(names(l), ['File form', 'Call DMV', 'Pay fee', 'Emissions test']);           // clearing a date: stays put
  assert.deepEqual([...new Set(l.map(subtaskGroup))], ['open']);
});

test('statuses on tasks and subtasks', async () => {
  const { cleanStatus, updateSubtask, taskAsSubtasks, statusSuggestions } = await import('../web/js/core/subtasks.js');
  assert.equal(cleanStatus('   '), null);
  assert.equal(cleanStatus('  Waiting   on  parts '), 'Waiting on parts');
  assert.equal(cleanStatus('x'.repeat(80)).length, 60);
  let l = addSubtask([], 'Order relay');
  assert.equal(l[0].status, null);
  l = updateSubtask(l, l[0].id, { status: 'Waiting on vendor' });
  assert.equal(l[0].status, 'Waiting on vendor');
  l = updateSubtask(l, l[0].id, { dueDate: '2026-11-05' });
  assert.equal(l[0].status, 'Waiting on vendor'); // other edits keep it
  l = updateSubtask(l, l[0].id, { status: '' });
  assert.equal(l[0].status, null);              // cleared
  assert.equal(normalizeSubtasks([{ title: 'A', status: '  Blocked ' }])[0].status, 'Blocked');
  assert.equal(taskAsSubtasks({ title: 'T', status: 'In progress', subtasks: [] })[0].status, 'In progress'); // kept when nested
  const sugg = statusSuggestions([{ status: 'Waiting on Marcus', subtasks: [{ status: 'blocked' }, { status: 'Parts ordered' }] }]);
  assert.deepEqual(sugg, ['In progress', 'Waiting', 'Blocked', 'On hold', 'Needs review', 'Waiting on Marcus', 'Parts ordered']);
});
