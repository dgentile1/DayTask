// Pure colour maths for user-chosen colours: keep text readable whatever is picked.

export const COLOR_KEYS = ['work', 'home', 'app', 'daily', 'status', 'high', 'soon', 'today', 'overdue', 'unsorted'];

export const COLOR_LABELS = {
  work: 'Work',
  home: 'Home',
  app: 'App',
  daily: 'Daily tasks',
  status: 'Status',
  high: 'High priority',
  soon: 'Due soon',
  today: 'Due today',
  overdue: 'Overdue',
  unsorted: 'Needs sorting',
};

// Built-in palette (what the stylesheet uses), per theme. Shown in the pickers when nothing is customised.
export const DEFAULT_COLORS = {
  light: { work: '#2C64A8', home: '#2F7D55', app: '#A3366F', daily: '#0F766E', status: '#475569', high: '#B4470F', soon: '#8A5A00', today: '#B4470F', overdue: '#B42318', unsorted: '#6E4FA0' },
  dark:  { work: '#3F78BE', home: '#3A8C62', app: '#D45C9B', daily: '#2BA59A', status: '#94A3B8', high: '#F08A4B', soon: '#E8B84A', today: '#F08A4B', overdue: '#F2766B', unsorted: '#8B6CC0' },
};

export const SURFACES = {
  light: { surface: '#FFFFFF', paper: '#EDF0F3', ink: '#16202A' },
  dark: { surface: '#1C232B', paper: '#13181E', ink: '#E5EAEF' },
};

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (s) => typeof s === 'string' && HEX.test(s);

function toRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Blend `hex` toward `target` by t (0 = hex, 1 = target). */
export function mix(hex, target, t) {
  const a = toRgb(hex), b = toRgb(target);
  return toHex(a.map((v, i) => v + (b[i] - v) * t));
}

/** Text colour (near-white or near-black) that reads best on a fill of `hex`. */
export function onColor(hex) {
  return contrast(hex, '#FFFFFF') >= contrast(hex, '#111111') ? '#FFFFFF' : '#111111';
}

/**
 * Nudge `hex` darker (light theme) or lighter (dark theme) just until it reaches
 * `ratio` contrast against every background given. Keeps the hue the user chose.
 */
export function readableOn(hex, backgrounds, theme, ratio = 4.5) {
  const target = theme === 'dark' ? '#FFFFFF' : '#000000';
  const ok = (c) => backgrounds.every((bg) => contrast(c, bg) >= ratio);
  if (ok(hex)) return hex.toUpperCase();
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(hex, target, t);
    if (ok(c)) return c;
  }
  return target === '#000000' ? '#000000' : '#FFFFFF';
}

/**
 * CSS custom properties for the user's colours in the given theme.
 * Only customised colours are returned; anything else keeps the stylesheet default.
 */
export function themeVars(colors, theme) {
  const bgs = [SURFACES[theme].surface, SURFACES[theme].paper];
  const vars = {};
  const c = colors || {};
  if (isHex(c.work)) {
    vars['--work'] = c.work;
    vars['--on-work'] = onColor(c.work);
    vars['--work-text'] = readableOn(c.work, bgs, theme);
  }
  if (isHex(c.home)) {
    vars['--home'] = c.home;
    vars['--on-home'] = onColor(c.home);
    vars['--home-text'] = readableOn(c.home, bgs, theme);
  }
  if (isHex(c.app)) {
    vars['--app'] = c.app;
    vars['--on-app'] = onColor(c.app);
    vars['--app-text'] = readableOn(c.app, bgs, theme);
  }
  if (isHex(c.daily)) {
    vars['--daily'] = c.daily;
    vars['--on-daily'] = onColor(c.daily);
    vars['--daily-text'] = readableOn(c.daily, bgs, theme);
  }
  if (isHex(c.status)) vars['--status'] = readableOn(c.status, bgs, theme);
  if (isHex(c.high)) { const x = readableOn(c.high, bgs, theme); vars['--flag'] = x; vars['--on-flag'] = onColor(x); }
  if (isHex(c.today)) vars['--today'] = readableOn(c.today, bgs, theme);
  if (isHex(c.overdue)) vars['--danger'] = readableOn(c.overdue, bgs, theme);
  if (isHex(c.unsorted)) vars['--sort'] = readableOn(c.unsorted, bgs, theme, 3);
  if (isHex(c.soon)) {
    const bannerBg = mix(c.soon, SURFACES[theme].surface, theme === 'dark' ? 0.82 : 0.86);
    vars['--soon-bg'] = bannerBg;
    vars['--soon'] = readableOn(c.soon, [...bgs, bannerBg], theme);
  }
  return vars;
}

export function normalizeColors(raw) {
  const out = {};
  for (const k of COLOR_KEYS) if (isHex(raw?.[k])) out[k] = raw[k].toUpperCase();
  return out;
}
