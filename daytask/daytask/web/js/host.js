// Bridge to the Windows desktop shell (WebView2). Absent on phone/browser.
const wv = window.chrome && window.chrome.webview;

// The desktop shell can widen the page (Settings > Desktop > Maximum width). The shell owns the
// value; it's kept here too only so the page opens at the right width before the shell says so.
const WIDTH_KEY = 'daytask.desktopMaxWidth';
function applyMaxWidth(px) {
  if (px > 0) document.documentElement.style.setProperty('--app-max', `${px}px`);
}
if (wv) {
  try { applyMaxWidth(Number(localStorage.getItem(WIDTH_KEY))); } catch { /* storage blocked */ }
}

export const host = {
  available: !!wv,
  toggleTopMost() { wv?.postMessage({ type: 'toggleTopMost' }); },
  /** Widest the page content may get on this computer, in CSS px. The shell clamps and saves it. */
  setMaxWidth(px) { wv?.postMessage({ type: 'setMaxWidth', value: Math.round(px) }); },
  /** Windows notification from the desktop shell. */
  notify(title, body) { wv?.postMessage({ type: 'notify', title, body }); },
  /** handlers: { topMost(bool), maxWidth({value,min,max,default}), shell({version}), granolaNotes({text,title,date}) } */
  listen(handlers) {
    if (!wv) return;
    wv.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'topMost') handlers.topMost?.(!!m.value);
      if (m.type === 'maxWidth') {
        applyMaxWidth(m.value);
        try { localStorage.setItem(WIDTH_KEY, String(m.value)); } catch { /* storage blocked */ }
        handlers.maxWidth?.(m);
      }
      if (m.type === 'shell') handlers.shell?.(m);
      if (m.type === 'granolaNotes') handlers.granolaNotes?.(m);
    });
    wv.postMessage({ type: 'hello' });
  },
};
