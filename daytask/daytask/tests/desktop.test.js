import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

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
  assert.match(src, /WindowScaling\.LimitTrackSize\(m\.LParam, minimum, maxWidth\)/); // width cap
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

test('the window is resized for the screen it lands on, even while minimized', () => {
  const cs = readFileSync(`${root}desktop/MainForm.cs`, 'utf8');
  const scaling = readFileSync(`${root}desktop/WindowScaling.cs`, 'utf8');
  const state = readFileSync(`${root}desktop/DesktopSettings.cs`, 'utf8');

  // The size limits are answered per resize, not held in Form.MinimumSize/MaximumSize, which
  // WinForms rescales a second time after a DPI change and which are the previous screen's
  // numbers at the moment a minimized window is restored onto a new one.
  assert.match(cs, /case WindowScaling\.WmGetMinMaxInfo/);
  assert.doesNotMatch(cs, /MinimumSize\s*=/, 'MinimumSize goes stale across screens');
  assert.doesNotMatch(cs, /MaximumSize\s*=/, 'MaximumSize goes stale across screens');

  // Minimized or maximized, WinForms skips its own rescale, so the restore size is fixed by hand.
  assert.match(cs, /case WindowScaling\.WmDpiChanged/);
  assert.match(cs, /WindowScaling\.IsMinimizedOrMaximized\(Handle\)/);
  assert.match(cs, /WindowScaling\.ScaleRestoreBounds\(Handle, oldDpi, newDpi\)/);
  assert.match(scaling, /SetWindowPlacement/);

  // The frame can't be measured as Width - ClientSize.Width: that reads 0 while minimized.
  assert.match(scaling, /AdjustWindowRectExForDpi/);
  assert.doesNotMatch(cs, /Width - ClientSize\.Width/);

  // Saved bounds are pixels, so the scaling they were taken at is saved with them.
  assert.match(state, /public int\? Dpi \{ get; set; \}/);
  assert.match(cs, /_state\.Dpi = DeviceDpi/);                       // on close
  assert.match(cs, /_state\.Dpi is > 0 and var savedDpi/);           // on open
  assert.match(cs, /WindowScaling\.ClampToWorkingArea\(saved\)/);  // and kept on screen
});
