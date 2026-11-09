"""End-to-end check: desktop + phone pages share a fake Supabase; clock pinned to Mon 2026-11-02 (America/Chicago).
Run: cd tests/e2e && npm i sortablejs@1.15.2 && pip install playwright && playwright install chromium && python run.py
"""
import json, uuid, re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
from playwright.sync_api import sync_playwright

WEB = os.path.join(HERE, '..', '..', 'web')
db = {'tasks': [], 'user_settings': [], 'import_log': [], 'time_entries': []}
pages = []

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

state = {'version': 0}
def handle(raw):
    p = json.loads(raw)
    if p.get('t') == '__version': return json.dumps(state['version'])
    t = db[p['t']]; a = p['action']; changed = False
    if a == 'select':
        rows = [r for r in t if matches(r, p['f'])]
        if p['t'] == 'tasks': rows.sort(key=lambda r: r['sort_key'])
        if p['limit']: rows = rows[:p['limit']]
        out = rows
    elif a == 'insert':
        if p['t'] == 'time_entries':
            if any(r['id'] == p['payload'].get('id') for r in t):
                return json.dumps({'data': None, 'error': {'message': 'duplicate key', 'code': '23505'}})
            t.append(dict(p['payload'])); state['version'] += 1
            return json.dumps({'data': None, 'error': None})
        if any(r['id'] == p['payload'].get('id') for r in t):
            return json.dumps({'data': None, 'error': {'message': 'duplicate key', 'code': '23505'}})
        row = {'id': str(uuid.uuid4()), 'note': '', 'priority': 'normal', 'context': None, 'completed_at': None,
               'completed_on': None, 'source': 'manual', 'source_ref': None, 'created_at': '2026-11-02T14:00:00Z', 'subtasks': [], 'start_date': None, 'repeat': None, 'status': None, 'updated_at': 'now', **p['payload']}
        t.append(row); out = row if p['single'] else [row]; changed = True
    elif a == 'update':
        for r in t:
            if matches(r, p['f']): r.update(p['payload'])
        out = None; changed = True
    elif a == 'upsert':
        row = {'user_id': 'u1', **p['payload']}
        key = 'fingerprint' if p['t'] == 'import_log' else 'user_id'
        t[:] = [r for r in t if r.get(key) != row.get(key)] + [row]; out = None; changed = True
    elif a == 'delete':
        t[:] = [r for r in t if not matches(r, p['f'])]; out = None; changed = True
    if changed: state['version'] += 1
    return json.dumps({'data': out, 'error': None})

def route(r):
    url = r.request.url
    if url.endswith('/vendor/supabase.js'): return r.fulfill(path=os.path.join(HERE, 'fake-supabase.js'), content_type='text/javascript')
    if url.endswith('/config.js'):
        return r.fulfill(body="export const DAYTASK_CONFIG={supabaseUrl:'https://fake.supabase.co',supabaseAnonKey:'x'};", content_type='text/javascript')
    path = url.split('http://app.test/')[1].split('?')[0] or 'index.html'
    ctype = {'js': 'text/javascript', 'css': 'text/css', 'html': 'text/html', 'svg': 'image/svg+xml', 'woff2': 'font/woff2'}.get(path.rsplit('.', 1)[-1], 'application/json')
    return r.fulfill(path=f'{WEB}/{path}', content_type=ctype)

errors = []
HOST_MOCK = """
window.__hostMsgs = [];
(() => {
  const listeners = []; let top = false;
  const send = (m) => setTimeout(() => listeners.forEach((cb) => cb({ data: m })), 0);
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    addEventListener(_t, cb) { listeners.push(cb); },
    postMessage(m) {
      window.__hostMsgs.push(m);
      if (m.type === 'hello') send({ type: 'topMost', value: top });
      if (m.type === 'toggleTopMost') { top = !top; send({ type: 'topMost', value: top }); }
    },
  };
})();
"""

def open_page(browser, w, h, when, name, scheme='light', desktop_host=False, ctx=None):
    ctx = ctx or browser.new_context(viewport={'width': w, 'height': h}, timezone_id='America/Chicago', color_scheme=scheme)
    pg = ctx.new_page()
    pg.clock.set_fixed_time(when)
    if desktop_host: pg.add_init_script(HOST_MOCK)
    pg.on('pageerror', lambda e: errors.append(f'{name}: {e}'))
    pg.on('console', lambda m: errors.append(f'{name} console: {m.text}') if m.type == 'error' and 'ERR_FAILED' not in m.text else None)
    pg.expose_function('__db', handle)
    pg.route('**/*', route)
    pg.goto('http://app.test/index.html')
    pg.wait_for_selector('#band .day')
    pg.wait_for_timeout(300)
    return pg

def titles(pg, lst):
    return pg.eval_on_selector_all(f'ul[data-list="{lst}"] .t', 'els => els.map(e => e.textContent)')

def badge(pg, title):
    return pg.locator('li.task', has_text=title).first.locator('.title-btn .meta').inner_text()

def notifies(pg):
    return pg.evaluate("window.__hostMsgs.filter(m => m.type === 'notify')")

OVERFLOW_JS = """() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.right > vw + 1) bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(r.right)}`);
  }
  return { scroll: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 6) };
}"""
def no_overflow(pg, where):
    o = pg.evaluate(OVERFLOW_JS)
    check(o['scroll'] <= o['vw'], f'no sideways scrolling ({where}): {o}')

def boxes(pg, *locs):
    """Bounding boxes once every element is on screen (waits out a sync redraw)."""
    for _ in range(20):
        bs = [l.bounding_box() for l in locs]
        if all(bs): return bs
        pg.wait_for_timeout(100)
    raise AssertionError('element never settled on screen')

def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: check.failed = True
check.failed = False

def row(title):
    return [r for r in db['tasks'] if r['title'] == title][0]

with sync_playwright() as p:
    exe = os.environ.get('CHROMIUM')
    browser = p.chromium.launch(**({'executable_path': exe} if exe else {}))
    MON_0730 = '2026-11-02T13:30:00Z'  # Mon 07:30 CST, before work starts
    MON_10 = '2026-11-02T16:00:00Z'    # Mon 10:00 CST
    desk_ctx = browser.new_context(viewport={'width': 400, 'height': 900}, timezone_id='America/Chicago')
    desk = open_page(browser, 0, 0, MON_0730, 'desktop', desktop_host=True, ctx=desk_ctx)
    check(desk.locator('.pin').count() == 1, 'desktop shell detected: Keep on top button shown')
    desk.click('.pin'); desk.wait_for_timeout(200)
    check(desk.get_attribute('.pin', 'aria-pressed') == 'true', 'always-on-top toggles through the shell bridge')

    def add(pg, title, ctx=None, high=False, due=None, note=None):
        if ctx: pg.click(f'#add [data-ctx="{ctx}"]')
        if high: pg.click('#add [data-prio]')
        if due: pg.fill('#add input[name=due]', due)
        if note:
            pg.click('#add [data-toggle-note]'); pg.fill('#add textarea[name=note]', note)
        pg.fill('#add input[name=title]', title); pg.press('#add input[name=title]', 'Enter')
        pg.wait_for_timeout(250)

    add(desk, 'Send AGS quote', 'work', note='Use layered disclaimer')
    add(desk, 'Review Lyra crash fix', 'work')
    add(desk, 'Flash test units', 'work', high=True)
    add(desk, 'Fix gutter', 'home')
    add(desk, 'Order relay', 'work', due='2026-11-05')
    add(desk, 'Renew truck registration', 'home', due='2026-11-20')
    check(row('Send AGS quote')['due_date'] is None, 'due date is optional (blank = no deadline)')
    check(titles(desk, 'work') == ['Order relay', 'Flash test units', 'Send AGS quote', 'Review Lyra crash fix'],
          f'placement: dated first, then high priority: {titles(desk, "work")}')
    check('Renew truck registration' in titles(desk, 'home'), 'task due in 18 days is listed right away')
    check('Due in 3 days' in badge(desk, 'Order relay'), f'due-soon badge: {badge(desk, "Order relay")!r}')
    check('Due Fri, Nov 20' in badge(desk, 'Renew truck'), f'later badge: {badge(desk, "Renew truck")!r}')
    check(desk.locator('.due-banner').count() == 1 and 'Order relay' in desk.inner_text('.due-banner')
          and 'Renew truck' not in desk.inner_text('.due-banner'), 'daily banner lists only tasks inside the window')
    check(notifies(desk) == [], 'adding tasks never pops up a Windows notification')

    # Drag "Review Lyra crash fix" to the top of the work list.
    src = desk.locator('ul[data-list="work"] li', has_text='Review Lyra').locator('.drag')
    dst = desk.locator('ul[data-list="work"] li').first
    sb, db_ = boxes(desk, src, dst)
    desk.mouse.move(sb['x'] + 5, sb['y'] + 5); desk.mouse.down()
    end_y = db_['y'] + 4  # drop on the top edge of the first task
    for i in range(40):
        desk.mouse.move(sb['x'] + 5, sb['y'] + 5 - (sb['y'] + 5 - end_y) * (i + 1) / 40)
        desk.wait_for_timeout(15)
    desk.mouse.up(); desk.wait_for_timeout(500)
    check(titles(desk, 'work')[0] == 'Review Lyra crash fix', f'drag reorder: {titles(desk, "work")}')

    # Drag a task onto another task -> confirmation popup.
    def drag_onto(pg, src_title, dst_title, release=True):
        src = pg.locator('li.task', has_text=src_title).first.locator('.drag')
        dst = pg.locator('li.task', has_text=dst_title).first.locator('.row')
        a, b = boxes(pg, src, dst)
        x0, y0 = a['x'] + 5, a['y'] + 5
        x1, y1 = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        pg.mouse.move(x0, y0); pg.mouse.down()
        for i in range(16):
            pg.mouse.move(x0 + (x1 - x0) * (i + 1) / 16, y0 + (y1 - y0) * (i + 1) / 16); pg.wait_for_timeout(30)
        pg.wait_for_timeout(150)
        hovering = pg.locator('li.task.nest-target').count() == 1 and 'Add as subtask' in pg.evaluate(
            "getComputedStyle(document.querySelector('li.task.nest-target .row'), '::after').content")
        if release: pg.mouse.up(); pg.wait_for_timeout(300)
        return hovering
    work_before = titles(desk, 'work')
    check(drag_onto(desk, 'Flash test units', 'Order relay'), 'hovering over the middle of a task highlights "Add as subtask"')
    desk.screenshot(path=os.path.join(HERE, 'nest-dialog.png'))
    check(desk.locator('#nest-dialog[open]').count() == 1 and 'Make Flash test units a subtask of Order relay?' in desk.inner_text('#nest-dialog')
          and 'High priority' in desk.inner_text('#nest-dialog'), 'popup asks before adding, and says what carries over')
    desk.click('#nest-dialog [value="cancel"]'); desk.wait_for_timeout(300)
    check(titles(desk, 'work') == work_before and row('Order relay')['subtasks'] == [], 'Cancel leaves both tasks exactly as they were')
    drag_onto(desk, 'Flash test units', 'Order relay')
    desk.keyboard.press('Escape'); desk.wait_for_timeout(300)
    check(titles(desk, 'work') == work_before, 'Escape also cancels')
    drag_onto(desk, 'Flash test units', 'Order relay')
    desk.click('#nest-dialog [value="add"]'); desk.wait_for_timeout(500)
    rel = row('Order relay')['subtasks']
    check([(x['title'], x['priority'], x['done']) for x in rel] == [('Flash test units', 'high', False)]
          and not [r for r in db['tasks'] if r['title'] == 'Flash test units'], f'Add as subtask: moved in, keeps High: {rel}')
    check(desk.locator('li.task', has_text='Order relay').locator('ul.subtasks li', has_text='Flash test units').count() == 1,
          'it shows under its new task')
    desk.click('#toast button'); desk.wait_for_timeout(600)
    check(titles(desk, 'work') == work_before and row('Order relay')['subtasks'] == [], f'Undo puts it back where it was: {titles(desk, "work")}')
    # Reordering still works by dropping near a row's edge.
    check(titles(desk, 'work')[0] == 'Review Lyra crash fix', 'normal reorder unaffected')

    # Reopening the desktop app (same profile): notification every time it opens.
    desk.close()
    desk = open_page(browser, 0, 0, MON_10, 'desktop-reopen', desktop_host=True, ctx=desk_ctx)
    n = notifies(desk)
    check(len(n) == 1 and n[0]['title'] == '1 item due soon' and 'Order relay: due in 3 days' in n[0]['body'],
          f'Windows notification when the app opens: {n}')
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(300)
    check(len(notifies(desk)) == 1, 'notification shows again on the next open')
    desk.wait_for_timeout(200)
    check(len(notifies(desk)) == 1, 'and only once per open')

    # Banner: hide and show like the note toggle; always open again on reopen.
    desk.click('[data-act="toggle-due-banner"]'); desk.wait_for_timeout(150)
    check(desk.locator('.due-banner').count() == 1 and not desk.locator('#due-list').is_visible()
          and desk.inner_text('[data-act="toggle-due-banner"]') == 'Show', 'Hide collapses the banner but keeps its header')
    desk.click('[data-act="toggle-due-banner"]'); desk.wait_for_timeout(150)
    check(desk.locator('#due-list').is_visible(), 'Show reopens it')
    desk.click('[data-act="toggle-due-banner"]'); desk.wait_for_timeout(150)
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(300)
    check(desk.locator('#due-list').is_visible(), 'banner is open again after reopening the app')
    desk.click('[data-act="toggle-due-banner"]'); desk.wait_for_timeout(150)
    n_before = len(notifies(desk))
    # Minimize and restore: the page is hidden then visible again (no reload).
    desk.evaluate("""() => {
      const set = (v) => Object.defineProperty(document, 'hidden', { value: v, configurable: true });
      set(true); document.dispatchEvent(new Event('visibilitychange'));
      set(false); document.dispatchEvent(new Event('visibilitychange'));
    }""")
    desk.wait_for_timeout(900)
    check(not desk.locator('#due-list').is_visible() and desk.inner_text('[data-act="toggle-due-banner"]') == 'Show',
          'hidden banner stays hidden after minimizing and restoring')
    check(len(notifies(desk)) == n_before, 'restoring the window does not send another Windows notification')
    # A new day while the app stays open: no new notification, banner still as left.
    desk.clock.set_fixed_time('2026-11-03T16:00:00Z')  # Tue 10:00
    desk.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); desk.wait_for_timeout(900)
    check(len(notifies(desk)) == n_before and not desk.locator('#due-list').is_visible(),
          'next day while still open: no new notification, banner stays hidden')
    desk.clock.set_fixed_time(MON_10)
    desk.click('[data-act="toggle-due-banner"]'); desk.wait_for_timeout(150)
    check(desk.locator('#due-list').is_visible(), 'Show brings it back')
    desk.click('[data-act="toggle-due-banner"]'); desk.wait_for_timeout(150)
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(300)
    check(desk.locator('#due-list').is_visible() and len(notifies(desk)) == 1, 'reopening the app: banner open and one notification again')

    # Phone: same data and order, live completion.
    phone = open_page(browser, 390, 844, MON_10, 'phone')
    check(titles(phone, 'work') == titles(desk, 'work'), 'phone shows same work list in same manual order')
    check(phone.locator('.pin').count() == 0, 'no Keep on top button on phone')
    check(phone.locator('.due-banner').count() == 1, 'phone shows its own daily banner')
    phone.locator('li', has_text='Fix gutter').locator('.check').check()
    desk.wait_for_timeout(900)
    done_titles = desk.eval_on_selector_all('.task.done .t', 'els => els.map(e => e.textContent)')
    check('Fix gutter' in done_titles, f'completion synced to desktop: {done_titles}')

    # Subtasks.
    def subs_of(title): return [(x['title'], x['done']) for x in row(title)['subtasks']]
    desk.locator('li.task', has_text='Send AGS quote').locator('[data-act="expand"]').click()
    box = desk.locator('li.task', has_text='Send AGS quote').locator('[data-sub-new]')
    for t in ['Pull current pricing', 'Add disclaimer language', 'Email Marcus for review']:
        box.fill(t); box.press('Enter'); desk.wait_for_timeout(250)
    check(desk.evaluate("document.activeElement?.hasAttribute('data-sub-new')"), 'cursor stays in Add a subtask for rapid entry')
    desk.locator('li.task', has_text='Send AGS quote').locator('[data-sub-new-due]').fill('2026-11-05')
    desk.wait_for_timeout(900)  # let a sync redraw happen while the date is picked but not yet added
    box.fill('Call vendor'); box.press('Enter'); desk.wait_for_timeout(300)
    cv = [x for x in row('Send AGS quote')['subtasks'] if x['title'] == 'Call vendor']
    check(cv and cv[0]['dueDate'] == '2026-11-05' and row('Send AGS quote')['due_date'] is None,
          'subtask gets a due date when added; main task stays undated')
    check(desk.locator('li.task', has_text='Send AGS quote').locator('[data-sub-new-due]').input_value() == '', 'date box clears for the next subtask')
    desk.locator('li.task', has_text='Send AGS quote').locator('li.sub-edit', has=desk.locator('input[value="Call vendor"]')).locator('[data-act="sub-del"]').click()
    desk.wait_for_timeout(300)
    check(subs_of('Send AGS quote') == [('Pull current pricing', False), ('Add disclaimer language', False), ('Email Marcus for review', False)],
          f'subtasks added in order: {subs_of("Send AGS quote")}')
    desk.locator('li.task', has_text='Send AGS quote').locator('[data-act="collapse"]').click(); desk.wait_for_timeout(150)
    ags = desk.locator('li.task', has_text='Send AGS quote')
    check(ags.locator('ul.subtasks li').count() == 3 and ags.locator('.sub-toggle').inner_text() == '0/3',
          'subtasks listed under the task with 0/3 progress')
    ags.locator('ul.subtasks li', has_text='Pull current pricing').locator('label').click(); desk.wait_for_timeout(300)
    check(('Pull current pricing', True) in subs_of('Send AGS quote') and ags.locator('.sub-toggle').inner_text() == '1/3',
          'checking a subtask from the list saves it and updates progress')
    check(subs_of('Send AGS quote')[-1] == ('Pull current pricing', True)
          and ags.locator('ul.subtasks li').last.inner_text().strip().startswith('Pull current pricing'),
          'checked-off subtask drops to the bottom')
    phone.wait_for_timeout(900)
    p_ags = phone.locator('li.task', has_text='Send AGS quote')
    check(p_ags.locator('.sub-toggle').inner_text() == '1/3' and p_ags.locator('ul.subtasks li.done').count() == 1, 'subtasks sync to phone')
    ags.locator('.sub-toggle').click(); desk.wait_for_timeout(150)
    check(ags.locator('ul.subtasks').count() == 0 and ags.locator('.sub-toggle').get_attribute('aria-expanded') == 'false',
          'progress pill folds the subtasks away')
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(300)
    ags = desk.locator('li.task', has_text='Send AGS quote')
    check(ags.locator('ul.subtasks').count() == 0, 'folded state remembered on this device')
    ags.locator('.sub-toggle').click(); desk.wait_for_timeout(150)
    check(ags.locator('ul.subtasks li').count() == 3, 'pill unfolds them again')
    # Edit: rename and remove in the editor.
    ags.locator('[data-act="expand"]').click()
    ed = desk.locator('li.task', has_text='Send AGS quote')
    ed.locator('li.sub-edit', has=desk.locator('input[value="Email Marcus for review"]')).locator('[data-sub-title]').fill('Email Marcus the draft')
    ed.locator('li.sub-edit').nth(1).locator('[data-sub-title]').press('Tab'); desk.wait_for_timeout(300)
    check('Email Marcus the draft' in [x[0] for x in subs_of('Send AGS quote')], f'rename subtask: {subs_of("Send AGS quote")}')
    ed.locator('li.sub-edit', has=desk.locator('input[value="Add disclaimer language"]')).locator('[data-act="sub-del"]').click(); desk.wait_for_timeout(300)
    check([x[0] for x in subs_of('Send AGS quote')] == ['Email Marcus the draft', 'Pull current pricing'], f'remove subtask: {subs_of("Send AGS quote")}')
    # Drag reorder inside the editor.
    ed = desk.locator('li.task', has_text='Send AGS quote')
    src = ed.locator('li.sub-edit').nth(1).locator('.sub-drag'); dst = ed.locator('li.sub-edit').nth(0)
    sb2, db2 = boxes(desk, src, dst)
    desk.mouse.move(sb2['x'] + 3, sb2['y'] + 5); desk.mouse.down()
    for i in range(10):
        desk.mouse.move(sb2['x'] + 3, sb2['y'] + 5 - (sb2['y'] - db2['y'] + 6) * (i + 1) / 10); desk.wait_for_timeout(30)
    desk.mouse.up(); desk.wait_for_timeout(400)
    check([x[0] for x in subs_of('Send AGS quote')] == ['Email Marcus the draft', 'Pull current pricing'],
          f'a checked-off subtask cannot be dragged above an open one: {subs_of("Send AGS quote")}')
    # Subtask due date and importance.
    ed = desk.locator('li.task', has_text='Send AGS quote')
    first = ed.locator('li.sub-edit').nth(0)
    first.locator('[data-sub-due]').fill('2026-11-03'); desk.wait_for_timeout(350)
    desk.locator('li.task', has_text='Send AGS quote').locator('li.sub-edit').nth(0).locator('[data-act="sub-prio"]').click()
    desk.wait_for_timeout(350)
    st = row('Send AGS quote')['subtasks'][0]
    check((st['title'], st['dueDate'], st['priority']) == ('Email Marcus the draft', '2026-11-03', 'high'),
          f'subtask due date and High saved: {st}')
    check(desk.locator('li.task', has_text='Send AGS quote').locator('li.sub-edit').nth(0).locator('[data-act="sub-prio"]').get_attribute('aria-pressed') == 'true',
          'High toggle shows as on')
    no_overflow(desk, 'subtask editor')
    desk.screenshot(path=os.path.join(HERE, 'subtask-editor.png'), full_page=True)
    desk.locator('li.task', has_text='Send AGS quote').locator('[data-act="collapse"]').click(); desk.wait_for_timeout(150)
    ags_meta = desk.locator('li.task', has_text='Send AGS quote').locator('.title-btn .meta').inner_text()
    check('Next: Email Marcus the draft, due tomorrow' in ags_meta, f'undated task shows its next subtask deadline: {ags_meta!r}')
    sub_line = desk.locator('li.task', has_text='Send AGS quote').locator('ul.subtasks li', has_text='Email Marcus').inner_text()
    check('High' in sub_line and 'Due tomorrow' in sub_line, f'list shows subtask importance and due label: {sub_line!r}')
    banner = desk.inner_text('.due-banner')
    check('Email Marcus the draft' in banner and 'in Send AGS quote' in banner and 'High' in banner,
          f'due-soon banner includes the subtask with its task: {banner!r}')
    check(banner.index('Email Marcus') < banner.index('Order relay'), 'banner sorted by date: subtask due tomorrow before task due Thursday')

    # Subtask order follows due dates; same-date ones are arranged by hand.
    def rt(): return desk.locator('li.task', has_text='Renew truck registration')
    def sub_names(): return [x['title'] for x in row('Renew truck registration')['subtasks']]
    def editor_names(): return rt().locator('li.sub-edit [data-sub-title]').evaluate_all('els => els.map(e => e.value)')
    def set_sub_date(name, date):
        rt().locator('li.sub-edit', has=desk.locator(f'input[value="{name}"]')).locator('[data-sub-due]').fill(date)
        desk.wait_for_timeout(450)
    def drag_sub(src_name, dst_name):
        src = rt().locator('li.sub-edit', has=desk.locator(f'input[value="{src_name}"]')).locator('.sub-drag')
        dst = rt().locator('li.sub-edit', has=desk.locator(f'input[value="{dst_name}"]'))
        for _ in range(10):  # wait out any sync redraw before grabbing the handle
            desk.wait_for_timeout(150)
            a = src.bounding_box(); b = dst.bounding_box()
            if a and b: break
        x, y0, y1 = a['x'] + 3, a['y'] + 5, b['y'] + 3
        desk.mouse.move(x, y0); desk.mouse.down()
        for i in range(30):
            desk.mouse.move(x, y0 + (y1 - y0) * (i + 1) / 30); desk.wait_for_timeout(15)
        desk.mouse.up(); desk.wait_for_timeout(450)
    rt().locator('[data-act="expand"]').click()
    nb = rt().locator('[data-sub-new]')
    for t in ['File form', 'Get emissions test', 'Pay fee']:
        nb.fill(t); nb.press('Enter'); desk.wait_for_timeout(250)
    set_sub_date('Pay fee', '2026-12-05')
    check(sub_names() == ['Pay fee', 'File form', 'Get emissions test'], f'dated subtask moves ahead of undated ones: {sub_names()}')
    set_sub_date('File form', '2026-12-01')
    check(sub_names() == ['File form', 'Pay fee', 'Get emissions test'], f'earlier date goes first: {sub_names()}')
    set_sub_date('Get emissions test', '2026-12-01')
    check(sub_names() == ['File form', 'Get emissions test', 'Pay fee'] and editor_names() == sub_names(),
          f'same date joins after the others on that date: {sub_names()}')
    drag_sub('Get emissions test', 'File form')
    check(sub_names() == ['Get emissions test', 'File form', 'Pay fee'], f'drag arranges subtasks that share a date: {sub_names()}')
    drag_sub('Pay fee', 'Get emissions test')
    check(sub_names() == ['Get emissions test', 'File form', 'Pay fee'] and editor_names() == sub_names(),
          f'a later-dated subtask cannot be dragged ahead of an earlier one: {sub_names()}')
    check('Kept in due-date order' in rt().inner_text(), 'editor explains the ordering')
    rt().locator('li.sub-edit', has=desk.locator('input[value="Get emissions test"]')).locator('.sub-check').click(); desk.wait_for_timeout(450)
    check(sub_names() == ['File form', 'Pay fee', 'Get emissions test'], f'finished one drops to the bottom, next one moves up: {sub_names()}')
    rt().locator('[data-act="collapse"]').click(); desk.wait_for_timeout(200)
    inline = rt().locator('ul.subtasks .sub-title').evaluate_all('els => els.map(e => e.textContent)')
    check(inline == ['File form', 'Pay fee', 'Get emissions test'], f'list under the task shows the next item first: {inline}')
    rt().locator('ul.subtasks li', has_text='Get emissions test').locator('label').click(); desk.wait_for_timeout(450)
    check(sub_names() == ['File form', 'Get emissions test', 'Pay fee'], f'unchecking puts it back with its date: {sub_names()}')
    phone.wait_for_timeout(1200)
    p_inline = phone.locator('li.task', has_text='Renew truck registration').locator('ul.subtasks .sub-title').evaluate_all('els => els.map(e => e.textContent)')
    check(p_inline == sub_names(), f'phone shows the same order: {p_inline}')
    phone.wait_for_timeout(900)
    p_line = phone.locator('li.task', has_text='Send AGS quote').locator('ul.subtasks li', has_text='Email Marcus').inner_text()
    check('High' in p_line and 'Due tomorrow' in p_line, 'subtask date and importance sync to phone')
    desk.click('.tabs [data-view="calendar"]'); desk.click('[data-date="2026-11-03"]'); desk.wait_for_timeout(200)
    check('Send AGS quote' in titles(desk, 'cal-work'), 'calendar (due date only) shows the task on its subtask\'s due date')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    desk.locator('li.task', has_text='Send AGS quote').locator('[data-act="expand"]').click(); desk.wait_for_timeout(150)
    desk.locator('li.task', has_text='Send AGS quote').locator('[data-act="collapse"]').click(); desk.wait_for_timeout(150)
    # Finishing the last subtask offers to finish the task (but doesn't do it on its own).
    desk.locator('li.task', has_text='Send AGS quote').locator('ul.subtasks li', has_text='Email Marcus').locator('label').click()
    desk.wait_for_timeout(300)
    check(row('Send AGS quote')['completed_at'] is None and 'All subtasks done' in desk.inner_text('#toast'),
          'all subtasks done: prompt shown, task not auto-completed')
    desk.click('#toast button'); desk.wait_for_timeout(400)
    check(row('Send AGS quote')['completed_at'] is not None, '"Mark task done" from the prompt completes it')
    desk.locator('li.task.done', has_text='Send AGS quote').locator('.check').click(); desk.wait_for_timeout(400)
    check(row('Send AGS quote')['completed_at'] is None and len(row('Send AGS quote')['subtasks']) == 2, 'unchecking restores task with its subtasks')

    # Settings: widen the window to 20 days -> later task joins the reminder.
    phone.click('.tabs [data-view="settings"]')
    phone.fill('input[name=dueSoonDays]', '20')
    phone.fill('input[name=aliases]', 'Derrick, DJ')
    phone.evaluate("window.__notify()"); phone.wait_for_timeout(900)  # simulated update from the other device
    check(phone.input_value('input[name=dueSoonDays]') == '20', 'unsaved Settings edits survive a sync update')
    phone.click('#settings-form button[type=submit]'); phone.wait_for_timeout(400)
    check(db['user_settings'][0]['settings']['dueSoonDays'] == 20, 'reminder days saved to settings')
    phone.click('.tabs [data-view="today"]'); phone.wait_for_timeout(200)
    check('Renew truck' in phone.inner_text('.due-banner'), 'wider window includes the Nov 20 task')
    check('Due in 18 days' in badge(phone, 'Renew truck'), f'badge follows setting: {badge(phone, "Renew truck")!r}')

    # Editing: clear a due date, set an overdue one.
    phone.locator('li.task', has_text='Order relay').locator('[data-act="expand"]').click()
    phone.fill('li.task.ctx-work input[data-field="dueDate"]', '2026-10-30'); phone.wait_for_timeout(400)
    check('Overdue by 3 days' in badge(phone, 'Order relay'), f'overdue badge: {badge(phone, "Order relay")!r}')

    # Colours.
    def band_rgb(pg): return pg.evaluate("getComputedStyle(document.getElementById('band')).backgroundColor")
    def band_text(pg): return pg.evaluate("getComputedStyle(document.getElementById('band')).color")
    def pick(pg, key, hex_):
        pg.evaluate("([k, v]) => { const i = document.querySelector(`input[data-key=${k}]`); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }", [key, hex_])
        pg.wait_for_timeout(800)  # band fades between colours over 0.6s
    def contrast_js(pg, var, bg):
        return pg.evaluate("""([v, bg]) => {
          const val = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
          const lum = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]
            .map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; })
            .reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i], 0); };
          const [a, b] = [lum(val), lum(bg)].sort((x, y) => y - x); return (a + 0.05) / (b + 0.05); }""", [var, bg])
    default_band = band_rgb(desk)
    desk.click('.tabs [data-view="settings"]')
    pick(desk, 'work', '#ffe066')
    last = desk.evaluate("[...document.querySelectorAll('#settings-form button, #settings-form input')].filter(e => e.type !== 'hidden').pop().textContent")
    check(last == 'Save settings', f'Save settings is the last control in Settings: {last!r}')
    desk.screenshot(path=os.path.join(HERE, 'settings.png'), full_page=True)
    check(band_rgb(desk) == 'rgb(255, 224, 102)' and band_text(desk) == 'rgb(17, 17, 17)',
          f'live preview: pale yellow band with dark text ({band_rgb(desk)}, {band_text(desk)})')
    check(desk.locator('.color-row', has=desk.locator('input[data-key=work]')).locator('[data-act="color-reset"]').is_visible(), 'changed colour offers Reset')
    no_overflow(desk, 'settings')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(800)
    check(band_rgb(desk) == default_band, 'leaving Settings without saving discards the preview')
    desk.click('.tabs [data-view="settings"]')
    pick(desk, 'work', '#ffe066'); pick(desk, 'high', '#00ff00')
    desk.click('#settings-form button[type=submit]'); desk.wait_for_timeout(500)
    saved = db['user_settings'][0]['settings']
    check(saved['colors'] == {'work': '#FFE066', 'high': '#00FF00'}, f'colours saved: {saved.get("colors")}')
    check(contrast_js(desk, '--work-text', '#FFFFFF') >= 4.5 and contrast_js(desk, '--flag', '#FFFFFF') >= 4.5,
          'text versions of pale/bright picks stay readable (>= 4.5:1)')
    phone.wait_for_timeout(1500)
    check(band_rgb(phone) == 'rgb(255, 224, 102)', 'colours sync to the phone')
    desk.locator('.theme-seg [data-val="dark"]').click()
    desk.click('#settings-form button[type=submit]'); desk.wait_for_timeout(500)
    check(desk.evaluate("document.documentElement.dataset.theme") == 'dark'
          and desk.evaluate("getComputedStyle(document.body).backgroundColor") == 'rgb(19, 24, 30)',
          'Dark theme forced on a light-mode device')
    check(contrast_js(desk, '--flag', '#1C232B') >= 4.5, 'custom High colour re-tuned for dark backgrounds')
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(900)
    check(band_rgb(desk) == 'rgb(255, 224, 102)' and desk.evaluate("document.documentElement.dataset.theme") == 'dark',
          'colours and theme kept after reopening')
    desk.screenshot(path=os.path.join(HERE, 'custom-colors-dark.png'), full_page=True)
    desk.click('.tabs [data-view="settings"]')
    desk.click('[data-act="color-reset-all"]'); desk.locator('.theme-seg [data-val="auto"]').click()
    desk.click('#settings-form button[type=submit]'); desk.wait_for_timeout(900)
    check(db['user_settings'][0]['settings']['colors'] == {} and band_rgb(desk) == default_band
          and desk.evaluate("document.documentElement.dataset.theme") is None, 'Reset all + Match device restores defaults')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(150)

    # Option: due-soon list open or hidden when the app opens.
    banner_open = lambda pg: pg.locator('#due-list').is_visible()
    was_open = banner_open(desk)
    desk.click('.tabs [data-view="settings"]')
    desk.check('input[name="dueBannerStart"][value="hidden"]')
    desk.click('#settings-form button[type=submit]'); desk.wait_for_timeout(500)
    check(db['user_settings'][0]['settings']['dueBannerStart'] == 'hidden', 'banner start option saved')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    check(banner_open(desk) == was_open, 'changing the option does not change the banner right now')
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(400)
    check(desk.locator('.due-banner').count() == 1 and not banner_open(desk)
          and desk.inner_text('[data-act="toggle-due-banner"]') == 'Show', 'opening the app with "Hidden": banner starts collapsed')
    check(len(notifies(desk)) == 1, 'the Windows notification still appears on open')
    desk.click('[data-act="toggle-due-banner"]'); desk.wait_for_timeout(150)
    check(banner_open(desk), 'Show opens it')
    phone.reload(); phone.wait_for_selector('#band .day'); phone.wait_for_timeout(400)
    check(not banner_open(phone), 'the option applies on the phone too')
    desk.click('.tabs [data-view="settings"]')
    check(desk.is_checked('input[name="dueBannerStart"][value="hidden"]'), 'Settings shows the saved choice')
    desk.check('input[name="dueBannerStart"][value="open"]')
    desk.click('#settings-form button[type=submit]'); desk.wait_for_timeout(500)
    desk.reload(); desk.wait_for_selector('#band .day'); desk.wait_for_timeout(400)
    check(banner_open(desk), 'back to "Shown": banner open on the next open')
    phone.reload(); phone.wait_for_selector('#band .day'); phone.wait_for_timeout(400)

    # Granola manual import.
    notes = """# Onan AGS sync
## Summary
- Reviewed the quote
### Action Items
- Derrick: Send revised wiring diagram to Marcus by Wednesday
  - include the AGS harness changes
- Marcus: Review firmware build
- Derrick to renew domain #home
"""
    desk.click('.tabs [data-view="import"]')
    desk.fill('textarea[data-draft="text"]', notes)
    desk.click('[data-act="import"]'); desk.wait_for_timeout(600)
    result = desk.inner_text('#view')
    check('Added 2 from “Onan AGS sync”' in result, 'import adds my 2 items')
    check('Review firmware build' in result and 'Add anyway' in result, "other person's item offered as Add anyway")
    desk.click('[data-act="import"]'); desk.wait_for_timeout(600)
    check('Nothing new for you' in desk.inner_text('#view'), 're-import does not duplicate')
    check(row('Send revised wiring diagram to Marcus')['due_date'] == '2026-11-04', 'deadline from notes kept')
    check(row('Renew domain')['due_date'] is None and row('Renew domain')['context'] == 'home', 'no deadline in notes => none; #home tag')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    check(titles(desk, 'none') == ['Send revised wiring diagram to Marcus'], 'untagged import lands in Needs sorting')
    desk.locator('li', has_text='Send revised wiring').locator('[data-act="classify"][data-val="work"]').click()
    desk.wait_for_timeout(400)
    check(row('Send revised wiring diagram to Marcus')['context'] == 'work', 'classified as work')

    # Calendar: picking a day sets Starts (the day it joins the Tasks list).
    desk.click('.tabs [data-view="calendar"]')
    check(not desk.locator('#add .start-pick').is_visible() or desk.input_value('#add input[name=start]') == '',
          'today selected: Starts is blank (goes on the list now)')
    desk.click('[data-date="2026-11-05"]'); desk.wait_for_timeout(150)
    check(desk.locator('#add .start-pick').is_visible() and desk.input_value('#add input[name=start]') == '2026-11-05'
          and desk.input_value('#add input[name=due]') == '', 'picking Thursday fills Starts, Due stays blank')
    add(desk, 'Order furnace filters', 'home')
    desk.screenshot(path=os.path.join(HERE, 'start-date.png'))
    add(desk, 'Draft Q1 plan', 'work', due='2026-11-12')
    of, dq = row('Order furnace filters'), row('Draft Q1 plan')
    check((of['start_date'], of['due_date']) == ('2026-11-05', None) and (dq['start_date'], dq['due_date']) == ('2026-11-05', '2026-11-12'),
          f'start date saved, with or without a due date: {(of["start_date"], of["due_date"], dq["start_date"], dq["due_date"])}')
    check(desk.input_value('#add input[name=start]') == '2026-11-05', 'Starts stays on the selected day for the next task')
    check(titles(desk, 'cal-home') == ['Order furnace filters'] and 'Draft Q1 plan' in titles(desk, 'cal-work'), 'they show on their start day')
    desk.click('[data-date="2026-11-02"]'); desk.wait_for_timeout(150)
    check('Order furnace filters' not in titles(desk, 'cal-home'), 'not on today before they start')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    check('Order furnace filters' not in titles(desk, 'home') and 'Draft Q1 plan' not in titles(desk, 'work'), 'not on the Tasks list yet')
    check('2 tasks start later' in desk.inner_text('.starts-later') and not desk.locator('#add .start-pick').is_visible(),
          'Tasks page notes them; Starts field only on the Calendar tab')
    desk.click('[data-act="go-calendar"]'); desk.wait_for_timeout(200)
    check(desk.locator('[data-date="2026-11-05"][aria-pressed="true"]').count() == 1, '"See Calendar" jumps to their start day')
    # Clearing the start date in the editor puts it on the list now.
    desk.locator('li.task', has_text='Order furnace filters').locator('[data-act="expand"]').click()
    desk.locator('li.task', has_text='Order furnace filters').locator('input[data-field="startDate"]').fill('')
    desk.wait_for_timeout(400)
    check(row('Order furnace filters')['start_date'] is None and 'Order furnace filters' not in titles(desk, 'cal-home'),
          'clearing Starts saves no start date (it leaves Thursday and goes on today)')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    check('Order furnace filters' in titles(desk, 'home'), 'and it is on the Tasks list now')
    desk.locator('li.task', has_text='Order furnace filters').locator('.check').click(); desk.wait_for_timeout(300)

    # Calendar: a due date with Starts cleared goes on the list now.
    desk.click('.tabs [data-view="calendar"]')
    desk.click('[data-date="2026-11-10"]')
    desk.fill('#add input[name=start]', '')
    add(desk, 'Quarterly backup check', 'work', due='2026-11-10')
    check(row('Quarterly backup check')['due_date'] == '2026-11-10' and row('Quarterly backup check')['start_date'] is None, 'due date set from the Calendar tab')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    check('Quarterly backup check' in titles(desk, 'work'), 'no start date: appears in Tasks immediately')
    tasks_work = titles(desk, 'work')

    # Calendar display mode.
    desk.click('.tabs [data-view="calendar"]')
    desk.click('[data-date="2026-11-04"]'); desk.wait_for_timeout(150)
    check(titles(desk, 'cal-work') == ['Send revised wiring diagram to Marcus'], f'due-only: only tasks due Nov 4: {titles(desk, "cal-work")}')
    desk.click('[data-act="cal-mode"][data-val="until-due"]'); desk.wait_for_timeout(300)
    check(db['user_settings'][0]['settings']['calendarMode'] == 'until-due', 'calendar mode saved')
    cal_work = titles(desk, 'cal-work')
    expected = [t for t in tasks_work if t in ('Send revised wiring diagram to Marcus', 'Quarterly backup check')]
    check(cal_work == expected, f'every day until due: same order as Tasks page: {cal_work} vs {expected}')
    check('Renew truck registration' in titles(desk, 'cal-home'), 'home task due Nov 20 shows on Nov 4')
    check(desk.locator('.cal-day-head + .section h2').first.inner_text().startswith('Work'), 'work list first during work hours, like Tasks')
    desk.click('[data-date="2026-11-21"]'); desk.wait_for_timeout(150)
    check(titles(desk, 'cal-home') == ['Renew truck registration'] and titles(desk, 'cal-work') == [],
          f'a task runs on past its own date while it has later subtasks: {titles(desk, "cal-home")}')
    desk.click('[data-act="cal-next"]'); desk.click('[data-date="2026-12-06"]'); desk.wait_for_timeout(150)
    check(titles(desk, 'cal-home') == [] and titles(desk, 'cal-work') == [], 'nothing shows after its last due date')
    desk.click('[data-act="cal-prev"]'); desk.wait_for_timeout(150)
    desk.click('[data-date="2026-11-02"]'); desk.wait_for_timeout(150)
    check('Order relay' in titles(desk, 'cal-work'), 'overdue task still shows on today')
    check('Review Lyra crash fix' in titles(desk, 'cal-work'), 'task with no due date shows on today')
    desk.click('[data-date="2026-11-03"]'); desk.wait_for_timeout(150)
    check('Review Lyra crash fix' not in titles(desk, 'cal-work'), 'but not on future days')
    desk.click('[data-date="2026-11-02"]'); desk.wait_for_timeout(150)
    no_overflow(desk, 'calendar')
    desk.screenshot(path=os.path.join(HERE, 'calendar-until-due.png'), full_page=True)
    desk.click('[data-act="cal-mode"][data-val="due-only"]'); desk.wait_for_timeout(300)
    check('Review Lyra crash fix' in titles(desk, 'cal-work') and 'Order relay' not in titles(desk, 'cal-work'),
          f'due-date-only mode: undated task still on today: {titles(desk, "cal-work")}')
    desk.click('.tabs [data-view="today"]'); desk.wait_for_timeout(200)
    no_overflow(desk, 'task list')
    desk.screenshot(path=os.path.join(HERE, 'desktop-work.png'), full_page=True)

    # Carried over: unfinished by the end of its day -> pinned to the top until done or re-dated.
    add(desk, 'Submit timesheet', 'work', due='2026-11-02')
    add(desk, 'Water plants', 'home', due='2026-11-02')
    def chip(pg, title): return pg.locator('li.task', has_text=title).first.locator('.title-btn .meta .carried').count() == 1
    check(not chip(desk, 'Submit timesheet') and chip(desk, 'Order relay'),
          'during the work day a task due today is not carried; an overdue one is')
    check(titles(desk, 'work')[0] == 'Order relay', f'overdue task pinned to the top of Work: {titles(desk, "work")}')

    # After hours: home first, work below, nothing's due date changed.
    before = {r['id']: r['due_date'] for r in db['tasks']}
    eve = open_page(browser, 390, 844, '2026-11-02T23:30:00Z', 'evening', scheme='dark')  # 17:30 CST
    check('home' in eve.get_attribute('#band', 'class'), 'after hours => green home band')
    order = eve.eval_on_selector_all('#view .section h2', 'e => e.map(x => x.firstChild.textContent.trim())')
    check(order[:2] == ['Home', 'Work, for the next work day'], f'home first, work below after hours: {order}')
    mine = [t for t in titles(eve, 'work') if t in ('Review Lyra crash fix', 'Flash test units', 'Send AGS quote')]
    check(mine == ['Review Lyra crash fix', 'Flash test units', 'Send AGS quote'], f'manual work order intact after hours: {titles(eve, "work")}')
    check({r['id']: r['due_date'] for r in db['tasks']} == before, 'after-hours never rewrites due dates')
    check(titles(eve, 'work')[:2] == ['Order relay', 'Submit timesheet'] and chip(eve, 'Submit timesheet'),
          f'work day over: unfinished work task joins the top, most overdue first: {titles(eve, "work")}')
    check(not chip(eve, 'Water plants'), 'home task due today is not carried until the day is over')
    eve.click('.tabs [data-view="calendar"]'); eve.click('[data-date="2026-11-03"]'); eve.wait_for_timeout(200)
    tue_list = titles(eve, 'cal-work') + titles(eve, 'cal-home') + titles(eve, 'cal-none')
    check('Review Lyra crash fix' in tue_list and 'Send AGS quote' in tue_list, f'after work: undated tasks previewed on the next work day: {tue_list}')
    check('Submit timesheet' in tue_list and 'Order relay' in tue_list, 'carried-over tasks previewed there too')
    check('Quarterly backup check' not in tue_list and 'Water plants' not in tue_list, 'tasks not yet late stay on their own dates')
    check('carried over, since they move to this day' in eve.inner_text('.cal-day-head'), 'the day explains why they are there')
    eve.click('.tabs [data-view="today"]'); eve.wait_for_timeout(200)

    # Next morning.
    tue = open_page(browser, 400, 1500, '2026-11-03T16:00:00Z', 'tuesday')  # Tue 10:00 CST
    check(titles(tue, 'work')[:2] == ['Order relay', 'Submit timesheet'], f'still on top the next day: {titles(tue, "work")}')
    check(titles(tue, 'home')[0] == 'Water plants' and chip(tue, 'Water plants'), f'home task carried the next day: {titles(tue, "home")}')
    check('Overdue by 1 day' in badge(tue, 'Submit timesheet'), 'carried task shows how overdue it is')
    check('Review Lyra crash fix' in titles(tue, 'work') and not chip(tue, 'Review Lyra crash fix'),
          'task with no due date came along to the next day (not marked carried over)')
    tue.click('.tabs [data-view="calendar"]'); tue.wait_for_timeout(200)
    check('Review Lyra crash fix' in titles(tue, 'cal-work'), "and it's on the next day's calendar")
    tue.click('.tabs [data-view="today"]'); tue.wait_for_timeout(200)
    tue.screenshot(path=os.path.join(HERE, 'carried.png'), full_page=True)
    # A regular task can't be dragged above the carried-over ones.
    normal_first = titles(tue, 'work')[2]
    src = tue.locator('ul[data-list="work"] li', has_text=normal_first).locator('.drag')
    dst = tue.locator('ul[data-list="work"] li').first
    a, b = boxes(tue, src, dst)
    tue.mouse.move(a['x'] + 5, a['y'] + 5); tue.mouse.down()
    for i in range(40):
        tue.mouse.move(a['x'] + 5, a['y'] + 5 - (a['y'] + 5 - (b['y'] + 4)) * (i + 1) / 40); tue.wait_for_timeout(15)
    tue.mouse.up(); tue.wait_for_timeout(500)
    if tue.locator('#nest-dialog[open]').count(): tue.click('#nest-dialog [value="cancel"]'); tue.wait_for_timeout(300)
    check(titles(tue, 'work')[:2] == ['Order relay', 'Submit timesheet'], f'regular task cannot jump above carried-over ones: {titles(tue, "work")}')
    # Dragging a task to the first spot right below the carried-over ones.
    def drag_to(pg, src_title, dst_title, where):
        src = pg.locator('ul[data-list="work"] li', has_text=src_title).locator('.drag')
        dst = pg.locator('ul[data-list="work"] li', has_text=dst_title).locator('.row')
        a, b = boxes(pg, src, dst)
        y1 = b['y'] + 3 if where == 'top' else b['y'] + b['height'] - 3
        pg.mouse.move(a['x'] + 5, a['y'] + 5); pg.mouse.down()
        for i in range(40):
            pg.mouse.move(a['x'] + 5, a['y'] + 5 + (y1 - a['y'] - 5) * (i + 1) / 40); pg.wait_for_timeout(15)
        pg.mouse.up(); pg.wait_for_timeout(600)
        if pg.locator('#nest-dialog[open]').count(): pg.click('#nest-dialog [value="cancel"]'); pg.wait_for_timeout(300)
    wl = titles(tue, 'work')
    first_normal, last_one = wl[2], wl[-1]
    drag_to(tue, last_one, first_normal, 'top')
    check(titles(tue, 'work')[2] == last_one, f'dropped on top of the first regular task: lands right below the carried-over ones: {titles(tue, "work")}')
    tue.reload(); tue.wait_for_selector('#band .day'); tue.wait_for_timeout(500)
    check(titles(tue, 'work')[2] == last_one, f'and stays there after reopening: {titles(tue, "work")}')
    wl = titles(tue, 'work')
    drag_to(tue, wl[-1], wl[1], 'bottom')
    check(titles(tue, 'work')[2] == wl[-1] and titles(tue, 'work')[:2] == wl[:2],
          f'dropped on the bottom edge of the last carried-over task: also lands in that first spot: {titles(tue, "work")}')
    tue.reload(); tue.wait_for_selector('#band .day'); tue.wait_for_timeout(500)
    check(titles(tue, 'work')[2] == wl[-1], 'and stays there too')

    # Changing the due date ends it.
    tue.locator('li.task', has_text='Submit timesheet').locator('[data-act="expand"]').click()
    tue.locator('li.task', has_text='Submit timesheet').locator('input[data-field="dueDate"]').fill('2026-11-06'); tue.wait_for_timeout(500)
    check(not chip(tue, 'Submit timesheet') and titles(tue, 'work').index('Submit timesheet') > 0
          and row('Submit timesheet')['due_date'] == '2026-11-06', f're-dated: back in its normal place: {titles(tue, "work")}')
    # Checking it off ends it.
    tue.locator('li.task', has_text='Water plants').first.locator('.check').click(); tue.wait_for_timeout(500)
    check('Water plants' not in titles(tue, 'home') and row('Water plants')['completed_at'], 'checked off: no longer carried')
    tue.close()
    thu = open_page(browser, 400, 900, '2026-11-05T16:00:00Z', 'thursday')  # Thu 10:00
    check('Draft Q1 plan' in titles(thu, 'work') and thu.locator('.starts-later').count() == 0,
          f'on its start day it joins the Tasks list: {titles(thu, "work")}')
    thu.close()
    eve.screenshot(path=os.path.join(HERE, 'phone-evening-dark.png'), full_page=True)

    # Extend the work day (Wednesday, defaults: button 15 min before 5:00 PM, up 15 min, adds 30).
    def band_text(pg): return ' '.join(pg.inner_text('#band .mode').split())
    def tick(pg, iso):
        pg.clock.set_fixed_time(iso)
        pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); pg.wait_for_timeout(900)
    def ext(): return (db['user_settings'][0]['settings'] or {}).get('workExtension')
    w = open_page(browser, 400, 900, '2026-11-04T22:40:00Z', 'wed')  # 16:40
    check(w.locator('[data-act="extend-day"]').count() == 0, 'no Extend button before the lead time')
    tick(w, '2026-11-04T22:50:00Z')  # 16:50
    check(w.locator('[data-act="extend-day"]').count() == 1 and 'Work hours until 5:00 PM' in band_text(w),
          f'Extend button appears next to work hours near the end of the day: {band_text(w)!r}')
    check(w.locator('[data-ext-amount] option:checked').inner_text() == '+30 min (default)', 'picker starts on the default amount')
    no_overflow(w, 'header with Extend button')
    w.screenshot(path=os.path.join(HERE, 'extend.png'))
    w.click('[data-act="extend-day"]'); w.wait_for_timeout(500)
    check(ext() == {'date': '2026-11-04', 'endTime': '17:30', 'ended': False}, f'extended by the default 30 min: {ext()}')
    check(band_text(w) == 'Work hours until 5:30 PM (extended)' and w.locator('[data-act="extend-day"]').count() == 0,
          f'header shows the new end; button waits until near it: {band_text(w)!r}')
    tick(w, '2026-11-04T23:05:00Z')  # 17:05
    check('work' in w.get_attribute('#band', 'class'), 'past the normal end: Work stays on top')
    tick(w, '2026-11-04T23:20:00Z')  # 17:20
    check(w.locator('[data-act="extend-day"]').count() == 1, 'button returns near the extended end')
    w.select_option('[data-ext-amount]', 'custom'); w.wait_for_timeout(150)
    w.fill('[data-ext-custom]', '20')
    w.click('[data-act="extend-day"]'); w.wait_for_timeout(500)
    check(ext()['endTime'] == '17:50' and band_text(w) == 'Work hours until 5:50 PM (extended)', f'custom amount: {ext()}')
    w.close()

    # Reopened while extended: asked whether to keep going.
    w = open_page(browser, 400, 900, '2026-11-04T23:25:00Z', 'wed-reopen')  # 17:25
    check(w.locator('#ext-dialog[open]').count() == 1 and 'extended today\'s work hours to 5:50 PM' in w.inner_text('#ext-dialog')
          and 'Keep working until 5:50 PM' in w.inner_text('#ext-dialog'), 'reopening asks: keep the extended day or switch to Home')
    w.screenshot(path=os.path.join(HERE, 'extend-dialog.png'))
    w.click('#ext-dialog [value="keep"]'); w.wait_for_timeout(400)
    check('work' in w.get_attribute('#band', 'class') and ext()['endTime'] == '17:50' and not ext()['ended'], 'Keep working: nothing changes')
    w.close()
    w = open_page(browser, 400, 900, '2026-11-04T23:26:00Z', 'wed-reopen-2')
    w.click('#ext-dialog [value="home"]'); w.wait_for_timeout(500)
    check('home' in w.get_attribute('#band', 'class') and ext() == {'date': '2026-11-04', 'endTime': '17:26', 'ended': True}
          and w.locator('[data-act="extend-day"]').count() == 0, f'Switch to Home: Home on top now, no button: {ext()}')
    w.close()
    w = open_page(browser, 400, 900, '2026-11-04T23:28:00Z', 'wed-reopen-3')
    check(w.locator('#ext-dialog[open]').count() == 0, 'no question once the day has been switched to Home')
    w.close()

    # No extension: switches by itself when the button's time is up.
    th = open_page(browser, 400, 900, '2026-11-05T22:59:00Z', 'thu-eod')  # Thu 16:59
    check(th.locator('[data-act="extend-day"]').count() == 1 and 'work' in th.get_attribute('#band', 'class'), 'Thursday 4:59: button up')
    tick(th, '2026-11-05T23:00:00Z')
    check('home' in th.get_attribute('#band', 'class') and th.locator('[data-act="extend-day"]').count() == 0,
          'not pressed: lists switch to Home and the button disappears')
    # Settings: keep the button up longer than its lead time.
    th.click('.tabs [data-view="settings"]')
    th.fill('input[name=extendVisibleMinutes]', '25'); th.fill('input[name=extendDefaultMinutes]', '45')
    th.click('#settings-form button[type=submit]'); th.wait_for_timeout(500)
    check(th.locator('#workback-dialog[open]').count() == 1, 'a longer button window at 5:00 also counts as pushing the end out: asks')
    th.click('#workback-dialog [value="work"]'); th.wait_for_timeout(300)
    saved = db['user_settings'][0]['settings']
    check((saved['extendPromptMinutes'], saved['extendVisibleMinutes'], saved['extendDefaultMinutes']) == (15, 25, 45), 'end-of-day settings saved')
    check('appears at 4:45 PM and Home goes on top at 5:10 PM' in th.inner_text('#settings-form'), 'Settings explains the timing')
    th.click('.tabs [data-view="today"]'); tick(th, '2026-11-05T23:05:00Z')  # 17:05
    check('work' in th.get_attribute('#band', 'class') and 'Work hours ended 5:00 PM. Home at 5:10 PM' in band_text(th)
          and th.locator('[data-ext-amount] option:checked').inner_text() == '+45 min (default)', f'longer window: {band_text(th)!r}')
    tick(th, '2026-11-05T23:10:00Z')
    check('home' in th.get_attribute('#band', 'class'), 'switches when the longer window ends')
    th.close()

    # Pushing the end out after the switch to Home (Thursday; button window is 25 min, so Home since 5:10).
    def mode(pg): return 'work' if 'work' in pg.get_attribute('#band', 'class') else 'home'
    def set_end(pg, hhmm):
        pg.click('.tabs [data-view="settings"]'); pg.fill('input[name=workEnd]', hhmm)
        pg.click('#settings-form button[type=submit]'); pg.wait_for_timeout(500)
    def wb_open(pg): return pg.locator('#workback-dialog[open]').count() == 1
    a = open_page(browser, 400, 900, '2026-11-05T23:15:00Z', 'thu-a')  # 17:15
    check(mode(a) == 'home', 'Thursday 5:15 PM: switched to Home')
    set_end(a, '18:00')
    wb = ' '.join(a.inner_text('#workback-dialog').split())
    check(wb_open(a) and "Work now ends at 6:00 PM. It's 5:15 PM, so that puts you back in work hours." in wb
          and a.locator('#workback-cancel').is_visible() and a.locator('#workback-dialog .dialog-x').is_visible(),
          f'end pushed out in Settings: asks, with a way to cancel: {wb!r}')
    a.screenshot(path=os.path.join(HERE, 'workback.png'))
    a.click('#workback-dialog [value="work"]'); a.wait_for_timeout(400)
    a.click('.tabs [data-view="today"]'); a.wait_for_timeout(200)
    check(mode(a) == 'work' and 'Work hours until 6:00 PM' in ' '.join(a.inner_text('#band .mode').split()), 'Move Work to the top: back in work hours')
    set_end(a, '17:00')
    check(not wb_open(a) and mode(a) == 'home', 'pulling the end back in switches to Home without asking')
    a.click('.tabs [data-view="today"]')

    # Pushed out on the other device.
    b = open_page(browser, 390, 844, '2026-11-05T23:15:00Z', 'thu-b')
    set_end(b, '18:30')
    b.click('#workback-dialog [value="work"]'); b.wait_for_timeout(300)
    a.wait_for_timeout(1500)
    check(wb_open(a) and 'changed on your other device' in a.inner_text('#workback-dialog') and '6:30 PM' in a.inner_text('#workback-dialog')
          and not a.locator('#workback-cancel').is_visible(), 'the other device asks too (nothing to undo there, so no Cancel link)')
    a.click('#workback-dialog [value="home"]'); a.wait_for_timeout(500)
    st = db['user_settings'][0]['settings']
    check(mode(a) == 'home' and st['workExtension'] == {'date': '2026-11-05', 'endTime': '17:15', 'ended': True}, f'Stay on Home: {st["workExtension"]}')
    b.wait_for_timeout(1500)
    check(mode(b) == 'home' and not wb_open(b), 'that choice syncs back (no question for going to Home)')
    # A later end time isn't blocked by the earlier "stay on Home".
    b.click('.tabs [data-view="settings"]'); b.fill('input[name=workEnd]', '19:00')
    b.click('#settings-form button[type=submit]'); b.wait_for_timeout(500)
    check(wb_open(b) and db['user_settings'][0]['settings']['workExtension'] is None, 'later end replaces the earlier switch and asks again')
    b.keyboard.press('Enter'); b.wait_for_timeout(300)
    b.click('.tabs [data-view="today"]'); b.wait_for_timeout(200)
    check(mode(b) == 'work', 'Enter moves Work back to the top')
    a.close(); b.close()

    # Settings: reset lists for today's hours.
    def now_line(pg): return ' '.join(pg.inner_text('#day-order-now').split())
    r = open_page(browser, 400, 900, '2026-11-05T23:20:00Z', 'thu-reset')  # Thu 17:20; work end 19:00 from above
    r.click('.tabs [data-view="settings"]'); r.fill('input[name=workEnd]', '17:00')
    r.click('#settings-form button[type=submit]'); r.wait_for_timeout(400)
    r.fill('input[name=workEnd]', '18:00'); r.click('#settings-form button[type=submit]'); r.wait_for_timeout(400)
    r.click('#workback-dialog [value="home"]'); r.wait_for_timeout(500)   # chose to stay on Home
    r.click('.tabs [data-view="today"]'); r.click('.tabs [data-view="settings"]'); r.wait_for_timeout(200)
    check(mode(r) == 'home' and now_line(r) == 'Right now: Home is on top. You switched to Home at 5:20 PM.',
          f'Settings says what is on top and why: {now_line(r)!r}')
    r.click('[data-act="reset-day-order"]'); r.wait_for_timeout(500)
    st = db['user_settings'][0]['settings']
    check(st['workExtension'] is None and mode(r) == 'work' and r.locator('#workback-dialog[open]').count() == 0,
          'Reset: today\'s Switch to Home is cleared and Work is back on top (no extra question)')
    check('Lists reset. Work is on top until 6:00 PM.' in r.inner_text('#toast') and now_line(r) == 'Right now: Work is on top until 6:00 PM.',
          f'result shown: {r.inner_text("#toast")!r}')
    # Unsaved edits are saved by the reset.
    r.fill('input[name=workEnd]', '17:00')
    r.click('[data-act="reset-day-order"]'); r.wait_for_timeout(500)
    check(db['user_settings'][0]['settings']['workEnd'] == '17:00' and mode(r) == 'home'
          and 'Home is on top. Work ended at 5:10 PM.' in r.inner_text('#toast'), 'reset saves changed hours first, then applies them')
    # An extension is cleared too.
    r.close()
    r = open_page(browser, 400, 900, '2026-11-05T22:50:00Z', 'thu-reset-2')  # 16:50
    r.click('[data-act="extend-day"]'); r.wait_for_timeout(400)
    check(mode(r) == 'work' and db['user_settings'][0]['settings']['workExtension']['endTime'] == '17:45', 'extended to 5:45 PM')
    r.click('.tabs [data-view="settings"]')
    check(now_line(r) == 'Right now: Work is on top until 5:45 PM (extended today).', f'{now_line(r)!r}')
    r.click('[data-act="reset-day-order"]'); r.wait_for_timeout(500)
    check(db['user_settings'][0]['settings']['workExtension'] is None and now_line(r) == 'Right now: Work is on top until 5:00 PM.',
          'reset removes today\'s extension')
    no_overflow(r, 'settings with reset button')
    r.close()

    # Closing the popup undoes a mistaken time.
    c = open_page(browser, 400, 900, '2026-11-05T23:20:00Z', 'thu-cancel')  # 17:20, work end 17:00 saved
    c.click('.tabs [data-view="settings"]')
    def save_end(hhmm):
        c.fill('input[name=workEnd]', hhmm); c.click('#settings-form button[type=submit]'); c.wait_for_timeout(500)
    def saved_end(): return db['user_settings'][0]['settings']['workEnd']
    save_end('18:45')
    check(wb_open(c) and saved_end() == '18:45', 'typed 6:45 PM by mistake and saved: popup appears')
    c.screenshot(path=os.path.join(HERE, 'workback-clean.png'))
    c.click('#workback-dialog .dialog-x'); c.wait_for_timeout(600)
    check(not wb_open(c) and saved_end() == '17:00' and mode(c) == 'home', '× undoes the save (back to 5:00 PM, still on Home)')
    check(c.input_value('input[name=workEnd]') == '18:45' and 'Not saved' in c.inner_text('#toast'),
          'Settings still shows what was typed so it can be fixed')
    save_end('18:15')
    c.click('#workback-cancel'); c.wait_for_timeout(600)
    check(saved_end() == '17:00' and mode(c) == 'home', '"Cancel, I entered the wrong time" undoes it too')
    save_end('18:15')
    c.keyboard.press('Escape'); c.wait_for_timeout(600)
    check(saved_end() == '17:00' and mode(c) == 'home', 'Escape undoes it too')
    save_end('18:15')
    c.click('#workback-dialog [value="work"]'); c.wait_for_timeout(500)
    check(saved_end() == '18:15' and mode(c) == 'work' and 'Work is on top until 6:15 PM' in c.inner_text('#toast'),
          'fixed time, then Move Work to the top: saved')
    no_overflow(c, 'popup')
    c.close()

    # Daily tasks.
    def daily_titles(pg, ctx): return pg.eval_on_selector_all(f'ul[data-list="daily-{ctx}"] .t', 'els => els.map(e => e.textContent)')
    def daily_head(pg, ctx):
        h = pg.locator(f'ul[data-list="daily-{ctx}"]').locator('xpath=..').locator('.daily-head')
        return ' '.join(h.inner_text().split()) if h.count() else ''
    d = open_page(browser, 400, 900, '2026-11-03T16:00:00Z', 'daily')  # Tue 10:00
    check(d.locator('.daily-block').count() == 0, 'no Daily section until a daily task exists')
    d.click('#add [data-ctx="work"]'); d.click('#add [data-daily]')
    check(not d.locator('#add .due-pick').is_visible(), 'Daily on: due date hidden in the add form')
    d.fill('#add input[name=title]', 'Check CI dashboard'); d.press('#add input[name=title]', 'Enter'); d.wait_for_timeout(300)
    ci = row('Check CI dashboard')
    check(ci['repeat'] == {'days': 'work', 'doneOn': None, 'subsOn': None} and ci['due_date'] is None, f'saved as daily on work days: {ci["repeat"]}')
    check(d.locator('#add [data-daily]').get_attribute('aria-pressed') == 'false', 'toggle resets after adding')
    d.click('#add [data-daily]'); d.fill('#add input[name=title]', 'Review PRs'); d.press('#add input[name=title]', 'Enter'); d.wait_for_timeout(300)
    d.click('#add [data-ctx="home"]'); d.click('#add [data-daily]')
    d.fill('#add input[name=title]', 'Take vitamins'); d.press('#add input[name=title]', 'Enter'); d.wait_for_timeout(300)
    check(row('Take vitamins')['repeat']['days'] == 'all', 'home daily defaults to every day')
    check(daily_titles(d, 'work') == ['Check CI dashboard', 'Review PRs'] and daily_titles(d, 'home') == ['Take vitamins'],
          'Daily section at the top of Work and of Home')
    first_in_work = d.evaluate("""() => { const s = document.querySelector('ul[data-list="daily-work"]').closest('section');
      return s.querySelector('.daily-block').compareDocumentPosition(s.querySelector('ul[data-list="work"]')) & Node.DOCUMENT_POSITION_FOLLOWING; }""")
    check(bool(first_in_work), 'Daily block sits above the normal Work tasks')
    check('Check CI dashboard' not in titles(d, 'work'), 'daily tasks are not mixed into the normal list')
    check(daily_head(d, 'work') == 'Daily 0 of 2 done today', f'progress: {daily_head(d, "work")!r}')
    # Check off.
    d.locator('li.task', has_text='Check CI dashboard').locator('.check').click(); d.wait_for_timeout(400)
    check(row('Check CI dashboard')['repeat']['doneOn'] == '2026-11-03' and row('Check CI dashboard')['completed_at'] is None,
          'checked off for today (not completed for good)')
    ci_li = d.locator('li.task', has_text='Check CI dashboard')
    check(ci_li.count() == 1 and 'daily-done' in ci_li.get_attribute('class') and ci_li.locator('.check').is_checked()
          and daily_head(d, 'work') == 'Daily 1 of 2 done today', 'stays in Daily, crossed off, progress updates')
    done_list = d.eval_on_selector_all('.task.done .t', 'e => e.map(x => x.textContent)')
    check('Check CI dashboard' not in done_list, 'not moved to Done today')
    # Reorder within Daily.
    src = d.locator('ul[data-list="daily-work"] li', has_text='Review PRs').locator('.drag')
    dst = d.locator('ul[data-list="daily-work"] li').first
    a_, b_ = boxes(d, src, dst)
    d.mouse.move(a_['x'] + 5, a_['y'] + 5); d.mouse.down()
    for i in range(40):
        d.mouse.move(a_['x'] + 5, a_['y'] + 5 - (a_['y'] + 5 - (b_['y'] + 4)) * (i + 1) / 40); d.wait_for_timeout(15)
    d.mouse.up(); d.wait_for_timeout(500)
    check(daily_titles(d, 'work') == ['Review PRs', 'Check CI dashboard'], f'drag to reorder within Daily: {daily_titles(d, "work")}')
    check(drag_onto(d, 'Review PRs', 'Send revised wiring diagram to Marcus') is False and d.locator('#nest-dialog[open]').count() == 0,
          'a daily task cannot be dropped into another task')
    # Subtasks on a daily task.
    d.locator('li.task', has_text='Review PRs').locator('[data-act="expand"]').click()
    sb = d.locator('li.task', has_text='Review PRs').locator('[data-sub-new]'); sb.fill('Check open PRs'); sb.press('Enter'); d.wait_for_timeout(300)
    d.locator('li.task', has_text='Review PRs').locator('li.sub-edit').first.locator('.sub-check').click(); d.wait_for_timeout(400)
    d.locator('li.task', has_text='Review PRs').locator('[data-act="collapse"]').click(); d.wait_for_timeout(200)
    check(row('Review PRs')['repeat']['subsOn'] == '2026-11-03' and row('Review PRs')['subtasks'][0]['done'], 'subtask ticked today')
    # Editor: make a normal task daily and back.
    d.locator('li.task', has_text='Quarterly backup check').locator('[data-act="expand"]').click()
    d.select_option('li.task.ctx-work select[data-repeat]', 'all'); d.wait_for_timeout(400)
    qb = row('Quarterly backup check')
    check(qb['repeat']['days'] == 'all' and qb['due_date'] is None and 'Quarterly backup check' in daily_titles(d, 'work'),
          'Repeats: Every day moves it into Daily (due date cleared)')
    d.select_option('li.task.ctx-work select[data-repeat]', ''); d.wait_for_timeout(400)
    check(row('Quarterly backup check')['repeat'] is None and 'Quarterly backup check' in titles(d, 'work'), "Doesn't repeat: back to the normal list")
    d.locator('li.task', has_text='Quarterly backup check').locator('[data-act="collapse"]').click()
    # Phone sees them; Calendar leaves them out.
    desk_order = daily_titles(d, 'work')
    ph = open_page(browser, 390, 844, '2026-11-03T16:00:00Z', 'daily-phone')
    check(daily_titles(ph, 'work') == desk_order and daily_head(ph, 'work') == 'Daily 1 of 2 done today', f'phone shows the same Daily list: {daily_titles(ph, "work")} {daily_head(ph, "work")!r}')
    ph.click('.tabs [data-view="calendar"]'); ph.wait_for_timeout(200)
    check(daily_titles(ph, 'cal-work') == desk_order and daily_titles(ph, 'cal-home') == ['Take vitamins']
          and daily_head(ph, 'cal-work') == 'Daily 1 of 2 done today', f'Calendar today: Daily blocks like the Tasks page: {daily_head(ph, "cal-work")!r}')
    check(ph.locator('ul[data-list="daily-cal-work"] .check').first.is_enabled(), 'today: can be checked off from the Calendar')
    check(ph.locator('[data-date="2026-11-04"] .dots .dly').count() == 1 and ph.locator('[data-date="2026-11-02"] .dots .dly').count() == 0,
          'one Daily dot on days they repeat, none before they were added')
    ph.click('[data-date="2026-11-04"]'); ph.wait_for_timeout(200)
    wed_cb = ph.locator('ul[data-list="daily-cal-work"] .check')
    ph.screenshot(path=os.path.join(HERE, 'cal-daily.png'), full_page=True)
    check(daily_titles(ph, 'cal-work') == desk_order and daily_head(ph, 'cal-work') == 'Daily 2 daily'
          and all(not wed_cb.nth(i).is_enabled() and not wed_cb.nth(i).is_checked() for i in range(wed_cb.count())),
          'another day: listed, unchecked, checkboxes disabled')
    rp = ph.locator('ul[data-list="daily-cal-work"] li.task', has_text='Review PRs')
    check(rp.locator('.sub-toggle').inner_text() == '0/1' and not rp.locator('.sub-check').first.is_checked()
          and not rp.locator('.sub-check').first.is_enabled(), "another day: today's subtask ticks don't show there")
    ph.click('[data-date="2026-11-07"]'); ph.wait_for_timeout(200)
    check(daily_titles(ph, 'cal-work') == [] and daily_titles(ph, 'cal-home') == ['Take vitamins'], 'Saturday on the Calendar: only every-day ones')
    ph.click('[data-date="2026-11-02"]'); ph.wait_for_timeout(200)
    check(daily_titles(ph, 'cal-work') == [] and daily_titles(ph, 'cal-home') == [], 'not on days before they were added')
    ph.click('[data-date="2026-11-03"]'); ph.wait_for_timeout(200)
    ph.locator('ul[data-list="daily-cal-home"] li', has_text='Take vitamins').locator('.check').click(); ph.wait_for_timeout(400)
    check(row('Take vitamins')['repeat']['doneOn'] == '2026-11-03', 'checking off today from the Calendar works')
    no_overflow(ph, 'calendar with daily')
    ph.close()
    d.screenshot(path=os.path.join(HERE, 'daily.png'), full_page=True)
    no_overflow(d, 'daily')
    # Colour.
    d.click('.tabs [data-view="settings"]')
    pick(d, 'daily', '#ff00aa')
    d.click('#settings-form button[type=submit]'); d.wait_for_timeout(500)
    check(db['user_settings'][0]['settings']['colors'].get('daily') == '#FF00AA', 'Daily colour saved')
    d.click('.tabs [data-view="today"]'); d.wait_for_timeout(300)
    bar = d.evaluate("getComputedStyle(document.querySelector('li.task.is-daily')).borderLeftColor")
    check(bar == 'rgb(255, 0, 170)' and contrast_js(d, '--daily-text', '#FFFFFF') >= 4.5, f'Daily bar uses it, header text stays readable: {bar}')
    d.close()
    # Next day: unchecked again, subtasks fresh.
    wd = open_page(browser, 400, 900, '2026-11-04T16:00:00Z', 'daily-wed')
    ci_li = wd.locator('li.task', has_text='Check CI dashboard')
    check(not ci_li.locator('.check').is_checked() and 'daily-done' not in ci_li.get_attribute('class')
          and daily_head(wd, 'work') == 'Daily 0 of 2 done today', 'next day: unchecked again')
    check(wd.locator('li.task', has_text='Review PRs').locator('.sub-toggle').inner_text() == '0/1', 'next day: subtasks start fresh')
    wd.close()
    # Saturday: work-days-only daily tasks rest; every-day ones show.
    sa = open_page(browser, 400, 900, '2026-11-07T16:00:00Z', 'daily-sat')
    check(daily_titles(sa, 'work') == [] and daily_titles(sa, 'home') == ['Take vitamins'], 'Saturday: work-days tasks hidden, every-day shown')
    sa.close()

    # Checking things off doesn't make the header jump.
    hb = open_page(browser, 400, 900, '2026-11-03T16:00:00Z', 'header-steady')
    h0 = boxes(hb, hb.locator('#band'))[0]['height']
    heights = []
    hb.locator('li.task:not(.done) .check').first.click()
    for _ in range(12):
        heights.append(boxes(hb, hb.locator('#band'))[0]['height']); hb.wait_for_timeout(100)
    check(max(abs(h - h0) for h in heights) < 1, f'header height stays put while a change syncs: {h0} vs {sorted(set(heights))}')
    check(hb.locator('#band .sync-slot').inner_text() == '', 'a quick sync shows no message at all')
    hb.close()

    # Status beside task and subtask names.
    sp = open_page(browser, 400, 1300, '2026-11-03T16:00:00Z', 'status')  # Tue 10:00
    def li(title): return sp.locator('li.task', has_text=title).first
    check(li('Order relay').locator('.row > .status-pill').count() == 0, 'no status set: nothing shown')
    def beside(pg, left, right):
        a, b = boxes(pg, left, right)
        return b['x'] >= a['x'] + a['width'] - 1 and abs((a['y'] + a['height'] / 2) - (b['y'] + b['height'] / 2)) < 6
    # Status while adding a task.
    full_w = boxes(sp, sp.locator('#add input[name=title]'))[0]['width']
    check(not sp.locator('#add input[name=status]').is_visible(), 'add form: no Status box until the toggle is on')
    sp.click('#add [data-status-toggle]'); sp.wait_for_timeout(100)
    check(sp.evaluate("document.activeElement?.name") == 'status' and beside(sp, sp.locator('#add input[name=title]'), sp.locator('#add input[name=status]'))
          and boxes(sp, sp.locator('#add input[name=title]'))[0]['width'] < full_w - 40,
          'toggle on: Status box appears right of "Add a task" (which shrinks), ready to type')
    sp.click('#add [data-ctx="work"]')
    sp.fill('#add input[name=title]', 'Order spare fuses'); sp.fill('#add input[name=status]', '  Quote requested ')
    sp.press('#add input[name=title]', 'Enter'); sp.wait_for_timeout(400)
    check(row('Order spare fuses') and row('Order spare fuses')['status'] == 'Quote requested'
          and li('Order spare fuses').locator('.row > .status-pill').inner_text() == 'Quote requested', 'status set while adding')
    check(sp.input_value('#add input[name=status]') == '' and not sp.locator('#add input[name=status]').is_visible()
          and sp.get_attribute('#add [data-status-toggle]', 'aria-pressed') == 'false', 'after adding: Status box hides again for the next task')
    sp.click('#add [data-status-toggle]'); sp.fill('#add input[name=status]', 'Never mind'); sp.click('#add [data-status-toggle]')
    sp.fill('#add input[name=title]', 'Toggled off task'); sp.press('#add input[name=title]', 'Enter'); sp.wait_for_timeout(400)
    check(row('Toggled off task')['status'] is None, 'turning the toggle off before adding drops the status')
    sp.fill('#add input[name=title]', 'No status task'); sp.press('#add input[name=title]', 'Enter'); sp.wait_for_timeout(400)
    check(row('No status task')['status'] is None and li('No status task').locator('.row > .status-pill').count() == 0, 'left blank: no status')
    li('Order relay').locator('[data-act="expand"]').click()
    name_w = boxes(sp, li('Order relay').locator('input[data-field="title"]'))[0]['width']
    check(li('Order relay').locator('input[data-field="status"]').count() == 0
          and li('Order relay').locator('[data-act="status-toggle"]').get_attribute('aria-pressed') == 'false',
          'editor: no Status box until the Status toggle is on; Task name keeps its full width')
    li('Order relay').locator('[data-act="status-toggle"]').click(); sp.wait_for_timeout(200)
    box = li('Order relay').locator('input[data-field="status"]')
    check(beside(sp, li('Order relay').locator('input[data-field="title"]'), box) and sp.evaluate("document.activeElement?.dataset?.field") == 'status'
          and boxes(sp, li('Order relay').locator('input[data-field="title"]'))[0]['width'] < name_w - 40,
          'toggle on: Status box right of the Task name (which shrinks), ready to type')
    box.fill('Waiting on vendor quote'); box.press('Tab'); sp.wait_for_timeout(400)
    check(row('Order relay')['status'] == 'Waiting on vendor quote', 'status saved')
    li('Order relay').locator('[data-act="collapse"]').click(); sp.wait_for_timeout(200)
    pill = li('Order relay').locator('.row > .status-pill')
    t_box, p_box = boxes(sp, li('Order relay').locator('.title-btn .t'), pill)
    check(pill.inner_text() == 'Waiting on vendor quote' and p_box['x'] > t_box['x'] + t_box['width'] - 1
          and abs((p_box['y'] + p_box['height'] / 2) - (t_box['y'] + t_box['height'] / 2)) < 6,
          'shown as a pill to the right of the name, level with it')
    # Tap the pill: editor opens on the Status box.
    pill.click(); sp.wait_for_timeout(300)
    check(sp.evaluate("document.activeElement?.dataset?.field") == 'status', 'tapping the pill opens the editor on Status')
    long = 'Waiting on Marcus to confirm the harness pinout rev C'
    sp.keyboard.press('Control+A'); sp.keyboard.type(long); sp.keyboard.press('Tab'); sp.wait_for_timeout(400)
    li('Order relay').locator('[data-act="collapse"]').click(); sp.wait_for_timeout(200)
    trunc = sp.evaluate("""() => { const p = [...document.querySelectorAll('.row > .status-pill')].find(e => e.textContent.startsWith('Waiting on Marcus'));
      return p && p.scrollWidth > p.clientWidth && p.title.includes('rev C'); }""")
    check(row('Order relay')['status'] == long and trunc, 'a long status is shortened to fit, full text on hover')
    no_overflow(sp, 'long status')
    # Subtask status.
    li('Send AGS quote').locator('[data-act="expand"]').click()
    sub_name = li('Send AGS quote').locator('li.sub-edit [data-sub-title]').first.input_value()
    first_sub = li('Send AGS quote').locator('li.sub-edit').first
    check(first_sub.locator('input[data-sub-status]').count() == 0, 'subtask rows: no Status box until toggled')
    first_sub.locator('[data-act="sub-status-toggle"]').click(); sp.wait_for_timeout(200)
    sb = li('Send AGS quote').locator('li.sub-edit').first.locator('input[data-sub-status]')
    check(sb.is_visible() and sp.evaluate("document.activeElement?.hasAttribute('data-sub-status')"), 'subtask Status toggle opens its box, ready to type')
    li('Send AGS quote').screenshot(path=os.path.join(HERE, 'toggle-editor.png'))
    one_line = sp.evaluate("""() => [...document.querySelectorAll('li.sub-edit .sub-opts')].every((o) => {
      const tops = [...o.children].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2));
      return Math.max(...tops) - Math.min(...tops) < 8; })""")
    check(one_line, 'subtask Due, High and Status toggles fit on one line')
    check(beside(sp, li('Send AGS quote').locator('li.sub-edit').first.locator('[data-sub-title]'), sb), 'subtask Status box right of its name, same line')
    check(sp.evaluate("getComputedStyle(document.querySelector('li.sub-edit.done input[data-sub-status]')).textDecorationLine") == 'none',
          'a done subtask crosses out its name, not its Status box')
    li('Send AGS quote').screenshot(path=os.path.join(HERE, 'editor-status.png'))
    sp.locator('#add').screenshot(path=os.path.join(HERE, 'add-status.png'))
    sb.fill('Draft sent'); sb.press('Tab'); sp.wait_for_timeout(400)
    st = [x for x in row('Send AGS quote')['subtasks'] if x['title'] == sub_name][0]
    check(st['status'] == 'Draft sent', f'subtask status saved: {st}')
    li('Send AGS quote').locator('[data-act="collapse"]').click(); sp.wait_for_timeout(200)
    sub_li = li('Send AGS quote').locator('ul.subtasks li', has_text=sub_name)
    s_t, s_p = boxes(sp, sub_li.locator('.sub-title'), sub_li.locator('.status-pill'))
    check(sub_li.locator('.status-pill').inner_text() == 'Draft sent' and s_p['x'] > s_t['x'] + s_t['width'] - 1, 'subtask pill to the right of its name')
    sub_li.locator('.status-pill').click(); sp.wait_for_timeout(300)
    check(sp.evaluate("document.activeElement?.hasAttribute('data-sub-status')") and sp.evaluate("document.activeElement.value") == 'Draft sent',
          'tapping a subtask pill opens its Status box')
    li('Send AGS quote').locator('[data-act="collapse"]').click(); sp.wait_for_timeout(200)
    opts = sp.eval_on_selector_all('#status-suggestions option', 'e => e.map(o => o.value)')
    check(opts[:5] == ['In progress', 'Waiting', 'Blocked', 'On hold', 'Needs review'] and 'Draft sent' in opts and long in opts,
          'suggestions: common statuses plus the ones you use')
    sp.screenshot(path=os.path.join(HERE, 'status-on.png'), full_page=True)
    ph2 = open_page(browser, 390, 844, '2026-11-03T16:00:00Z', 'status-phone')
    no_overflow(ph2, 'phone add form with Status')
    ph2.locator('li.task', has_text='Send AGS quote').first.locator('[data-act="expand"]').click(); ph2.wait_for_timeout(200)
    no_overflow(ph2, 'phone editor with Status beside names')
    check(ph2.locator('li.task', has_text='Order relay').first.locator('.row > .status-pill').count() == 1, 'statuses sync to the phone')
    ph2.close()
    # Clearing removes it.
    li('Order relay').locator('.row > .status-pill').click(); sp.wait_for_timeout(300)
    sp.keyboard.press('Control+A'); sp.keyboard.press('Delete'); sp.keyboard.press('Tab'); sp.wait_for_timeout(400)
    li('Order relay').locator('[data-act="collapse"]').click(); sp.wait_for_timeout(200)
    check(row('Order relay')['status'] is None and li('Order relay').locator('.row > .status-pill').count() == 0,
          'clearing the box removes the status')
    li('Order relay').locator('[data-act="expand"]').click(); sp.wait_for_timeout(200)
    check(li('Order relay').locator('input[data-field="status"]').count() == 0
          and li('Order relay').locator('[data-act="status-toggle"]').get_attribute('aria-pressed') == 'false', 'and its box hides again')
    # Toggle off with a status set removes it.
    li('Send AGS quote').locator('[data-act="expand"]').click(); sp.wait_for_timeout(200)
    sub_row = li('Send AGS quote').locator('li.sub-edit', has=sp.locator('input[data-sub-status]'))
    check(sub_row.locator('[data-act="sub-status-toggle"]').get_attribute('aria-pressed') == 'true', 'a subtask with a status shows its toggle on')
    sub_row.locator('[data-act="sub-status-toggle"]').click(); sp.wait_for_timeout(400)
    check(all(not x.get('status') for x in row('Send AGS quote')['subtasks'])
          and li('Send AGS quote').locator('input[data-sub-status]').count() == 0, 'turning a subtask toggle off removes its status')
    li('Send AGS quote').locator('[data-act="collapse"]').click(); sp.wait_for_timeout(200)
    sp.screenshot(path=os.path.join(HERE, 'status.png'), full_page=True)
    # Colour.
    sp.click('.tabs [data-view="settings"]'); pick(sp, 'status', '#ffd000')
    sp.click('#settings-form button[type=submit]'); sp.wait_for_timeout(500)
    check(db['user_settings'][0]['settings']['colors'].get('status') == '#FFD000' and contrast_js(sp, '--status', '#FFFFFF') >= 4.5,
          'Status colour saved and kept readable')
    sp.close()

    # Time tracking.
    tm = open_page(browser, 400, 1400, '2026-11-03T16:00:00Z', 'time')  # Tue 10:00
    def tli(title): return tm.locator('ul[data-list="work"] li.task', has_text=title).first
    def tbtn(title): return tli(title).locator('.row > .timer-btn')
    def ents(): return db['time_entries']
    def running(): return [e for e in ents() if e['kind'] == 'timer' and e['ended_at'] is None]
    def tick(iso): tm.clock.set_fixed_time(iso); tm.wait_for_timeout(1300)
    def confirm_start(pg, keep=()):
        pg.wait_for_selector('#timer-dialog[open]')
        for name in keep:
            pg.locator('#timer-running label', has_text=name).locator('input').uncheck()
        pg.click('#timer-go'); pg.wait_for_timeout(400)
    A, B, C = 'Flash test units', 'Submit timesheet', 'Order relay'
    check(tbtn(A).inner_text().strip() == '▶' and tm.locator('#band .band-timer').count() == 0, 'each task has a start button; nothing running')
    tbtn(A).click(); tm.wait_for_timeout(400)
    check('running' in tbtn(A).get_attribute('class') and len(running()) == 1 and running()[0]['title'] == A
          and A in tm.inner_text('#band .band-timer'), 'start: button turns into stop, header shows the running task')
    tick('2026-11-03T16:30:00Z')
    check(tbtn(A).locator('.tt').inner_text() == '0:30:00' and tm.locator('#band .bt-time').inner_text() == '0:30:00',
          'the clock counts up live on the task and in the header')
    tbtn(B).click(); tm.wait_for_timeout(300)
    dlg = ' '.join(tm.inner_text('#timer-dialog').split())
    check(f'Start timer for {B}?' in dlg and f'Stop {A}' in dlg and tm.locator('#timer-running input:checked').count() == 1
          and tm.inner_text('#timer-go') == 'Stop 1 and start', f'a timer is running: popup lists it, ticked to stop: {dlg!r}')
    confirm_start(tm)
    a1 = [e for e in ents() if e['title'] == A][0]
    check(a1['ended_at'] == '2026-11-03T16:30:00.000Z' and a1['seconds'] == 1800 and running()[0]['title'] == B,
          'starting another task stops the first one')
    tick('2026-11-03T16:45:00Z')
    tbtn(A).click(); confirm_start(tm)
    tick('2026-11-03T17:00:00Z')
    check(tbtn(A).locator('.tt').inner_text() == '0:45:00' and len([e for e in ents() if e['title'] == A]) == 2,
          'starting the first task again adds on to its time')
    tli(A).locator('.check').click(); tm.wait_for_timeout(500)
    check(running() == [] and sum(e['seconds'] for e in ents() if e['title'] == A) == 2700, 'checking a task off stops its timer')
    tm.click('.tabs [data-view="time"]'); tm.wait_for_timeout(300)
    def tday(label): return tm.locator('section.time-day', has_text=label).first
    def tval(label, title): return tday(label).locator('li.time-row', has_text=title).locator('.time-val')
    check(tval('Tuesday, Nov 3', A).inner_text() == '0:45' and tval('Tuesday, Nov 3', B).inner_text() == '0:15'
          and tday('Tuesday, Nov 3').locator('.time-total').inner_text() == '1:00' and 'Week total 1:00' in tm.inner_text('.time-week-total'),
          'Time tab: each day lists its tasks and totals, plus a week total')
    tval('Tuesday, Nov 3', A).click(); tm.wait_for_timeout(200)
    tm.fill('input[data-time-input]', '1:30'); tm.press('input[data-time-input]', 'Enter'); tm.wait_for_timeout(500)
    adj = [e for e in ents() if e['kind'] == 'adjust']
    check(tval('Tuesday, Nov 3', A).inner_text() == '1:30' and len(adj) == 1 and adj[0]['seconds'] == 2700 and adj[0]['day'] == '2026-11-03'
          and 'Week total 1:45' in tm.inner_text('.time-week-total'), 'tap a time to correct it (kept as one correction)')
    for _ in range(5):  # a refresh can swallow the click; try again until the row opens
        if tm.locator('select[data-time-task]').count(): break
        tday('Monday, Nov 2').locator('[data-act="time-add"]').click(); tm.wait_for_timeout(300)
    tm.select_option('select[data-time-task]', label=B)
    tm.fill('input[data-time-add-input]', '45m'); tm.click('[data-act="time-add-save"]'); tm.wait_for_timeout(500)
    check(tval('Monday, Nov 2', B).inner_text() == '0:45' and 'Week total 2:30' in tm.inner_text('.time-week-total'), '+ Add time logs time on a day')
    tm.click('.time-by-task summary')
    check(B in tm.inner_text('.time-by-task') and '1:00' in tm.inner_text('.time-by-task'), 'week totals by task')
    tm.click('[data-act="time-prev"]'); tm.wait_for_timeout(200)
    check('Week of Oct 26' in tm.inner_text('.time-head') and 'Week total 0:00' in tm.inner_text('.time-week-total'), 'look back at earlier weeks')
    tm.click('[data-act="time-this-week"]'); tm.wait_for_timeout(200)
    no_overflow(tm, 'Time tab')
    tm.screenshot(path=os.path.join(HERE, 'time.png'), full_page=True)
    tm.click('.tabs [data-view="today"]'); tm.wait_for_timeout(200)

    # Subtask timers: their own time, separate from the task's.
    tm.click('.tabs [data-view="today"]'); tm.wait_for_timeout(200)
    tli(B).locator('[data-act="expand"]').click()
    nb = tli(B).locator('[data-sub-new]')
    for nm in ['Gather receipts', 'Fill form']:
        nb.fill(nm); nb.press('Enter'); tm.wait_for_timeout(300)
    tli(B).locator('[data-act="collapse"]').click(); tm.wait_for_timeout(200)
    def sbtn(name): return tli(B).locator('ul.subtasks li', has_text=name).locator('.timer-btn')
    check(sbtn('Gather receipts').count() == 1 and sbtn('Fill form').count() == 1, 'each subtask has its own start button')
    tm.clock.set_fixed_time('2026-11-03T17:05:00Z')
    sbtn('Gather receipts').click(); tm.wait_for_timeout(400)
    r0 = running()[0] if running() else {}
    check(r0.get('subtask_id') and r0.get('title') == 'Gather receipts' and 'running' in sbtn('Gather receipts').get_attribute('class')
          and 'running' not in tbtn(B).get_attribute('class') and 'Gather receipts' in tm.inner_text('#band .band-timer'),
          'subtask timer runs on its own (the task\'s button stays as it was), header shows the subtask')
    tick('2026-11-03T17:25:00Z')
    check(sbtn('Gather receipts').locator('.tt').inner_text() == '0:20:00' and tbtn(B).locator('.tt').inner_text() == '0:15',
          'subtask time counts on the subtask, not the task')
    tbtn(B).click(); confirm_start(tm)
    g = [e for e in ents() if e.get('subtask_id') and e['title'] == 'Gather receipts'][0]
    check(g['seconds'] == 1200 and running()[0]['subtask_id'] in (None, '') and running()[0]['title'] == B, 'starting the task stops its subtask\'s timer')
    tick('2026-11-03T17:30:00Z')
    sbtn('Fill form').click(); confirm_start(tm)
    check(running()[0]['title'] == 'Fill form' and tbtn(B).locator('.tt').inner_text() == '0:20', 'and starting a subtask stops the task\'s (task now 0:20)')
    tick('2026-11-03T17:40:00Z')
    tli(B).locator('ul.subtasks li', has_text='Fill form').locator('label').click(); tm.wait_for_timeout(500)
    check(running() == [] and [e for e in ents() if e['title'] == 'Fill form'][0]['seconds'] == 600, 'checking off a subtask stops its timer')
    tm.click('.tabs [data-view="time"]'); tm.wait_for_timeout(300)
    tue = tday('Tuesday, Nov 3')
    sub_rows = tue.locator('li.time-row.time-sub')
    check(sub_rows.count() == 2 and tval('Tuesday, Nov 3', 'Gather receipts').inner_text() == '0:20' and tval('Tuesday, Nov 3', 'Fill form').inner_text() == '0:10'
          and tue.locator('li.time-row:not(.time-sub)', has_text=B).locator('.time-val').inner_text() == '0:20',
          'Time tab: subtasks listed under their task with their own times')
    order = tue.locator('li.time-row').evaluate_all("els => els.map(e => e.querySelector('.time-title').textContent.replace('›','').trim())")
    check(order.index(B) < order.index('Gather receipts') and order.index(B) < order.index('Fill form'), f'subtask lines sit right under their task: {order}')
    check(tue.locator('.time-total').inner_text() == '2:20' and 'Week total 3:05' in tm.inner_text('.time-week-total'),
          'day and week totals include subtask time')
    tval('Tuesday, Nov 3', 'Gather receipts').click(); tm.fill('input[data-time-input]', '0:30'); tm.press('input[data-time-input]', 'Enter'); tm.wait_for_timeout(500)
    sadj = [e for e in ents() if e['kind'] == 'adjust' and e.get('subtask_id')]
    check(len(sadj) == 1 and sadj[0]['seconds'] == 600 and tval('Tuesday, Nov 3', 'Gather receipts').inner_text() == '0:30'
          and tue.locator('li.time-row:not(.time-sub)', has_text=B).locator('.time-val').inner_text() == '0:20', 'correcting a subtask\'s time leaves its task\'s alone')
    if not tm.evaluate("document.querySelector('.time-by-task').open"): tm.click('.time-by-task summary')
    check(f'{B} › Gather receipts' in tm.inner_text('.time-by-task'), 'week totals list subtasks with their task')
    tm.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); tm.wait_for_timeout(900)  # a refresh
    check(tm.evaluate("document.querySelector('.time-by-task').open"), '"By task" stays open through a refresh')
    no_overflow(tm, 'Time tab with subtasks')
    tm.screenshot(path=os.path.join(HERE, 'time-subs.png'), full_page=True)
    tm.click('.tabs [data-view="today"]'); tm.wait_for_timeout(200)
    no_overflow(tm, 'task list with subtask timers')

    # Several timers at once.
    tm.click('.tabs [data-view="today"]'); tm.wait_for_timeout(200)
    tm.clock.set_fixed_time('2026-11-03T18:00:00Z')  # 12:00
    D, E = 'Send revised wiring diagram to Marcus', 'Quarterly backup check'
    tbtn(D).click(); tm.wait_for_timeout(400)
    check(tm.locator('#timer-dialog[open]').count() == 0 and len(running()) == 1, 'nothing running: ▶ just starts, no popup')
    tbtn(E).click(); tm.wait_for_timeout(300)
    tm.locator('#timer-running label', has_text=D).locator('input').uncheck()
    check(tm.inner_text('#timer-go') == 'Start alongside', 'unticking: the button says Start alongside')
    tm.locator('#timer-dialog').screenshot(path=os.path.join(HERE, 'timer-dialog.png'))
    tm.click('#timer-go'); tm.wait_for_timeout(400)
    check(sorted(e['title'] for e in running()) == sorted([D, E]) and 'running' in tbtn(D).get_attribute('class')
          and 'running' in tbtn(E).get_attribute('class') and tm.locator('#band .bt-more').inner_text() == '+1',
          'both run; each shows its own stop; header shows +1')
    tick('2026-11-03T18:20:00Z')
    check(tbtn(D).locator('.tt').inner_text() == '0:20:00' and tbtn(E).locator('.tt').inner_text() == '0:20:00', 'both clocks count')
    tm.click('#band .band-timer'); tm.wait_for_timeout(300)
    check(tm.locator('#timer-dialog[open]').count() == 1 and tm.locator('#timer-running .tr-stop').count() == 2, 'header with several running: lists them')
    tm.locator('#timer-running .tr-stop', has_text=E).locator('button').click(); tm.wait_for_timeout(400)
    check([e['title'] for e in running()] == [D], 'stop just one from the list')
    tbtn(E).click(); tm.wait_for_timeout(300)
    tm.locator('#timer-running label', has_text=D).locator('input').uncheck(); tm.click('#timer-go'); tm.wait_for_timeout(400)
    tbtn(D).click(); tm.wait_for_timeout(400)  # its own ■
    check([e['title'] for e in running()] == [E] and tm.locator('#timer-dialog[open]').count() == 0, "a running task's ■ stops only that timer")
    tbtn(D).click(); tm.wait_for_timeout(300)
    tm.click('#timer-dialog .dialog-x'); tm.wait_for_timeout(300)
    check([e['title'] for e in running()] == [E], 'Cancel (×): nothing starts or stops')
    tbtn(D).click(); tm.wait_for_timeout(300); tm.locator('#timer-running input').uncheck(); tm.click('#timer-go'); tm.wait_for_timeout(400)
    tm.click('#band .band-timer'); tm.wait_for_timeout(300); tm.click('#timer-stopall'); tm.wait_for_timeout(400)
    check(running() == [], 'Stop all from the header')
    no_overflow(tm, 'several timers')

    # Stops by itself at the end of work hours (work hours reset to 8:00-5:00, button 15/15, as earlier tests changed them).
    db['user_settings'][0]['settings'].update(workEnd='17:00', extendPromptMinutes=15, extendVisibleMinutes=15, workExtension=None)
    state['version'] += 1
    tm.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); tm.wait_for_timeout(1000)
    tm.clock.set_fixed_time('2026-11-03T22:50:00Z')  # 16:50
    tbtn(C).click(); tm.wait_for_timeout(400)
    tm.clock.set_fixed_time('2026-11-03T23:01:00Z')  # 17:01
    tm.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); tm.wait_for_timeout(1200)
    c1 = [e for e in ents() if e['title'] == C][-1]
    check(running() == [] and c1['ended_at'] == '2026-11-03T23:00:00.000Z' and c1['seconds'] == 600
          and 'end of work hours' in tm.inner_text('#toast'), f'still running at 5:00 PM: stopped at 5:00 PM exactly ({c1["ended_at"]})')
    # App closed at the end of the day: stopped at 5:00, not when reopened.
    tm.clock.set_fixed_time('2026-11-03T22:55:00Z')
    tbtn(C).click(); tm.wait_for_timeout(400)
    tm.close()
    wd = open_page(browser, 400, 1000, '2026-11-04T14:00:00Z', 'time-next-morning')  # Wed 08:00
    c2 = [e for e in ents() if e['title'] == C][-1]
    check(running() == [] and c2['ended_at'] == '2026-11-03T23:00:00.000Z' and c2['seconds'] == 300,
          'app closed overnight: the timer was stopped at 5:00 PM, not this morning')
    # Started after hours: keeps running.
    wd.clock.set_fixed_time('2026-11-04T23:30:00Z')  # Wed 17:30
    wd.locator('li.task', has_text=C).first.locator('.timer-btn').click(); wd.wait_for_timeout(400)
    wd.clock.set_fixed_time('2026-11-04T23:40:00Z')
    wd.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); wd.wait_for_timeout(1200)
    check(len(running()) == 1, 'a timer started after work hours is not stopped straight away')
    wd.click('#band .band-timer'); wd.wait_for_timeout(400)
    check(running() == [], 'stop it from the header')
    wd.close()

    # Header and tabs stay pinned while scrolling.
    pin = open_page(browser, 400, 640, '2026-11-03T16:00:00Z', 'pinned')
    tall = pin.evaluate("document.documentElement.scrollHeight") > 640 * 1.5
    pin.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)"); pin.wait_for_timeout(300)
    bar = pin.evaluate("""() => { const b = document.getElementById('band').getBoundingClientRect(), t = document.querySelector('.tabs').getBoundingClientRect();
      return { bandTop: b.top, tabsBottom: t.bottom, scrolled: window.scrollY }; }""")
    check(tall and bar['scrolled'] > 300 and abs(bar['bandTop']) < 1 and bar['tabsBottom'] < 160,
          f'scrolled to the bottom: header and tabs still at the top ({bar})')
    last = pin.locator('#view li.task').last
    last.locator('[data-act="expand"]').click(); pin.wait_for_timeout(300)
    pin.locator('#view li.task .editor input[data-field="title"]').focus(); pin.wait_for_timeout(300)
    hidden = pin.evaluate("""() => { const i = document.activeElement.getBoundingClientRect(), t = document.querySelector('.topbar').getBoundingClientRect();
      return i.top < t.bottom; }""")
    check(not hidden, 'a field that gets the cursor is not hidden under the pinned bar')
    pin.click('.tabs [data-view="calendar"]'); pin.wait_for_timeout(300)
    check(pin.locator('.cal-grid').count() == 1, 'tabs work while scrolled down')
    pin.click('.tabs [data-view="time"]'); pin.wait_for_timeout(200)
    pin.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)"); pin.wait_for_timeout(200)
    check(abs(pin.evaluate("document.getElementById('band').getBoundingClientRect().top")) < 1, 'pinned on every tab')
    no_overflow(pin, 'pinned bar')
    pin.close()

    # App list.
    ap = open_page(browser, 400, 1400, '2026-11-03T16:00:00Z', 'app-list')  # Tue 10:00
    def sec_titles(pg): return pg.eval_on_selector_all('#view > .section > h2', 'e => e.map(x => x.firstChild.textContent.trim())')
    check('App' not in sec_titles(ap), 'no App section until something is in it')
    ap.click('#add [data-ctx="app"]')
    check(ap.get_attribute('#add [data-ctx="app"]', 'aria-pressed') == 'true' and not ap.locator('#add [data-daily]').is_visible(),
          'add form: App next to Work and Home; Daily toggle hidden for App')
    ap.fill('#add input[name=title]', 'Add CSV export to Time tab'); ap.press('#add input[name=title]', 'Enter'); ap.wait_for_timeout(300)
    ap.fill('#add input[name=title]', 'Dark mode for print'); ap.press('#add input[name=title]', 'Enter'); ap.wait_for_timeout(300)
    check(row('Add CSV export to Time tab')['context'] == 'app' and row('Add CSV export to Time tab')['repeat'] is None, 'saved in the App list')
    order = sec_titles(ap)
    check(order.index('App') > order.index('Work') and order.index('App') > order.index('Home'),
          f'App section comes after Work and Home: {order}')
    check(titles(ap, 'app') == ['Add CSV export to Time tab', 'Dark mode for print'], 'App tasks listed in their own section')
    app_li = ap.locator('ul[data-list="app"] li.task').first
    check(app_li.locator('.timer-btn').count() == 0, 'no timer on App tasks')
    app_li.locator('[data-act="expand"]').click(); ap.wait_for_timeout(200)
    ed = ap.locator('ul[data-list="app"] li.task').first
    check(ed.locator('select[data-repeat]').count() == 0 and ed.locator('[data-act="ctx"][data-val="app"]').get_attribute('aria-pressed') == 'true'
          and ed.locator('input[data-field="dueDate"]').count() == 1 and ed.locator('[data-act="status-toggle"]').count() == 1,
          'editor: no Repeats; App selected; due date and status still there')
    sb = ed.locator('[data-sub-new]'); sb.fill('Pick columns'); sb.press('Enter'); ap.wait_for_timeout(300)
    ed = ap.locator('ul[data-list="app"] li.task').first
    ed.locator('[data-act="collapse"]').click(); ap.wait_for_timeout(200)
    check(ap.locator('ul[data-list="app"] li.task').first.locator('ul.subtasks li').count() == 1
          and ap.locator('ul[data-list="app"] li.task').first.locator('ul.subtasks .timer-btn').count() == 0, 'subtasks work; no subtask timers either')
    # Drag within App: up onto the top edge of a long-named task (its row must not grow while hovered).
    ap.wait_for_timeout(1000)  # let the sync refresh from adding the subtask land first
    ap.locator('ul[data-list="app"]').scroll_into_view_if_needed(); ap.wait_for_timeout(300)
    src = ap.locator('ul[data-list="app"] > li', has_text='Dark mode for print').locator('.drag')
    dst = ap.locator('ul[data-list="app"] > li').first.locator('.row')
    a_, b_ = boxes(ap, src, dst)
    y1 = b_['y'] + 4
    ap.mouse.move(a_['x'] + 5, a_['y'] + 5); ap.mouse.down()
    heights = []
    for i in range(40):
        ap.mouse.move(a_['x'] + 5, a_['y'] + 5 + (y1 - a_['y'] - 5) * (i + 1) / 40); ap.wait_for_timeout(15)
        heights.append(ap.evaluate("document.querySelector('ul[data-list=\"app\"] > li .row').getBoundingClientRect().height"))
    ap.mouse.up(); ap.wait_for_timeout(600)
    if ap.locator('#nest-dialog[open]').count(): ap.click('#nest-dialog [value="cancel"]')
    check(max(heights) - min(heights) < 1, f'a hovered task keeps its size while dragging over it: {min(heights)}..{max(heights)}')
    check(titles(ap, 'app')[0] == 'Dark mode for print', f'drop on the top edge of a long-named task reorders: {titles(ap, "app")}')
    # Moving a daily task with a running timer to App: repeat off, timer stopped.
    d_li = ap.locator('ul[data-list="daily-work"] li.task', has_text='Review PRs')
    d_li.locator('.check').click(); ap.wait_for_timeout(400)  # earlier tests ticked it for today: untick so it has a timer
    d_li.locator('.row > .timer-btn').click(); ap.wait_for_timeout(300)
    d_li.locator('[data-act="expand"]').click(); ap.wait_for_timeout(200)
    ap.locator('li.task', has_text='Review PRs').locator('[data-act="ctx"][data-val="app"]').click(); ap.wait_for_timeout(500)
    ci = row('Review PRs')
    check(ci['context'] == 'app' and ci['repeat'] is None and not [e for e in db['time_entries'] if e['kind'] == 'timer' and e['ended_at'] is None],
          'moving a daily task with a running timer to App: no longer repeats, timer stopped')
    check('Review PRs' in titles(ap, 'app'), 'it now shows in App')
    # Needs sorting offers App.
    ap.click('#add [data-ctx="work"]')
    db['tasks'].append({**row('Dark mode for print'), 'id': 'unsorted-1', 'title': 'Granola idea', 'context': None, 'sort_key': 1})
    state['version'] += 1; ap.wait_for_timeout(1200)
    ap.locator('li.task', has_text='Granola idea').locator('[data-act="classify"][data-val="app"]').click(); ap.wait_for_timeout(400)
    check(row('Granola idea')['context'] == 'app', '"Which list?" on imported items includes App')
    # Calendar and colour.
    ap.locator('ul[data-list="app"] li', has_text='Add CSV export').locator('[data-act="expand"]').click(); ap.wait_for_timeout(200)
    ap.locator('li.task', has_text='Add CSV export').locator('input[data-field="dueDate"]').fill('2026-11-06'); ap.wait_for_timeout(400)
    ap.click('.tabs [data-view="calendar"]'); ap.click('[data-date="2026-11-06"]'); ap.wait_for_timeout(200)
    check('Add CSV export to Time tab' in titles(ap, 'cal-app') and ap.locator('[data-date="2026-11-06"] .dots .ap').count() == 1,
          'App tasks with dates show on the Calendar, with their own dot')
    ap.click('.tabs [data-view="time"]'); ap.wait_for_timeout(200)
    ap.click('[data-act="time-add"]'); ap.wait_for_timeout(200)
    opts = ap.eval_on_selector_all('select[data-time-task] option', 'e => e.map(o => o.textContent)')
    check(not any('CSV export' in o or 'Dark mode for print' in o for o in opts), 'App tasks are not offered for logging time')
    ap.click('[data-act="time-cancel"]')
    ap.click('.tabs [data-view="settings"]'); pick(ap, 'app', '#00aa00')
    ap.click('#settings-form button[type=submit]'); ap.wait_for_timeout(500)
    ap.click('.tabs [data-view="today"]'); ap.wait_for_timeout(300)
    bar = ap.evaluate("getComputedStyle(document.querySelector('li.task.ctx-app')).borderLeftColor")
    check(db['user_settings'][0]['settings']['colors'].get('app') == '#00AA00' and bar == 'rgb(0, 170, 0)', 'App colour in Settings')
    no_overflow(ap, 'App list')
    ap.close()

    browser.close()

print('\n'.join(errors) if errors else 'no page errors')
sys.exit(1 if check.failed else 0)
