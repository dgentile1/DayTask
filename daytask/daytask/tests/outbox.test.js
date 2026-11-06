import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, applyOutbox, isRetryable, isPermanent, isDuplicate } from '../web/js/core/outbox.js';

const kinds = (q) => q.map((o) => `${o.kind}:${o.taskId ?? ''}`);

test('updates fold into an unsent insert or update', () => {
  let q = [];
  q = enqueue(q, { kind: 'insert', taskId: 'a', row: { id: 'a', title: 'A', note: '' } });
  q = enqueue(q, { kind: 'update', taskId: 'a', patch: { title: 'A2' } });
  q = enqueue(q, { kind: 'update', taskId: 'a', patch: { note: 'n' } });
  assert.deepEqual(kinds(q), ['insert:a']);
  assert.deepEqual(q[0].row, { id: 'a', title: 'A2', note: 'n' });
  q = enqueue(q, { kind: 'update', taskId: 'b', patch: { title: 'B' } });
  q = enqueue(q, { kind: 'update', taskId: 'b', patch: { sortKey: 5 } });
  assert.deepEqual(kinds(q), ['insert:a', 'update:b']);
  assert.deepEqual(q[1].patch, { title: 'B', sortKey: 5 });
});

test('the op being sent is never changed; later edits queue behind it', () => {
  let q = enqueue([], { kind: 'update', taskId: 'b', patch: { title: 'B' } });
  const locked = q[0].opId;
  q = enqueue(q, { kind: 'update', taskId: 'b', patch: { note: 'x' } }, locked);
  assert.deepEqual(kinds(q), ['update:b', 'update:b']);
  assert.deepEqual(q[0].patch, { title: 'B' });
});

test('deleting a never-sent task cancels it entirely; otherwise pending updates are dropped', () => {
  let q = enqueue([], { kind: 'insert', taskId: 'a', row: { id: 'a' } });
  q = enqueue(q, { kind: 'update', taskId: 'a', patch: { title: 'x' } });
  q = enqueue(q, { kind: 'update', taskId: 'z', patch: { title: 'z' } });
  q = enqueue(q, { kind: 'delete', taskId: 'a' });
  assert.deepEqual(kinds(q), ['update:z']);
  q = enqueue(q, { kind: 'update', taskId: 'c', patch: { title: 'c' } });
  q = enqueue(q, { kind: 'delete', taskId: 'c' });
  assert.deepEqual(kinds(q), ['update:z', 'delete:c']);
});

test('only the latest settings are kept', () => {
  let q = enqueue([], { kind: 'settings', settings: { a: 1 } });
  q = enqueue(q, { kind: 'update', taskId: 'x', patch: {} });
  q = enqueue(q, { kind: 'settings', settings: { a: 2 } });
  assert.deepEqual(q.map((o) => o.kind), ['update', 'settings']);
  assert.deepEqual(q[1].settings, { a: 2 });
});

test('queued changes are shown on top of fetched data', () => {
  const fetched = [{ id: 'a', title: 'A', note: 'server note' }, { id: 'b', title: 'B' }];
  let q = enqueue([], { kind: 'update', taskId: 'a', patch: { title: 'A offline' } });
  q = enqueue(q, { kind: 'delete', taskId: 'b' });
  q = enqueue(q, { kind: 'insert', taskId: 'c', row: { id: 'c', title: 'C' } });
  q = enqueue(q, { kind: 'settings', settings: { theme: 'dark' } });
  const r = applyOutbox(fetched, { theme: 'auto' }, q);
  assert.deepEqual(r.tasks, [{ id: 'a', title: 'A offline', note: 'server note' }, { id: 'c', title: 'C' }]); // other fields kept
  assert.deepEqual(r.settings, { theme: 'dark' });
  assert.equal(fetched[0].title, 'A'); // input untouched
  // An insert already on the server isn't duplicated.
  assert.equal(applyOutbox([{ id: 'c', title: 'C' }], {}, q).tasks.filter((t) => t.id === 'c').length, 1);
});

test('which failures are retried', () => {
  assert.equal(isRetryable(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryable(Object.assign(new Error('JWT expired'), { code: 'PGRST301' })), true);
  assert.equal(isPermanent({ code: '23514' }), true);  // check constraint
  assert.equal(isRetryable({ code: '22007' }), false);  // bad date
  assert.equal(isDuplicate({ code: '23505' }), true);
});
