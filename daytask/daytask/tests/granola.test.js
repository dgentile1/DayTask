import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGranolaNotes, extractDue } from '../web/js/integrations/granola/parser.js';
import { runGranolaImport } from '../web/js/integrations/granola/importer.js';

const opts = { ownerAliases: ['Derrick'], referenceDate: '2026-11-02' }; // Monday

test('inline owners, notes from sub-bullets, done items, other people', () => {
  const md = `# Onan AGS sync
## Summary
- Talked about the AGS quote
### Action Items
- Derrick: Send revised quote to Marcus by Friday
  - include the disclaimer language
- Marcus: Review firmware build
- [x] Derrick: Book the test bench
- Update wiring diagram (Derrick)
- Derrick and Marcus to review harness pinout #work
## Decisions
- Derrick: this is a decision, not a task`;
  const r = parseGranolaNotes(md, opts);
  assert.equal(r.meetingTitle, 'Onan AGS sync');
  assert.equal(r.foundSection, true);
  assert.deepEqual(r.items.map((i) => [i.title, i.isMine, i.done]), [
    ['Send revised quote to Marcus', true, false],
    ['Review firmware build', false, false],
    ['Book the test bench', true, true],
    ['Update wiring diagram', true, false],
    ['Review harness pinout', true, false],
  ]);
  assert.equal(r.items[0].dueDate, '2026-11-06');
  assert.match(r.items[0].note, /From Granola: Onan AGS sync/);
  assert.match(r.items[0].note, /• include the disclaimer language/);
  assert.equal(r.items[4].context, 'work');
  assert.match(r.items[4].note, /Assigned: Derrick and Marcus/);
});

test('owner labels and owner bullets group the items under them', () => {
  const md = `Next Steps:
**Derrick**
- Order replacement relay #home
- Update the AGS doc
**Marcus**
- Flash test units

Action items
- Derrick
  - Call Victron rep tomorrow
    - ask about lead time
- Marcus
  - Check CAN logs`;
  const r = parseGranolaNotes(md, opts);
  const mine = r.items.filter((i) => i.isMine);
  assert.deepEqual(mine.map((i) => i.title), ['Order replacement relay', 'Update the AGS doc', 'Call Victron rep']);
  assert.equal(mine[0].context, 'home');
  assert.equal(mine[1].context, null);
  assert.equal(mine[2].dueDate, '2026-11-03');
  assert.match(mine[2].note, /ask about lead time/);
  assert.equal(r.items.filter((i) => !i.isMine).length, 2);
});

test('no action section: only checkbox lines count', () => {
  const r = parseGranolaNotes(`Weekly sync\n- general chatter\n- [ ] Derrick to renew domain\n- [ ] Pick up parts`, opts);
  assert.equal(r.foundSection, false);
  assert.deepEqual(r.items.map((i) => [i.title, i.isMine, i.owner]), [
    ['Renew domain', true, 'Derrick'],
    ['Pick up parts', false, null],
  ]);
});

test('aliases are configurable', () => {
  const r = parseGranolaNotes(`## Action Items\n- DJ: Send logs\n- Marcus: Not mine`, { ...opts, ownerAliases: ['Derrick', 'DJ'] });
  assert.deepEqual(r.items.map((i) => i.isMine), [true, false]);
});

test('due phrases', () => {
  assert.deepEqual(extractDue('Send it by 11/5', '2026-11-02'), { text: 'Send it', dueDate: '2026-11-05' });
  assert.equal(extractDue('Ship by Jan 4', '2026-12-20').dueDate, '2027-01-04');
  assert.equal(extractDue('Do it by EOD', '2026-11-02').dueDate, '2026-11-02');
  assert.equal(extractDue('Do it next week', '2026-11-04').dueDate, '2026-11-09');
  assert.equal(extractDue('No date here', '2026-11-02').dueDate, null);
});

test('importer auto-adds only my open items and de-duplicates re-imports', async () => {
  const md = `# Sync\n## Action Items\n- Derrick: A task\n- Marcus: Their task\n- [x] Derrick: Done task`;
  const log = new Set();
  let n = 0;
  const deps = {
    aliases: ['Derrick'], today: '2026-11-02',
    existingFingerprints: async (fps) => new Set(fps.filter((f) => log.has(f))),
    addTask: async (t) => ({ ...t, id: `t${++n}` }),
    logImport: async (fp) => { log.add(fp); },
  };
  const first = await runGranolaImport({ text: md }, deps);
  assert.deepEqual(first.added.map((t) => [t.title, t.context, t.source, t.dueDate]), [['A task', null, 'granola', null]]);
  assert.deepEqual(first.skipped.map((s) => s.reason), ['other', 'done']);

  const other = first.skipped.find((s) => s.reason === 'other').item.fingerprint;
  const second = await runGranolaImport({ text: md, force: [other] }, deps);
  assert.deepEqual(second.added.map((t) => t.title), ['Their task']);
  assert.deepEqual(second.skipped.map((s) => s.reason).sort(), ['done', 'duplicate']);
});
