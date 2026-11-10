import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;

test('desktop window width cap matches the page content width', () => {
  const css = readFileSync(`${root}web/styles.css`, 'utf8');
  const cs = readFileSync(`${root}desktop/MainForm.cs`, 'utf8');
  const cssMax = Number(css.match(/#app\s*\{[^}]*max-width:\s*(\d+)px/)[1]);
  const csMax = Number(cs.match(/const int ContentMaxWidth = (\d+);/)[1]);
  const extra = Number(cs.match(/const int ExtraWidth = (\d+);/)[1]);
  assert.equal(csMax, cssMax, 'ContentMaxWidth in MainForm.cs must equal #app max-width in styles.css');
  assert.ok(extra >= 10 && extra <= 20, 'window may be 10-20px wider than the content');
});

test('desktop shell C# is balanced and wires every always-on-top toggle', () => {
  const src = readFileSync(`${root}desktop/MainForm.cs`, 'utf8');
  const code = src
    .replace(/\$?"""[\s\S]*?"""/g, '""')        // raw string literals
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')         // normal strings
    .replace(/'(?:[^'\\\n]|\\.)'/g, "''")            // chars
    .replace(/\/\/.*$/gm, '');                         // comments
  for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    assert.equal(code.split(o).length, code.split(c).length, `unbalanced ${o}${c}`);
  }
  assert.match(src, /case "toggleTopMost": SetTopMost\(!TopMost\)/);          // header button in the page
  assert.match(src, /_topMenuItem\.Click \+= \(_, _\) => SetTopMost\(!TopMost\)/); // tray menu
  assert.match(src, /AcceleratorKeyPressed/);                                    // Ctrl+Shift+T
  assert.match(src, /MaximumSize = new Size\(maxWidth, 0\)/);                   // width cap
});
