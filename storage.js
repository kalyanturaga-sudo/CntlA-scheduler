/* ============================================================
   storage.js  —  Ctrl+A Shared Storage Engine  v5.4
   ------------------------------------------------------------
   v5.4: Rebranded Taskmaster -> Ctrl+A. Same DISPLAY-ONLY rule as
   v5.1 below — the ONLY change is APP_BRAND (name + tagline). The
   internal storage keys, the Drive file name (onetrack-data.json),
   and the localStorage keys all still KEEP their ONETRACK_* names
   on purpose. Do NOT rename them — it would orphan saved data.
   ------------------------------------------------------------
   v5.1: Rebranded Onetrack -> Taskmaster. This is a DISPLAY-ONLY
   change (title text, nav brand, banner/tooltip copy, console
   labels). Every internal storage key, the Drive file name, and
   the localStorage keys below all KEEP their ONETRACK_* names on
   purpose — they're a stable internal schema, not the product
   name. Renaming them would orphan existing saved data. See
   APP_BRAND below for the one place that controls user-facing
   name/tagline text going forward.
   ------------------------------------------------------------
   v5.0: storage.js now does THREE jobs instead of one, so every
   HTML page only ever needs ONE shared script tag:

     1. STORAGE  (unchanged from v4.0) — Drive sync, OAuth.
     2. NAV      (new) — builds the sidebar links into
        <div id="onetrack-nav-links"></div> on every page, with
        drag-to-reorder (grip-dot handle). Settings is always
        pinned at the bottom and is not draggable.
     3. THEME    (new) — applies dark mode, accent colour, and
        font scale to every page from one place, instead of each
        page having its own copy (which is why pages used to look
        inconsistent with each other).

   PUBLIC API — all unchanged, every HTML file works as-is:
     await OT.get(key) / OT.set(key,value) / OT.remove(key)
     await OT.keys() / OT.getAll() / OT.setAll(obj) / OT.clear()
     OT.onReady(fn)  /  OT.isReady()  /  OT.onChange(fn)  (new)
     OT.brand  —  { name, tagline }  (new, v5.1 — read instead of
       hardcoding "Onetrack"/"Taskmaster" text on each page)
     OT.renderBrandFooter(containerId, version, lastUpdated)
       (new, v5.2/5.3 — fills a <div id="..."></div> with one muted
       line: "{tagline} · {version} · Last updated DD-MMM-YY HH:MM".
       Always DISPLAYED in Australia/Sydney (AEST/AEDT) time, no
       matter what time zone the viewing device is set to. Pass
       lastUpdated as an ISO string with an explicit offset, e.g.
       "2026-06-28T09:20:00+10:00", so the underlying instant is
       unambiguous — lastUpdated is the moment YOU edited that
       page's code, not when it's viewed.)

   HOW STORAGE WORKS (v4.0, unchanged):
   1. Banner shows "Sign in to sync".
   2. Tapping Sign in saves the current page URL, then does a
      normal full-page redirect to Google's consent screen.
   3. Google redirects back to oauth-callback.html (a single
      fixed page, registered as the OAuth redirect URI).
   4. That page grabs the token from the URL, stores it in
      sessionStorage, and redirects back to the original page.
   5. This storage.js picks up the token from sessionStorage on
      load — no popup, no GIS script, no ITP issues.
   6. Token lives in sessionStorage (this browser tab/session
      only) — expires after ~1 hour, same re-sign-in cadence as
      before, just via redirect instead of popup.

   HOW NAV WORKS (v5.0, new):
   - The page list + labels live in NAV_PAGES below — edit that
     array (and nowhere else) to add/rename/remove a page.
   - Drag order is saved in localStorage (ONETRACK_NAV_ORDER) —
     instant, same-origin, no Drive round-trip needed, works the
     moment you drop.
   - Every page must have <div id="onetrack-nav-links"></div>
     inside its <nav id="onetrack-nav">...</nav> for this to have
     somewhere to render into.

   HOW THEME WORKS (v5.0, new):
   - Reads TODAY_DARK / ONETRACK_ACCENT / ONETRACK_ACCENT_DARK /
     ONETRACK_FONT_SCALE from the synced file (same keys Settings
     already writes — Settings doesn't need to change).
   - A tiny snapshot of those values is mirrored into localStorage
     (ONETRACK_THEME_SNAPSHOT) purely so the very next page load
     can paint the correct theme INSTANTLY, before the Drive file
     has even finished loading — this is what prevents the
     "flash of wrong theme" that each page used to prevent on its
     own with a private copy of this exact logic.
   - Also sets a handful of extra per-section CSS variables
     (--ft-accent, --pt-accent, --roh-accent, --esh-accent,
     --kal-accent, --trv-accent, --rtn-accent and their *-soft
     versions) on every page. Most pages don't use these and the
     extra variables are simply ignored — but Checklists.html
     does use them for its per-section colour theming, and this
     is what keeps that working without needing page-specific
     code anywhere.

   CONFIG:
   ============================================================ */
  const GOOGLE_CLIENT_ID = '356548061716-4fjrgh28vetubhuu2cf4ano859tnftuv.apps.googleusercontent.com';
  const DRIVE_FILE_NAME  = 'onetrack-data.json';
  const REDIRECT_URI     = 'https://kalyanturaga-sudo.github.io/onetrack-scheduler/oauth-callback.html';

  /* ── BRAND CONFIG — change product name/tagline ONLY here.
     Internal storage keys / file names above are untouched on
     purpose (see header note). ── */
  const APP_BRAND = {
    name:    'Ctrl+A',
    tagline: 'Capture all. Control all.',
  };

  /* ── NAV CONFIG — edit this list to add/rename/remove a page ── */
  const NAV_PAGES = [
    { id: 'ttb',        file: 'TT&B.html',           label: 'TT&B' },
    { id: 'routines',   file: 'Routines.html',       label: 'Routines' },
    { id: 'jobs',       file: 'Jobs.html',           label: 'Jobs' },
    { id: 'checklists', file: 'Checklists.html',     label: 'Checklists' },
    { id: 'trip',       file: 'Trip Planners.html',  label: 'Trip Planners' },
    { id: 'weekly',     file: 'Weekly Planners.html',label: 'Weekly Planners' },
    { id: 'libraries',  file: 'Libraries.html',      label: 'Libraries' },
  ];
  /* Settings is intentionally NOT in NAV_PAGES — it's pinned at the
     bottom of the sidebar always, and is never draggable. */
  const NAV_SETTINGS = { id: 'settings', file: 'Settings.html', label: 'Settings' };

  /* ── BASE PALETTE — change colours here ONLY. This is injected as a
     <style> tag into every page automatically; no page has its own
     copy of these anymore. Per-page CSS still defines layout-specific
     vars (--radius, --nav-width, --shadow, per-section gradients,
     button colours, etc.) — only the shared bg/surface/text scale
     lives here. ── */
  const BASE_THEME = {
    light: {
      '--bg': '#f3f2f0', '--surface': '#ffffff', '--surface2': '#f8f7f5',
      '--border': 'rgba(0,0,0,0.08)',
      '--text': '#16151a', '--text2': '#5c5a60', '--text3': '#93919a',
    },
    dark: {
      '--bg': '#0e0e12', '--surface': '#18181d', '--surface2': '#1f1f26',
      '--border': 'rgba(255,255,255,0.08)',
      '--text': '#ededf0', '--text2': '#a3a1a8', '--text3': '#6f6d76',
    },
  };
/* ============================================================ */

(function (global) {
  'use strict';

  const SCOPE        = 'https://www.googleapis.com/auth/drive';
  const BANNER_ID     = 'ot-storage-banner';
  const INDICATOR_ID  = 'ot-sync-indicator';

  /* ── Internal state ── */
  let _accessToken = null;
  let _fileId      = null;
  let _cache       = null;
  let _ready       = false;
  let _readyQueue  = [];
  // Keys written via OT.set()/remove() while not yet connected to Drive
  // (or while a load is in flight) get tracked here, then replayed on
  // top of the loaded file in _loadFromFile() so they're never silently
  // lost when the real Drive data arrives.
  let _pendingLocal = {};
  let _writeTimer  = null;
  let _changeListeners = [];

  /* ══════════════════════════════════════════════════════════
     INDICATOR
  ══════════════════════════════════════════════════════════ */

  function _createIndicator() {
    if (document.getElementById(INDICATOR_ID)) return;
    const el = document.createElement('div');
    el.id = INDICATOR_ID;
    el.title = APP_BRAND.name + ' storage: unlinked';
    el.style.cssText = `
      position: fixed; top: 14px; right: 14px;
      width: 10px; height: 10px; border-radius: 50%;
      background: #9e9891; z-index: 99999; transition: background 0.3s;
      box-shadow: 0 0 0 2px rgba(158,152,145,0.25); cursor: pointer;
    `;
    document.body.appendChild(el);
    el.addEventListener('click', () => _signIn());
  }

  function _setIndicator(state) {
    const el = document.getElementById(INDICATOR_ID);
    if (!el) return;
    const states = {
      saving:   { bg: '#1d4fd6', sh: 'rgba(29,79,214,0.25)',  title: APP_BRAND.name + ': saving…' },
      saved:    { bg: '#3a8c5c', sh: 'rgba(58,140,92,0.25)',   title: APP_BRAND.name + ': saved ✓' },
      error:    { bg: '#c0392b', sh: 'rgba(192,57,43,0.25)',   title: APP_BRAND.name + ': error — click to re-link' },
      unlinked: { bg: '#9e9891', sh: 'rgba(158,152,145,0.25)', title: APP_BRAND.name + ': click to sign in' },
      loading:  { bg: '#6b9fd4', sh: 'rgba(107,159,212,0.25)', title: APP_BRAND.name + ': connecting…' },
    };
    const s = states[state] || states.unlinked;
    el.style.background = s.bg;
    el.style.boxShadow  = `0 0 0 2px ${s.sh}`;
    el.title = s.title;
  }

  /* ══════════════════════════════════════════════════════════
     BANNER
  ══════════════════════════════════════════════════════════ */

  function _showBanner(msg, btnLabel, onClick) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #18181d; color: #ededf0; padding: 14px 20px;
        border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 13px;
        display: flex; align-items: center; gap: 14px; z-index: 99999;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1);
        max-width: 500px; width: calc(100vw - 40px);
      `;
      document.body.appendChild(banner);
    }
    banner.innerHTML = `
      <span style="font-size:20px;">☁️</span>
      <span style="flex:1;line-height:1.5;">${msg}</span>
      <button id="ot-pick-btn" style="
        background:#3a8c5c;color:#fff;border:none;padding:9px 16px;
        border-radius:8px;font-size:13px;font-family:'DM Sans',sans-serif;
        font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;
      ">${btnLabel}</button>
    `;
    document.getElementById('ot-pick-btn').addEventListener('click', onClick);
  }

  function _hideBanner() {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
  }

  function _signInBannerMsg() {
    return [
      '<strong style="color:#5b7fff;">Sign in to sync</strong><br><span style="color:#a3a1a8;font-size:12px;">Connect your Google account to load and save your checklists.</span>',
      'Sign in',
      _signIn,
    ];
  }

  /* ══════════════════════════════════════════════════════════
     REDIRECT-BASED SIGN-IN
  ══════════════════════════════════════════════════════════ */

  function _signIn() {
    sessionStorage.setItem('OT_RETURN_PATH', window.location.href);
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      prompt: 'consent',
    });
    window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  }

  function _checkForExistingToken() {
    const token   = sessionStorage.getItem('OT_ACCESS_TOKEN');
    const expires = sessionStorage.getItem('OT_TOKEN_EXPIRES');
    const oauthErr = sessionStorage.getItem('OT_OAUTH_ERROR');

    if (oauthErr) {
      sessionStorage.removeItem('OT_OAUTH_ERROR');
      console.error('[' + APP_BRAND.name + ' storage] OAuth error:', oauthErr);
      _setIndicator('error');
      _showBanner(
        `<strong style="color:#c0392b;">Sign-in failed</strong><br><span style="color:#a3a1a8;font-size:12px;">${oauthErr}. Try again.</span>`,
        'Sign in', _signIn
      );
      return false;
    }

    if (token && expires && Date.now() < parseInt(expires, 10)) {
      _accessToken = token;
      return true;
    }
    return false;
  }

  /* ══════════════════════════════════════════════════════════
     DRIVE REST CALLS
  ══════════════════════════════════════════════════════════ */

  async function _driveFetch(url, opts = {}) {
    opts.headers = Object.assign({}, opts.headers, {
      Authorization: 'Bearer ' + _accessToken,
    });
    const res = await fetch(url, opts);
    if (res.status === 401) {
      _accessToken = null;
      sessionStorage.removeItem('OT_ACCESS_TOKEN');
      sessionStorage.removeItem('OT_TOKEN_EXPIRES');
      _hideBanner();
      _setIndicator('unlinked');
      _showBanner(
        '<strong style="color:#5b7fff;">Session expired</strong><br><span style="color:#a3a1a8;font-size:12px;">Sign in again to keep syncing.</span>',
        'Sign in', _signIn
      );
      throw new Error('401 Unauthorized — token expired');
    }
    return res;
  }

  async function _findOrCreateFile() {
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const searchRes = await _driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`
    );
    const searchData = await searchRes.json();

    if (searchData.files && searchData.files.length > 0) {
      return searchData.files[0].id;
    }

    const createRes = await _driveFetch(
      'https://www.googleapis.com/drive/v3/files',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' }),
      }
    );
    const created = await createRes.json();
    return created.id;
  }

  async function _loadFromFile() {
    const res = await _driveFetch(
      `https://www.googleapis.com/drive/v3/files/${_fileId}?alt=media`
    );
    const text = await res.text();
    let fileData;
    try {
      fileData = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      console.warn('[' + APP_BRAND.name + ' storage] Could not parse Drive file, starting fresh:', err);
      fileData = {};
    }
    // Merge rather than overwrite: any keys set locally (e.g. a theme
    // toggle clicked before this load finished) win over the file's
    // stale copy of those same keys, instead of being silently discarded.
    // Drive remains the source of truth for everything not just changed
    // in this tab.
    _cache = { ...fileData, ..._pendingLocal };
    _pendingLocal = {};
  }

  async function _writeToFile() {
    if (!_fileId || !_accessToken) return;
    try {
      _setIndicator('saving');
      await _driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(_cache, null, 2),
        }
      );
      _setIndicator('saved');
    } catch (err) {
      console.error('[' + APP_BRAND.name + ' storage] Write error:', err);
      _setIndicator('error');
    }
  }

  function _scheduleSave() {
    if (_writeTimer) clearTimeout(_writeTimer);
    _writeTimer = setTimeout(() => {
      _writeToFile();
      _writeTimer = null;
    }, 300);
  }

  async function _connectToFile() {
    try {
      _setIndicator('loading');
      _fileId = await _findOrCreateFile();
      await _loadFromFile();
      _hideBanner();
      _setIndicator('saved');
      _applyTheme(_cache || {});
      _markReady();
    } catch (err) {
      console.error('[' + APP_BRAND.name + ' storage] Connect error:', err);
      _setIndicator('error');
    }
  }

  /* ══════════════════════════════════════════════════════════
     READY SYSTEM
  ══════════════════════════════════════════════════════════ */

  function _markReady() {
    _ready = true;
    _readyQueue.forEach(fn => fn());
    _readyQueue = [];
  }

  function _fireChange(key, value) {
    _changeListeners.forEach(fn => {
      try { fn(key, value); } catch (e) { console.error('[' + APP_BRAND.name + ' storage] onChange listener error:', e); }
    });
  }

  /* ══════════════════════════════════════════════════════════
     SHARED STYLES (grip-dot drag handle, nav link layout)
     Injected once so every page looks identical — no more
     copy-pasted CSS per file.
  ══════════════════════════════════════════════════════════ */

  function _injectSharedStyles() {
    if (document.getElementById('ot-shared-styles')) return;
    const style = document.createElement('style');
    style.id = 'ot-shared-styles';
    style.textContent = `
      .ot-drag-handle {
        display:inline-block; width:16px; text-align:center;
        color:var(--text3); cursor:grab; font-size:14px;
        padding:0 2px; flex-shrink:0; user-select:none;
        opacity:0.6; transition:opacity .15s; vertical-align:middle;
      }
      .ot-nav-link:hover .ot-drag-handle { opacity:1; color:var(--text2); }
      .ot-nav-link.ot-dragging { opacity:0.4; }
      .ot-nav-link.ot-drag-over { box-shadow: inset 0 2px 0 var(--accent); }
      .ot-nav-link:active .ot-drag-handle { cursor:grabbing; }
      .ot-nav-link.ot-pinned .ot-drag-handle { visibility:hidden; }
    `;
    document.head.appendChild(style);
  }

  /* Same plain character + same look as the existing Days/slot drag handle
     elsewhere in the app — kept visually identical on purpose. */
  const _GRIP_CHAR = '⠿';

  /* ══════════════════════════════════════════════════════════
     NAV MODULE — builds the sidebar links + drag-to-reorder
     into <div id="onetrack-nav-links"> on every page.
  ══════════════════════════════════════════════════════════ */

  const NAV_ORDER_KEY = 'ONETRACK_NAV_ORDER';
  let _navDragId = null;

  function _loadNavOrder() {
    const ids = NAV_PAGES.map(p => p.id);
    try {
      const saved = JSON.parse(localStorage.getItem(NAV_ORDER_KEY));
      if (Array.isArray(saved) && saved.length === ids.length && ids.every(id => saved.includes(id))) {
        return saved;
      }
    } catch (e) {}
    return ids;
  }

  let _navOrder = _loadNavOrder();

  function _saveNavOrder(order) {
    try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order)); } catch (e) {}
  }

  function _currentFile() {
    try { return decodeURIComponent(location.pathname.split('/').pop() || ''); }
    catch (e) { return ''; }
  }

  function _makeNavLink(page, draggable) {
    const current = _currentFile();
    const a = document.createElement('a');
    a.href = page.file;
    a.className = 'ot-nav-link' + (page.file === current ? ' active' : '') + (draggable ? '' : ' ot-pinned');

    const handle = document.createElement('span');
    handle.className = 'ot-drag-handle';
    handle.textContent = _GRIP_CHAR;
    if (draggable) {
      handle.title = 'Drag to reorder';
      a.draggable = true;
      a.dataset.navId = page.id;
    }
    a.appendChild(handle);

    const label = document.createElement('span');
    label.className = 'ot-nav-label';
    label.textContent = page.label;
    a.appendChild(label);

    return a;
  }

  function _wireNavDrag(container) {
    const links = Array.prototype.slice.call(container.querySelectorAll('a.ot-nav-link[draggable="true"]'));
    links.forEach(a => {
      a.addEventListener('dragstart', e => {
        _navDragId = a.dataset.navId;
        a.classList.add('ot-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', a.dataset.navId);
      });
      a.addEventListener('dragend', () => {
        a.classList.remove('ot-dragging');
        links.forEach(l => l.classList.remove('ot-drag-over'));
        _navDragId = null;
      });
      a.addEventListener('dragover', e => {
        if (!_navDragId || _navDragId === a.dataset.navId) return;
        e.preventDefault();
        links.forEach(l => l.classList.remove('ot-drag-over'));
        a.classList.add('ot-drag-over');
      });
      a.addEventListener('dragleave', () => a.classList.remove('ot-drag-over'));
      a.addEventListener('drop', e => {
        if (!_navDragId || _navDragId === a.dataset.navId) return;
        e.preventDefault();
        const fi = _navOrder.indexOf(_navDragId);
        const ti = _navOrder.indexOf(a.dataset.navId);
        if (fi < 0 || ti < 0) return;
        _navOrder.splice(fi, 1);
        _navOrder.splice(ti, 0, _navDragId);
        _saveNavOrder(_navOrder);
        _navDragId = null;
        _buildNav();
      });
      // Prevent a drag-and-drop from also firing a navigation click
      a.addEventListener('click', e => {
        if (a.classList.contains('ot-dragging')) e.preventDefault();
      });
    });
  }

  function _buildNav() {
    const container = document.getElementById('onetrack-nav-links');
    if (!container) return;
    container.innerHTML = '';
    const byId = {};
    NAV_PAGES.forEach(p => { byId[p.id] = p; });

    _navOrder.forEach(id => {
      const page = byId[id];
      if (page) container.appendChild(_makeNavLink(page, true));
    });
    // Settings always pinned last, never draggable
    container.appendChild(_makeNavLink(NAV_SETTINGS, false));

    _wireNavDrag(container);
  }

  /* ══════════════════════════════════════════════════════════
     THEME MODULE — dark mode, accent colour, font scale,
     applied centrally instead of once per page.
  ══════════════════════════════════════════════════════════ */

  const THEME_SNAPSHOT_KEY = 'ONETRACK_THEME_SNAPSHOT';
  const THEME_KEYS = [
    'TODAY_DARK', 'ONETRACK_ACCENT', 'ONETRACK_ACCENT_DARK',
    'ONETRACK_ACCENT_SOFT', 'ONETRACK_ACCENT_DARK_SOFT', 'ONETRACK_FONT_SCALE',
  ];
  // Extra per-section CSS variables some pages use (e.g. Checklists.html).
  // Safe to set everywhere — pages that don't reference them just ignore them.
  const EXTRA_ACCENT_VARS = ['--ft-accent', '--pt-accent', '--roh-accent', '--esh-accent', '--kal-accent', '--trv-accent', '--rtn-accent'];
  const EXTRA_SOFT_VARS   = ['--ft-soft', '--pt-soft', '--roh-soft', '--esh-soft', '--trv-soft', '--rtn-soft'];

  function _cssVars(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}:${v};`).join('');
  }
  function _injectBaseTheme() {
    if (document.getElementById('ot-base-theme')) return;
    const style = document.createElement('style');
    style.id = 'ot-base-theme';
    style.textContent =
      `:root{${_cssVars(BASE_THEME.light)}}` +
      `[data-theme="dark"]{${_cssVars(BASE_THEME.dark)}}`;
    // Inserted FIRST in <head>, before the page's own <style> block,
    // so any leftover page-level copy of these same vars wins on
    // source order if one still exists — this is the floor, not an
    // override of anything more specific a page wants to layer on top.
    document.head.insertBefore(style, document.head.firstChild);
  }
  // Runs instantly — document.head already exists by the time this
  // script tag executes, well before DOMContentLoaded — so the base
  // palette is in place before the page's own CSS even paints.
  _injectBaseTheme();

  function _hexToSoft(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function _applyTheme(cache) {
    cache = cache || {};
    const html = document.documentElement;

    const darkSaved = cache['TODAY_DARK'];
    const dark = (darkSaved !== undefined && darkSaved !== null)
      ? darkSaved === '1'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    html.dataset.theme = dark ? 'dark' : '';

    const lightHex = cache['ONETRACK_ACCENT'] || '#1d4fd6';
    const darkHex  = cache['ONETRACK_ACCENT_DARK'] || '#5b7fff';
    const hex  = dark ? darkHex : lightHex;
    const soft = _hexToSoft(hex, dark ? 0.14 : 0.12);
    html.style.setProperty('--accent', hex);
    html.style.setProperty('--accent-soft', soft);
    EXTRA_ACCENT_VARS.forEach(v => html.style.setProperty(v, hex));
    EXTRA_SOFT_VARS.forEach(v => html.style.setProperty(v, soft));

    const fs = parseFloat(cache['ONETRACK_FONT_SCALE'] || '1');
    // NOTE: every page's CSS uses px, not rem, so changing the root
    // font-size has nothing to scale. `zoom` scales the whole page
    // (px included) proportionally, leaving the design untouched at
    // the default value of 1.
    html.style.zoom = fs;

    try {
      localStorage.setItem(THEME_SNAPSHOT_KEY, JSON.stringify({
        dark: dark ? '1' : '0', accent: lightHex, accentDark: darkHex, fontScale: fs,
      }));
    } catch (e) {}
  }

  function _applyThemeFromSnapshot() {
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem(THEME_SNAPSHOT_KEY)); } catch (e) {}
    if (snap) {
      _applyTheme({
        TODAY_DARK: snap.dark,
        ONETRACK_ACCENT: snap.accent,
        ONETRACK_ACCENT_DARK: snap.accentDark,
        ONETRACK_FONT_SCALE: snap.fontScale,
      });
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      // No snapshot yet (first ever visit) — at least avoid a light flash
      // if the system itself is in dark mode.
      document.documentElement.dataset.theme = 'dark';
    }
  }

  // Run instantly, before DOMContentLoaded — this is what prevents the
  // "flash of wrong theme" each page used to prevent on its own.
  _applyThemeFromSnapshot();

  /* ══════════════════════════════════════════════════════════
     BRAND FOOTER — single muted line per page:
       "{tagline} · v{version} · Last updated DD-MMM-YY HH:MM"
     Date/time is the page's own "code last touched" stamp,
     passed in by that page — NOT live page-load time.
  ══════════════════════════════════════════════════════════ */

  function _injectBrandFooterStyles() {
    if (document.getElementById('ot-brand-footer-styles')) return;
    const style = document.createElement('style');
    style.id = 'ot-brand-footer-styles';
    style.textContent = `
      .ot-brand-footer {
        font-family:'DM Sans',sans-serif; font-size:11px; font-style:italic;
        color:var(--text3,#8a8478); white-space:nowrap;
      }
      @media (max-width:900px) { .ot-brand-footer { display:none; } }
    `;
    document.head.appendChild(style);
  }

  const _MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const BRAND_TIME_ZONE = 'Australia/Sydney';

  /* Formats a Date as DD-MMM-YY HH:MM (24-hour), ALWAYS in Sydney/AEST
     time — regardless of the viewing device's own time zone. Uses
     Intl so it correctly accounts for AEST/AEDT daylight saving. */
  function _formatBrandDate(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: BRAND_TIME_ZONE,
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = type => (parts.find(p => p.type === type) || {}).value || '';
    let hh = get('hour');
    if (hh === '24') hh = '00'; // Intl quirk: hour12:false can yield "24" for midnight
    const monthNum = parseInt(get('month'), 10);
    const mmm = _MONTH_ABBR[monthNum - 1] || get('month');
    return `${get('day')}-${mmm}-${get('year')} ${hh}:${get('minute')}`;
  }

  /**
   * OT.renderBrandFooter(containerId, version, lastUpdated)
   * version:     string, e.g. 'v1.0' — set by you when you finish
   *              editing that page's code.
   * lastUpdated: a Date — the moment you last changed that page's
   *              code, NOT when the page happens to be viewed.
   */
  function _renderBrandFooter(containerId, version, lastUpdated) {
    const el = document.getElementById(containerId);
    if (!el) return;
    _injectBrandFooterStyles();
    el.classList.add('ot-brand-footer');
    // Centralized last-updated stamp: use THIS page's own file modification
    // time (document.lastModified). On GitHub Pages that's when you last
    // deployed this HTML file, so each page stamps its own real update time
    // with no per-page code. Falls back to the date the page passed in only
    // if document.lastModified is unavailable (some servers return epoch 0).
    let _when = new Date(document.lastModified);
    if (isNaN(_when.getTime()) || _when.getTime() === 0) _when = lastUpdated || null;
    const stamp = _formatBrandDate(_when);
    const parts = [APP_BRAND.tagline, version, stamp ? ('Last updated ' + stamp) : null]
      .filter(Boolean);
    el.textContent = parts.join(' · ');
  }

  /* ══════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════ */

  function _init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _init);
      return;
    }
    _injectSharedStyles();
    _buildNav();
    _createIndicator();

    if (_checkForExistingToken()) {
      _connectToFile();
    } else {
      _setIndicator('unlinked');
      _showBanner(..._signInBannerMsg());
    }
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════ */

  const OT = {

    brand: APP_BRAND,

    renderBrandFooter: _renderBrandFooter,

    // Canonical theme engine, exposed so Settings.html (or any page)
    // calls these instead of keeping its own private copy of the logic.
    isDark() {
      const v = _cache ? _cache['TODAY_DARK'] : null;
      return (v !== undefined && v !== null) ? v === '1' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    },
    applyTheme() { _applyTheme(_cache || {}); },
    // Real page list, single source of truth (also drives the sidebar nav).
    navPages: NAV_PAGES.map(p => ({ ...p })),

    isReady()   { return _ready; },

    onReady(fn) {
      if (_ready) fn();
      else _readyQueue.push(fn);
    },

    onChange(fn) {
      _changeListeners.push(fn);
    },

    async get(key) {
      if (!_ready || !_cache) return null;
      const val = _cache[key];
      return (val === undefined || val === null) ? null : String(val);
    },

    async set(key, value) {
      if (!_cache) _cache = {};
      _cache[key] = value;
      _pendingLocal[key] = value;
      _scheduleSave();
      if (THEME_KEYS.indexOf(key) !== -1) _applyTheme(_cache);
      _fireChange(key, value);
    },

    async remove(key) {
      if (!_cache) return;
      delete _cache[key];
      _pendingLocal[key] = undefined; // tombstone: still wins over stale file value
      _scheduleSave();
      if (THEME_KEYS.indexOf(key) !== -1) _applyTheme(_cache);
      _fireChange(key, null);
    },

    async keys() {
      return _cache ? Object.keys(_cache) : [];
    },

    async getAll() {
      return _cache ? { ..._cache } : {};
    },

    async setAll(obj) {
      _cache = { ...obj };
      await _writeToFile();
      _applyTheme(_cache);
    },

    async clear() {
      _cache = {};
      await _writeToFile();
      _applyTheme(_cache);
    },

    pickFile: _signIn,
    signIn: _signIn,

    async reload() {
      if (_fileId) await _loadFromFile();
    },

    async forget() {
      _accessToken = null;
      _fileId      = null;
      _cache       = null;
      _ready       = false;
      sessionStorage.removeItem('OT_ACCESS_TOKEN');
      sessionStorage.removeItem('OT_TOKEN_EXPIRES');
      _setIndicator('unlinked');
      _showBanner(..._signInBannerMsg());
    },
  };

  global.OT = OT;
  _init();

})(window);
