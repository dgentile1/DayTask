import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, onColor, readableOn, themeVars, normalizeColors, SURFACES } from '../web/js/core/colors.js';
import { normalizeSettings } from '../web/js/core/schedule.js';

test('contrast maths', () => {
  assert.equal(Math.round(contrast('#000000', '#FFFFFF')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.equal(onColor('#FFE066'), '#111111'); // pale yellow fill -> dark text
  assert.equal(onColor('#2C64A8'), '#FFFFFF');
});

test('picked colours are nudged until text is readable, in both themes', () => {
  for (const theme of ['light', 'dark']) {
    const bgs = [SURFACES[theme].surface, SURFACES[theme].paper];
    for (const pick of ['#FFE066', '#00FF00', '#1A1A1A', '#8E44AD', '#FF0000']) {
      const c = readableOn(pick, bgs, theme);
      for (const bg of bgs) assert.ok(contrast(c, bg) >= 4.5, `${pick} in ${theme}: ${c} on ${bg}`);
    }
  }
  assert.equal(readableOn('#2C64A8', ['#FFFFFF'], 'light'), '#2C64A8'); // already fine: unchanged
});

test('theme vars only for customised colours', () => {
  const v = themeVars({ work: '#FFE066' }, 'light');
  assert.equal(v['--work'], '#FFE066');           // band keeps the exact pick
  assert.equal(v['--on-work'], '#111111');        // with dark text on it
  assert.ok(contrast(v['--work-text'], '#FFFFFF') >= 4.5);
  assert.equal(v['--home'], undefined);
  const s = themeVars({ soon: '#3366FF' }, 'dark');
  assert.ok(contrast(s['--soon'], s['--soon-bg']) >= 4.5); // banner text readable on its own tint
});

test('settings: colours and theme are validated', () => {
  assert.deepEqual(normalizeColors({ work: '#abcdef', home: 'red', nope: '#000000' }), { work: '#ABCDEF' });
  const s = normalizeSettings({ colors: { work: '#123456', home: 'x' }, theme: 'neon' });
  assert.deepEqual(s.colors, { work: '#123456' });
  assert.equal(s.theme, 'auto');
  assert.equal(normalizeSettings({ theme: 'dark' }).theme, 'dark');
});
