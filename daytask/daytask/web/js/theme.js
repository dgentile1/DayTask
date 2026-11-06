// Applies the user's theme (light / dark / match device) and custom colours to the page.
import { themeVars } from './core/colors.js';

const MANAGED_VARS = ['--work', '--on-work', '--work-text', '--home', '--on-home', '--home-text', '--daily', '--on-daily', '--daily-text', '--status',
  '--flag', '--on-flag', '--today', '--danger', '--sort', '--soon', '--soon-bg'];
const CACHE_KEY = 'daytask.lastTheme'; // so reopening the app shows your colours instantly
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let current = null;
let onChange = () => {};

export function activeTheme(settings) {
  return settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : (darkQuery.matches ? 'dark' : 'light');
}

/** settings: { theme, colors }. remember=false for live previews that may be discarded. */
export function applyTheme(settings, { remember = true } = {}) {
  current = { theme: settings.theme || 'auto', colors: settings.colors || {} };
  const root = document.documentElement;
  if (current.theme === 'auto') root.removeAttribute('data-theme'); else root.dataset.theme = current.theme;
  for (const v of MANAGED_VARS) root.style.removeProperty(v);
  for (const [k, v] of Object.entries(themeVars(current.colors, activeTheme(current)))) root.style.setProperty(k, v);
  if (remember) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(current)); } catch { /* ignore */ } }
  onChange();
}

export function applyCachedTheme() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached) applyTheme(cached, { remember: false });
  } catch { /* ignore */ }
}

/** Called after any theme change, including the device switching light/dark. */
export function onThemeChange(cb) { onChange = cb; }

darkQuery.addEventListener('change', () => { if (current) applyTheme(current, { remember: false }); });
