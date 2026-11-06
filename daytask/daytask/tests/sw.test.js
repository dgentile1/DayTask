import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB = new URL('../web/', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [relative(WEB, p)];
});

test('the service worker stores every file the app needs offline', () => {
  const src = readFileSync(join(WEB, 'sw.js'), 'utf8');
  const listed = [...src.matchAll(/^\s*'([^']+)',$/gm)].map((m) => m[1]).filter((f) => f !== './');
  const needed = walk(WEB).filter((f) => f !== 'sw.js' && !f.endsWith('LICENSE')).sort();
  assert.deepEqual([...listed].sort(), needed, 'sw.js FILES must match the files in web/');
  for (const f of listed) assert.ok(existsSync(join(WEB, f)), `${f} listed but missing`);
});

test('the page loads nothing from other sites (works offline)', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const css = readFileSync(join(WEB, 'styles.css'), 'utf8');
  assert.deepEqual([...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]), []);
  assert.deepEqual([...css.matchAll(/url\(['"]?(https?:[^'")]+)/g)].map((m) => m[1]), []);
});
