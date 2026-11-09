"""Offline end-to-end check: real service worker on localhost, desktop goes offline, works, reopens, reconnects.
Run: cd tests/e2e && pip install playwright && playwright install chromium && python offline.py
"""
import json, uuid, re, sys, os, shutil, threading, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, '..', '..', 'web')
SITE = '/tmp/daytask-offline-site'
PORT = 8765
MON_10 = '2026-11-02T16:00:00Z'  # Mon 10:00 CST

# Copy of the app with the fake backend in place of supabase-js and a filled-in config.
shutil.rmtree(SITE, ignore_errors=True)
shutil.copytree(WEB, SITE)
shutil.copy(os.path.join(HERE, 'fake-supabase.js'), os.path.join(SITE, 'vendor', 'supabase.js'))
with open(os.path.join(SITE, 'config.js'), 'w') as f:
    f.write("export const DAYTASK_CONFIG={supabaseUrl:'https://fake.supabase.co',supabaseAnonKey:'x'};")

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
server = ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(Quiet, directory=SITE))
threading.Thread(target=server.serve_forever, daemon=True).start()

db = {'tasks': [], 'user_settings': [], 'import_log': [], 'time_entries': []}
state = {'version': 0}

def matches(row, f):
    for flt in f:
        if flt[0] == 'eq' and str(row.get(flt[1])) != str(flt[2]): return False
        if flt[0] == 'in' and row.get(flt[1]) not in flt[2]: return False
        if flt[0] == 'or':  # PostgREST "a.op.v,b.op.v": any clause matching is enough
            def clause(c):
                col, op, val = c.split('.', 2)
                v = row.get(col)
                if op == 'is': return v is None
                if op == 'eq': return str(v) == val
                if op == 'gte': return v is not None and str(v) >= val
                return False
            if not any(clause(c) for c in flt[1].split(',')): return False
    return True

def handle(raw):
    p = json.loads(raw)
    if p.get('t') == '__version': return json.dumps(state['version'])
    t = db[p['t']]; a = p['action']; changed = False; out = None
    if a == 'select':
        out = sorted([r for r in t if matches(r, p['f'])], key=lambda r: r.get('sort_key', 0))
        if p['limit']: out = out[:p['limit']]
    elif a == 'insert':
        if p['t'] == 'time_entries':
            if any(r['id'] == p['payload'].get('id') for r in t):
                return json.dumps({'data': None, 'error': {'message': 'duplicate key', 'code': '23505'}})
            t.append(dict(p['payload'])); state['version'] += 1
            return json.dumps({'data': None, 'error': None})
        if any(r['id'] == p['payload'].get('id') for r in t):
            return json.dumps({'data': None, 'error': {'message': 'duplicate key', 'code': '23505'}})
        row = {'id': str(uuid.uuid4()), 'note': '', 'priority': 'normal', 'context': None, 'completed_at': None,
               'completed_on': None, 'source': 'manual', 'source_ref': None, 'subtasks': [], 'start_date': None, 'repeat': None, 'status': None,
               'created_at': '2026-11-02T14:00:00Z', 'updated_at': 'now', **p['payload']}
        t.append(row); out = row if p['single'] else [row]; changed = True
    elif a == 'update':
        for r in t:
            if matches(r, p['f']): r.update(p['payload'])
        changed = True
    elif a == 'upsert':
        row = {'user_id': 'u1', **p['payload']}
        key = 'fingerprint' if p['t'] == 'import_log' else 'user_id'
        t[:] = [r for r in t if r.get(key) != row.get(key)] + [row]; changed = True
    elif a == 'delete':
        t[:] = [r for r in t if not matches(r, p['f'])]; changed = True
    if changed: state['version'] += 1
    return json.dumps({'data': out, 'error': None})

def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: check.failed = True
check.failed = False
errors = []

def row(title):
    r = [x for x in db['tasks'] if x['title'] == title]
    return r[0] if r else None

def open_app(ctx, name):
    pg = ctx.new_page()
    pg.clock.set_fixed_time(MON_10)
    pg.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    pg.expose_function('__db', handle)
    pg.goto(f'http://localhost:{PORT}/index.html')
    pg.wait_for_selector('#band .day')
    pg.wait_for_timeout(400)
    return pg

def titles(pg, lst):
    return pg.eval_on_selector_all(f'ul[data-list="{lst}"] .t', 'els => els.map(e => e.textContent)')

def add(pg, title, ctx_btn='work'):
    pg.click(f'#add [data-ctx="{ctx_btn}"]')
    pg.fill('#add input[name=title]', title); pg.press('#add input[name=title]', 'Enter'); pg.wait_for_timeout(300)

def pill(pg):
    return ' '.join(pg.locator('.sync-slot').inner_text().split()) if pg.locator('.sync-slot').count() else ''

with sync_playwright() as p:
    exe = os.environ.get('CHROMIUM')
    browser = p.chromium.launch(**({'executable_path': exe} if exe else {}))
    desk_ctx = browser.new_context(viewport={'width': 400, 'height': 900}, timezone_id='America/Chicago')
    phone_ctx = browser.new_context(viewport={'width': 390, 'height': 844}, timezone_id='America/Chicago')

    # Online first visit: the service worker installs and stores the app.
    desk = open_app(desk_ctx, 'desktop')
    desk.evaluate("navigator.serviceWorker.ready.then(() => true)")
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(400)
    check(desk.evaluate("!!navigator.serviceWorker.controller"), 'service worker installed and controlling the page')
    add(desk, 'Review harness drawing')
    add(desk, 'Update AGS quote')
    add(desk, 'Call electrician', 'home')
    check(row('Review harness drawing') and row('Update AGS quote') and row('Call electrician'), 'online: tasks saved to Supabase')
    phone = open_app(phone_ctx, 'phone')

    # Offline.
    desk_ctx.set_offline(True)
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(500)
    check(titles(desk, 'work') == ['Review harness drawing', 'Update AGS quote'] and titles(desk, 'home') == ['Call electrician'],
          f'opens offline with your tasks: {titles(desk, "work")}')
    check(pill(desk).startswith('Offline'), f'header shows Offline: {pill(desk)!r}')
    level = desk.evaluate("""() => { const a = document.querySelector('#band .mode').getBoundingClientRect(), b = document.querySelector('#band .sync-pill').getBoundingClientRect();
      return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 6 && b.left > a.left; }""")
    check(level, 'Offline sits under the connection dot, level with the work-hours line')
    band_h = desk.locator('#band').bounding_box()['height']

    before = json.dumps(db, sort_keys=True)
    add(desk, 'Draft wiring notes')                                                     # add
    desk.locator('li.task', has_text='Review harness drawing').locator('.check').click()  # check off
    desk.wait_for_timeout(300)
    desk.locator('li.task', has_text='Update AGS quote').locator('[data-act="expand"]').click()
    desk.fill('li.task.ctx-work input[data-field="title"]', 'Update AGS quote v2')       # rename
    desk.locator('li.task.ctx-work input[data-field="title"]').press('Tab'); desk.wait_for_timeout(300)
    box = desk.locator('li.task', has_text='Update AGS quote v2').locator('[data-sub-new]')
    box.fill('Check lead times'); box.press('Enter'); desk.wait_for_timeout(300)        # subtask
    desk.locator('li.task', has_text='Update AGS quote v2').locator('[data-act="collapse"]').click()
    add(desk, 'Temporary task')
    desk.locator('li.task', has_text='Temporary task').locator('[data-act="expand"]').click()
    desk.locator('li.task', has_text='Temporary task').locator('[data-act="delete"]').click(); desk.wait_for_timeout(300)  # add then delete
    desk.click('.tabs [data-view="settings"]')
    desk.fill('input[name=dueSoonDays]', '5'); desk.click('#settings-form button[type=submit]'); desk.wait_for_timeout(300)  # settings
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    check(json.dumps(db, sort_keys=True) == before, 'offline: nothing reaches Supabase')
    check('Draft wiring notes' in titles(desk, 'work') and 'Update AGS quote v2' in titles(desk, 'work')
          and 'Temporary task' not in titles(desk, 'work'), f'offline changes show immediately: {titles(desk, "work")}')
    check(re.search(r'Offline · \d+ saved', pill(desk)) is not None
          and 'saved on this device' in desk.get_attribute('#band .sync-pill', 'title'), f'header counts unsynced changes: {pill(desk)!r}')
    check(abs(desk.locator('#band').bounding_box()['height'] - band_h) < 1, 'header height never changes while offline changes pile up')
    pending = int(re.search(r'(\d+) saved', pill(desk)).group(1))
    desk.locator('#band').screenshot(path=os.path.join(HERE, 'band-offline.png'))
    desk.screenshot(path=os.path.join(HERE, 'offline.png'))
    check(pending == 4, f'add+delete of the same task cancel out; edits to one task are combined: {pending} queued')

    # Close and reopen while still offline.
    desk.close()
    desk = open_app(desk_ctx, 'desktop-reopened')
    check('Draft wiring notes' in titles(desk, 'work') and 'Update AGS quote v2' in titles(desk, 'work')
          and 'Review harness drawing' not in titles(desk, 'work'), 'reopened offline: offline changes still there')
    check(desk.locator('li.task', has_text='Update AGS quote v2').locator('.sub-toggle').inner_text() == '0/1', 'offline subtask kept')
    check(pill(desk) == 'Offline · 4 saved', f'queue survives closing the app: {pill(desk)!r}')

    # Meanwhile, the phone (online) edits a different field of the same task.
    phone.locator('li.task', has_text='Update AGS quote').locator('[data-act="expand"]').click()
    phone.fill('li.task.ctx-work textarea[data-field="note"]', 'Customer wants Onan option')
    phone.locator('li.task.ctx-work textarea[data-field="note"]').press('Tab'); phone.wait_for_timeout(400)
    check(row('Update AGS quote')['note'] == 'Customer wants Onan option', 'phone edit saved while desktop is offline')

    # Back online: everything is sent, in order.
    desk_ctx.set_offline(False)
    desk.wait_for_timeout(2500)
    r = row('Update AGS quote v2')
    check(r is not None and r['note'] == 'Customer wants Onan option' and [s['title'] for s in r['subtasks']] == ['Check lead times'],
          f'reconnected: offline title + subtask and phone note both kept: {r and (r["title"], r["note"], r["subtasks"])}')
    check(row('Draft wiring notes') is not None and row('Review harness drawing')['completed_at'] is not None
          and row('Temporary task') is None, 'offline add, check-off and cancelled add synced correctly')
    check(db['user_settings'] and db['user_settings'][0]['settings']['dueSoonDays'] == 5, 'offline settings change synced')
    check(pill(desk) == '', f'header clears once everything is synced: {pill(desk)!r}')
    check(desk.evaluate("JSON.parse(localStorage.getItem('daytask.outbox.v1') || '[]').length") == 0, 'device queue empty')
    phone.wait_for_timeout(1500)
    check('Draft wiring notes' in titles(phone, 'work'), 'phone picks up the offline changes')
    check(desk.locator('li.task', has_text='Update AGS quote v2').count() == 1, 'desktop shows the phone note merged (no duplicates)')

    # Flaky connection mid-sync: queue, reconnect, and an insert whose reply was lost isn't duplicated.
    desk_ctx.set_offline(True); desk.wait_for_timeout(200)
    add(desk, 'Order crimp tool')
    desk_ctx.set_offline(False); desk.wait_for_timeout(2000)
    check(len([x for x in db['tasks'] if x['title'] == 'Order crimp tool']) == 1, 'reconnect sends once')

    browser.close()

server.shutdown()
print('\n'.join(errors) if errors else 'no page errors')
sys.exit(1 if check.failed else 0)
