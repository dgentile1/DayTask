import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;

test('desktop window width cap matches the page content width', () => {
  const css = readFileSync(`${root}web/styles.css`, 'utf8');
  const cs = readFileSync(`${root}desktop/MainForm.cs`, 'utf8');
  const cssMax = Number(css.match(/#app\s*\{[^}]*max-width:\s*var\(--app-max,\s*(\d+)px\)/)[1]);
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
  assert.match(src, /MaximumSize = new Size\(maxWidth, SystemInformation\.VirtualScreen\.Height\)/); // width cap
});

test('desktop max width setting is wired between the page and the shell', () => {
  const cs = readFileSync(`${root}desktop/MainForm.cs`, 'utf8');
  const state = readFileSync(`${root}desktop/DesktopSettings.cs`, 'utf8');
  const hostJs = readFileSync(`${root}web/js/host.js`, 'utf8');
  assert.match(state, /public int\? MaxWidth \{ get; set; \}/);                 // saved per computer
  assert.match(cs, /case "setMaxWidth":[\s\S]*?SetMaxWidth\(px\)/);              // page -> shell
  assert.match(cs, /type = "maxWidth"/);                                          // shell -> page
  assert.match(cs, /\(ContentWidth \+ ExtraWidth\) \* scale/);                    // window cap follows the setting
  assert.match(hostJs, /type: 'setMaxWidth'/);
  assert.match(hostJs, /setProperty\('--app-max'/);                               // page content follows the setting
});

test('web app and desktop shell each carry a version shown in Settings > About', () => {
  const web = readFileSync(`${root}web/js/version.js`, 'utf8');
  const csproj = readFileSync(`${root}desktop/DayTask.Desktop.csproj`, 'utf8');
  const cs = readFileSync(`${root}desktop/MainForm.cs`, 'utf8');
  const app = readFileSync(`${root}web/js/app.js`, 'utf8');
  assert.match(web, /export const WEB_VERSION = '\d+\.\d+\.\d+';/);
  assert.match(csproj, /<Version>\d+\.\d+\.\d+<\/Version>/);
  assert.match(cs, /type = "shell", version = AppVersion/);   // shell -> page
  assert.match(app, /\$\{esc\(WEB_VERSION\)\}/);                // shown in Settings
});
