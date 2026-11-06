// Bridge to the Windows desktop shell (WebView2). Absent on phone/browser.
const wv = window.chrome && window.chrome.webview;

export const host = {
  available: !!wv,
  toggleTopMost() { wv?.postMessage({ type: 'toggleTopMost' }); },
  /** Windows notification from the desktop shell. */
  notify(title, body) { wv?.postMessage({ type: 'notify', title, body }); },
  /** handlers: { topMost(bool), granolaNotes({text,title,date}) } */
  listen(handlers) {
    if (!wv) return;
    wv.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'topMost') handlers.topMost?.(!!m.value);
      if (m.type === 'granolaNotes') handlers.granolaNotes?.(m);
    });
    wv.postMessage({ type: 'hello' });
  },
};
