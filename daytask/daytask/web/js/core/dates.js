// Pure date helpers. Dates are plain 'YYYY-MM-DD' strings so they compare
// lexically and never drift across time zones.

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(ymd, n) {
  const dt = toUtc(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(ymd) {
  return toUtc(ymd).getUTCDay();
}

export function ymdFromParts(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Local calendar date, clock time and weekday of an instant in an IANA time zone. */
export function localParts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

/** Next date on or after `ymd` that falls on weekday `wd` (0 = Sunday). */
export function onOrAfterWeekday(ymd, wd) {
  return addDays(ymd, (wd - weekdayOf(ymd) + 7) % 7);
}

/** Weeks (Sunday first) covering the given month; days outside the month are included. */
export function monthGrid(year, month0) {
  const first = ymdFromParts(year, month0 + 1, 1);
  let cursor = addDays(first, -weekdayOf(first));
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) { week.push(cursor); cursor = addDays(cursor, 1); }
    weeks.push(week);
    if (Number(cursor.slice(5, 7)) !== month0 + 1 && w >= 3) break;
  }
  return weeks;
}

export function formatDay(ymd, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(toUtc(ymd));
}

export function formatClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);
}
