import Foundation

/// Runs in every page before its own scripts (WKUserScript, document start).
///
/// 1. window.halayShell: tells the web UI it is inside the Mac app (it hides the Web Push setting, which can't work here).
/// 2. Notification: WKWebView has no Notification API, but the UI uses `new Notification(...)` for agents' alerts
///    (public/js/agents.js). This stand-in reports permission "granted", hands each notification to Swift (which posts a
///    real macOS one) and, when it is clicked, calls the page's own onclick, so it navigates exactly as in a browser.
///    Service workers and Push don't exist here, so the page never takes its showNotification path.
let shimSource = #"""
(() => {
  if (window.halayShell) return;
  const post = (m) => window.webkit.messageHandlers.halay.postMessage(m);
  Object.defineProperty(window, 'halayShell', { value: Object.freeze({ platform: 'macos', version: 1 }) });

  const live = new Map();   // id -> Notification, so a click can reach the object whose onclick the page set
  let seq = 0;
  class HalayNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body == null ? '' : String(options.body);
      this.tag = options.tag == null ? '' : String(options.tag);
      this.icon = options.icon || '';
      this.data = options.data === undefined ? null : options.data;
      this.onclick = this.onclose = this.onshow = this.onerror = null;
      this._id = 'n' + (++seq) + '-' + Date.now();
      live.set(this._id, this);
      if (live.size > 200) live.delete(live.keys().next().value);
      // the url a click goes to when the page that made this one is gone (the page reloaded): data.url, like sw.js
      post({ type: 'notify', id: this._id, title: this.title, body: this.body, tag: this.tag, url: (this.data && typeof this.data.url === 'string') ? this.data.url : '' });
      queueMicrotask(() => this._fire('show'));
    }
    _fire(type) { const e = new Event(type); if (typeof this['on' + type] === 'function') this['on' + type](e); this.dispatchEvent(e); }
    close() { post({ type: 'close', id: this._id, tag: this.tag }); live.delete(this._id); this._fire('close'); }
    static get permission() { return 'granted'; }
    static get maxActions() { return 0; }
    static requestPermission(cb) { if (typeof cb === 'function') cb('granted'); return Promise.resolve('granted'); }
  }
  Object.defineProperty(window, 'Notification', { value: HalayNotification, writable: true, configurable: true });

  // the page is drawn under the title bar (WebWindow.swift): the stylesheet makes room for the window's buttons, and the empty
  // strip along the top drags the window (a web view has no -webkit-app-region), a double click zooms it
  const markMac = () => document.documentElement.classList.add('halay-mac');
  markMac();
  const interactive = 'a,button,input,select,textarea,summary,label,dialog,[role=button],[contenteditable],[tabindex]:not(main):not(#main)';
  addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.clientY > 44 || e.target.closest(interactive)) return;
    post({ type: e.detail === 2 ? 'zoom' : 'drag' });
  }, true);
  // the window takes the page's colour (the title bar is transparent) and, from it, a light or dark look for the window's buttons
  const sendTheme = () => post({ type: 'theme', color: document.querySelector('meta[name="theme-color"]')?.content || '' });
  document.addEventListener('halay:theme', sendTheme);
  addEventListener('DOMContentLoaded', sendTheme);

  // Swift calls this when a macOS notification is clicked
  window.__halayNotificationClicked = (id, url) => {
    const n = live.get(id);
    if (n) { n._fire('click'); return true; }
    if (url) { location.href = url; return true; }
    return false;
  };
})();
"""#
