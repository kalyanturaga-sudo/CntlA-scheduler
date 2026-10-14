/* ============================================================
   storage.js  —  Ctrl+A Shared Storage Engine  v6.0
   ------------------------------------------------------------
   v6.0 changes:
     - NEWER EDIT WINS, PER KEY. Every key carries a timestamp in
       ONETRACK_KEY_TIMES (stored inside the data file, so it syncs).
       Deletes are timestamped too, so a removal on one device beats
       an older value on another.
     - NO GOOGLE LOGIN ON NORMAL PAGE LOADS. Pages open straight from
       the local mirror. Drive is only contacted by Sync now or Live.
     - SYNC NOW: popup sign-in if needed, back up this device, merge
       by timestamp, upload.
     - LIVE: every 5 s checks Drive's modified time, downloads only
       when it changed, and pushes local edits ~5 s after each change.
     - 30 min IDLE + EXPIRED TOKEN: no background renewal while idle.
       The next click shows "Refresh / Sign in".
     - LAST 5 BACKUPS kept on this device. Undo restores the newest.
     - STATUS DOT (bottom-right): green pulse = Live, blue = Synced
       (hover shows time), amber = paused, grey = offline / unlinked,
       red = last sync failed.

   Unchanged from v5.x: nav (NAV_PAGES + drag order), theme engine
   (dark / accent / font scale), global footer, brand loop.

   PUBLIC API
     Data:    get, set, remove, keys, getAll, setAll, clear
     Ready:   onReady, isReady, onSync, isAuthoritative, onChange
     Sync:    sync(), setLive(on), isLive(), undoLastSync(),
              getBackups(), getStatus(), onStatus(fn), lastSyncAt()
     Auth:    signIn(), forget()
     Theme:   isDark(), applyTheme(), setTitle()
     Nav:     navPages, getNavLabel(id), setNavLabel(id, label)
     Brand:   brand, renderBrandFooter() (no-op, kept for old pages)

   BEFORE THIS VERSION GOES LIVE
     Google Cloud Console → OAuth client → Authorized JavaScript
     origins must include https://kalyanturaga-sudo.github.io
     (sign-in now uses the Google popup, not a full-page redirect).
   ============================================================ */

  /* ── CONFIG ── */
  const GOOGLE_CLIENT_ID = '356548061716-4fjrgh28vetubhuu2cf4ano859tnftuv.apps.googleusercontent.com';
  const DRIVE_FILE_NAME  = 'onetrack-data.json';

  /* ── BRAND CONFIG — change product name/tagline ONLY here.
     Internal storage keys / file names are untouched on purpose. ── */
  const APP_BRAND = {
    name:    'Ctrl+A',
    tagline: 'Capture all. Control all.',
  };
  /* Version shown in the global footer. Bump here only. */
  const APP_VERSION = 'v1.0';

  /* ── NAV CONFIG — edit this list to add/rename/remove a page ── */
  const NAV_PAGES = [
    { id: 'ttb',        file: 'TT&B.html',            label: 'TT&B' },
    { id: 'routines',   file: 'Routines.html',        label: 'Routines & Chores' },
    { id: 'jobs',       file: 'Jobs.html',            label: 'Jobs' },
    { id: 'checklists', file: 'Checklists.html',      label: 'Checklists' },
    { id: 'trip',       file: 'Trip Planners.html',   label: 'Trip Planners' },
    { id: 'meal',       file: 'Meal Planner.html',    label: 'Meal Planner' },
    { id: 'workout',    file: 'Workout Planner.html', label: 'Workout Planner' },
    { id: 'marathon',   file: 'Marathon Training.html', label: 'Marathon Training' },
    { id: 'libraries',  file: 'Libraries.html',       label: 'Libraries' },
  ];
  /* Settings is intentionally NOT in NAV_PAGES — pinned at the bottom. */
  const NAV_SETTINGS = { id: 'settings', file: 'Settings.html', label: 'Settings' };

  /* ── BASE PALETTE — shared bg/surface/text scale. Change colours here. ── */
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

  /* drive.file = this app only sees files it created or the user opened
     with it. Non-sensitive scope, so no app verification is needed. */
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';

  /* ── Storage keys (internal names kept on purpose — see header) ── */
  const KT           = 'ONETRACK_KEY_TIMES';    // per-key timestamps, lives inside the data
  const MIRROR_KEY   = 'ONETRACK_LOCAL_MIRROR'; // this device's copy of the data
  const BACKUPS_KEY  = 'ONETRACK_BACKUPS';      // this device only, newest first
  const LIVE_KEY     = 'ONETRACK_LIVE';         // device pref: '1' | '0'
  const LAST_SYNC_KEY = 'ONETRACK_LAST_SYNC';
  const SIGNED_IN_KEY = 'ONETRACK_SIGNED_IN';   // '1' once a token has ever been granted
  const CONSENT_KEY  = 'ONETRACK_CONSENTED';    // '1' once Google consent was granted
  const TOKEN_KEY    = 'OT_ACCESS_TOKEN';
  const EXP_KEY      = 'OT_TOKEN_EXPIRES';
  const THEME_SNAPSHOT_KEY = 'ONETRACK_THEME_SNAPSHOT';
  const NAV_ORDER_KEY = 'ONETRACK_NAV_ORDER';
  const NAV_LABEL_PREFIX = 'ONETRACK_NAV_LABEL_';

  const LIVE_MS      = 5000;     // Live: check Drive every 5 s
  const PUSH_MS      = 5000;     // Live: push local edits ~5 s after a change
  const IDLE_MS      = 30 * 60 * 1000;
  const WATCH_MS     = 60 * 1000;
  const MAX_BACKUPS  = 5;

  const THEME_KEYS = [
    'TODAY_DARK', 'ONETRACK_ACCENT', 'ONETRACK_ACCENT_DARK',
    'ONETRACK_ACCENT_SOFT', 'ONETRACK_ACCENT_DARK_SOFT', 'ONETRACK_FONT_SCALE',
  ];
  const EXTRA_ACCENT_VARS = ['--ft-accent', '--pt-accent', '--roh-accent', '--esh-accent', '--kal-accent', '--trv-accent', '--rtn-accent'];
  const EXTRA_SOFT_VARS   = ['--ft-soft', '--pt-soft', '--roh-soft', '--esh-soft', '--trv-soft', '--rtn-soft'];

  /* ── Internal state ── */
  let _cache = null;            // the data object (includes KT)
  let _ready = false;
  let _readyQueue = [];
  let _authoritative = false;
  let _changeListeners = [];
  let _syncListeners = [];
  let _statusListeners = [];

  let _token = null;            // Google access token (in memory + localStorage)
  let _tokenExp = 0;
  let _tokenClient = null;
  let _renewInFlight = null;

  let _fileId = null;
  let _remoteMod = null;        // Drive modifiedTime we last saw/wrote
  let _dirty = false;           // local edits not yet on Drive
  let _pushTimer = null;
  let _liveTimer = null;
  let _busy = false;            // a Drive round-trip is in flight
  let _syncing = false;         // a manual Sync now is running
  let _live = false;
  let _lastSyncAt = 0;
  let _lastActivity = Date.now();
  let _lastError = null;

  /* ══════════════════════════════════════════════════════════
     SMALL HELPERS
  ══════════════════════════════════════════════════════════ */

  function _lsGet(k)    { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function _lsDel(k)    { try { localStorage.removeItem(k); } catch (e) {} }
  function _log(...a)   { console.log('[' + APP_BRAND.name + ' storage]', ...a); }
  function _warn(...a)  { console.warn('[' + APP_BRAND.name + ' storage]', ...a); }
  function _has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  function _readMirror() {
    try { return JSON.parse(_lsGet(MIRROR_KEY)) || {}; } catch (e) { return {}; }
  }
  function _writeMirror() {
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(_cache || {})); } catch (e) {}
  }
  function _getBackups() {
    try { return JSON.parse(_lsGet(BACKUPS_KEY)) || []; } catch (e) { return []; }
  }

  /* ══════════════════════════════════════════════════════════
     TOKEN
  ══════════════════════════════════════════════════════════ */

  function _loadToken() {
    const t = _lsGet(TOKEN_KEY);
    const e = parseInt(_lsGet(EXP_KEY) || '0', 10);
    if (t && e && Date.now() < e) { _token = t; _tokenExp = e; }
  }
  function _tokenValid() { return !!_token && Date.now() < _tokenExp; }

  function _storeToken(tok, expiresIn) {
    _token = tok;
    // Shave 60 s so we never hand Drive a token that dies mid-request.
    _tokenExp = Date.now() + ((parseInt(expiresIn, 10) || 3600) - 60) * 1000;
    _lsSet(TOKEN_KEY, tok);
    _lsSet(EXP_KEY, String(_tokenExp));
    _lsSet(SIGNED_IN_KEY, '1');
    _lsSet(CONSENT_KEY, '1');
  }
  function _dropToken() {
    _token = null;
    _tokenExp = 0;
    _lsDel(TOKEN_KEY);
    _lsDel(EXP_KEY);
    _setStatus();
  }

  /* Loads Google Identity Services on demand; no <script> needed in any page. */
  function _loadGIS() {
    return new Promise((resolve) => {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve(true);
      const existing = document.getElementById('ot-gis-script');
      if (existing) {
        existing.addEventListener('load', () => resolve(true));
        existing.addEventListener('error', () => resolve(false));
        return;
      }
      const sc = document.createElement('script');
      sc.id = 'ot-gis-script';
      sc.src = 'https://accounts.google.com/gsi/client';
      sc.async = true;
      sc.onload  = () => resolve(true);
      sc.onerror = () => resolve(false);
      document.head.appendChild(sc);
    });
  }

  /* prompt '' = silent (no UI if Google session + consent exist).
     prompt 'consent' / 'select_account' = may open the Google popup.
     Resolves true with a fresh token, false otherwise. Never throws. */
  async function _requestToken(prompt) {
    const ok = await _loadGIS();
    if (!ok) return false;
    try {
      if (!_tokenClient) {
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPE,
          prompt: '',
          callback: () => {},
          error_callback: () => {},
        });
      }
    } catch (e) { _warn('GIS init failed:', e); return false; }

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), prompt ? 120000 : 8000);
      _tokenClient.callback = (resp) => {
        clearTimeout(timer);
        if (resp && resp.access_token) {
          _storeToken(resp.access_token, resp.expires_in);
          _setStatus();
          resolve(true);
        } else {
          resolve(false);
        }
      };
      _tokenClient.error_callback = () => { clearTimeout(timer); resolve(false); };
      try { _tokenClient.requestAccessToken({ prompt: prompt }); }
      catch (e) { clearTimeout(timer); resolve(false); }
    });
  }

  function _renewSilently() {
    if (_renewInFlight) return _renewInFlight;
    _renewInFlight = _requestToken('').finally(() => { _renewInFlight = null; });
    return _renewInFlight;
  }

  /* Used by Sync now / Live / the dot: silent first, then the popup. */
  async function _interactiveSignIn() {
    if (_tokenValid()) return true;
    const first = await _requestToken(_lsGet(CONSENT_KEY) ? '' : 'consent');
    if (first) return true;
    return _requestToken('select_account');
  }

  /* ══════════════════════════════════════════════════════════
     DRIVE REST
  ══════════════════════════════════════════════════════════ */

  async function _api(url, opts, retried) {
    opts = opts || {};
    if (!_token) throw new Error('not signed in');
    const res = await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({}, opts.headers, { Authorization: 'Bearer ' + _token }),
    }));
    if (res.status === 401 && !retried) {
      if (await _renewSilently()) return _api(url, opts, true);
      _dropToken();
      throw new Error('session expired');
    }
    if (!res.ok) throw new Error('Drive HTTP ' + res.status);
    return res;
  }

  async function _ensureFileId() {
    if (_fileId) return _fileId;
    const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
    const s = await (await _api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`)).json();
    if (s.files && s.files.length) { _fileId = s.files[0].id; return _fileId; }
    const c = await (await _api('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' }),
    })).json();
    _fileId = c.id;
    return _fileId;
  }

  async function _fetchRemoteMeta() {
    return (await (await _api(`https://www.googleapis.com/drive/v3/files/${_fileId}?fields=modifiedTime`)).json());
  }

  async function _fetchRemote() {
    const meta = await _fetchRemoteMeta();
    const text = await (await _api(`https://www.googleapis.com/drive/v3/files/${_fileId}?alt=media`)).text();
    let data = {};
    try { data = text.trim() ? JSON.parse(text) : {}; }
    catch (e) { _warn('Drive file unreadable, treating as empty:', e); }
    return { data: data, modifiedTime: meta.modifiedTime || null };
  }

  async function _pushCache() {
    const res = await _api(
      `https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media&fields=modifiedTime`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_cache, null, 2),
      }
    );
    let j = {};
    try { j = await res.json(); } catch (e) {}
    _remoteMod = j.modifiedTime || null;
    _dirty = false;
  }

  /* ══════════════════════════════════════════════════════════
     MERGE — newer edit wins, per key
     A key with no timestamp counts as 1 when present (so local data
     from before v6 is not silently dropped) and 0 when absent.
     Ties go to Drive. A deletion is a key whose timestamp is newer
     than the other side's value and which is absent from that side.
  ══════════════════════════════════════════════════════════ */

  function _merge(local, remote) {
    const lt = local[KT] || {};
    const rt = remote[KT] || {};
    const keys = new Set([
      ...Object.keys(local), ...Object.keys(remote),
      ...Object.keys(lt), ...Object.keys(rt),
    ]);
    keys.delete(KT);

    const out = {};
    const times = {};
    keys.forEach((k) => {
      const l = (lt[k] != null) ? lt[k] : (_has(local, k) ? 1 : 0);
      const r = (rt[k] != null) ? rt[k] : (_has(remote, k) ? 1 : 0);
      const src = (r >= l) ? remote : local;
      if (_has(src, k)) out[k] = src[k];
      const t = Math.max(l, r);
      if (t) times[k] = t;
    });
    out[KT] = times;
    return out;
  }

  /* Pull from Drive, merge into this device, push the result back. */
  async function _mergeWithDrive() {
    await _ensureFileId();
    const remote = await _fetchRemote();
    _cache = _merge(_cache || {}, remote.data);
    _remoteMod = remote.modifiedTime;
    await _pushCache();
    _writeMirror();
    _applyTheme(_cache);
    _fireSync();
    _setStatus();
  }

  /* ══════════════════════════════════════════════════════════
     BACKUPS — this device only, last MAX_BACKUPS kept
  ══════════════════════════════════════════════════════════ */

  function _backupNow() {
    if (!_cache) return;
    const list = _getBackups();
    list.unshift({ at: Date.now(), data: _cache });
    _lsSet(BACKUPS_KEY, JSON.stringify(list.slice(0, MAX_BACKUPS)));
  }

  /* Restores the newest backup on this device and overwrites Drive
     with it. Every restored key gets a fresh timestamp, so the restored
     copy wins on other devices too. */
  async function undoLastSync() {
    const list = _getBackups();
    if (!list.length) return false;
    const newest = list[0];
    const rest = list.slice(1);
    const now = Date.now();
    const times = {};
    Object.keys(newest.data).forEach((k) => { if (k !== KT) times[k] = now; });
    _cache = Object.assign({}, newest.data, { [KT]: times });
    _lsSet(BACKUPS_KEY, JSON.stringify(rest));
    _writeMirror();
    _applyTheme(_cache);
    _fireSync();
    if (_tokenValid()) {
      try { await _ensureFileId(); await _pushCache(); }
      catch (e) { _warn('Undo could not reach Drive:', e); _lastError = e.message; }
    } else {
      _dirty = true;
    }
    _setStatus();
    return true;
  }

  /* ══════════════════════════════════════════════════════════
     SYNC NOW
  ══════════════════════════════════════════════════════════ */

  async function syncNow() {
    if (_syncing) return false;
    if (!_tokenValid()) {
      const ok = await _interactiveSignIn();
      if (!ok) { _lastError = 'Sign-in needed'; _setStatus(); return false; }
    }
    _syncing = true;
    _setStatus();
    try {
      _backupNow();
      await _mergeWithDrive();
      _lastSyncAt = Date.now();
      _lsSet(LAST_SYNC_KEY, String(_lastSyncAt));
      _lastError = null;
      return true;
    } catch (e) {
      _lastError = e.message || String(e);
      _warn('Sync failed:', e);
      return false;
    } finally {
      _syncing = false;
      _setStatus();
    }
  }

  /* ══════════════════════════════════════════════════════════
     LIVE — check every 5 s, push edits ~5 s after each change
  ══════════════════════════════════════════════════════════ */

  async function _liveTick() {
    if (!_live || _busy || _syncing) return;
    if (!_tokenValid()) { _setStatus(); return; }
    _busy = true;
    try {
      await _ensureFileId();
      const meta = await _fetchRemoteMeta();
      if (_dirty || (meta.modifiedTime && meta.modifiedTime !== _remoteMod)) {
        await _mergeWithDrive();
      }
    } catch (e) {
      _lastError = e.message || String(e);
    } finally {
      _busy = false;
      _setStatus();
    }
  }

  function _schedulePush() {
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => {
      _pushTimer = null;
      if (_live) _liveTick();
    }, PUSH_MS);
  }

  async function setLive(on) {
    _live = !!on;
    _lsSet(LIVE_KEY, _live ? '1' : '0');
    if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
    if (_live) {
      if (!_tokenValid()) await _interactiveSignIn();
      _liveTimer = setInterval(_liveTick, LIVE_MS);
      _liveTick();
    }
    _setStatus();
  }

  /* ══════════════════════════════════════════════════════════
     IDLE + WATCHDOG
     - Active tab, token within 5 min of expiry, user not idle:
       renew silently in the background.
     - Idle > 30 min and token expired: nothing happens until the
       next click, which shows the Refresh / Sign in prompt.
  ══════════════════════════════════════════════════════════ */

  function _startWatchdog() {
    setInterval(() => {
      if (!_token || !_tokenExp) return;
      const idle = Date.now() - _lastActivity > IDLE_MS;
      if (!idle && Date.now() > _tokenExp - 5 * 60 * 1000) {
        _renewSilently().then(() => _setStatus());
      }
    }, WATCH_MS);
  }

  function _trackActivity() {
    const onAct = () => {
      const idle = Date.now() - _lastActivity;
      _lastActivity = Date.now();
      if (_lsGet(SIGNED_IN_KEY) !== '1' || _tokenValid()) return;
      if (idle > IDLE_MS) {
        _showBanner(
          '<strong style="color:#5b7fff;">Session expired</strong><br><span style="color:#a3a1a8;font-size:12px;">Refresh to keep syncing.</span>',
          [
            ['Refresh', () => _renewSilently().then((ok) => ok || _requestToken('select_account'))],
            ['Sign in', () => _requestToken('select_account')],
          ]
        );
      } else {
        _renewSilently().then(() => _setStatus());
      }
    };
    document.addEventListener('pointerdown', onAct, true);
    document.addEventListener('keydown', onAct, true);
  }

  /* ══════════════════════════════════════════════════════════
     STATUS DOT (bottom-right) + STATUS API
  ══════════════════════════════════════════════════════════ */

  const DOT_ID = 'ot-status-dot';
  const DOT_STYLE = {
    live:     { color: '#3a8c5c', pulse: true,  label: 'Live — checking Drive every 5 s' },
    synced:   { color: '#1d4fd6', pulse: false, label: 'Synced' },
    syncing:  { color: '#1d4fd6', pulse: true,  label: 'Syncing…' },
    paused:   { color: '#e8a90c', pulse: false, label: 'Paused — click to refresh' },
    offline:  { color: '#9e9891', pulse: false, label: 'Offline' },
    unlinked: { color: '#9e9891', pulse: false, label: 'Not linked — click to sign in' },
    error:    { color: '#c0392b', pulse: false, label: 'Last sync failed' },
  };

  function _computeStatus() {
    const signedIn = _lsGet(SIGNED_IN_KEY) === '1' || !!_token;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    let state;
    if (_syncing) state = 'syncing';
    else if (!signedIn) state = offline ? 'offline' : 'unlinked';
    else if (offline) state = 'offline';
    else if (!_tokenValid()) state = 'paused';
    else if (_lastError) state = 'error';
    else if (_live) state = 'live';
    else state = 'synced';
    return {
      state: state,
      live: _live,
      signedIn: signedIn,
      dirty: _dirty,
      lastSyncAt: _lastSyncAt || null,
      backups: _getBackups().length,
      error: _lastError,
    };
  }

  function _injectDotStyles() {
    if (document.getElementById('ot-dot-styles')) return;
    const style = document.createElement('style');
    style.id = 'ot-dot-styles';
    style.textContent = `
      #${DOT_ID} {
        position: fixed; right: 14px; bottom: 12px;
        width: 12px; height: 12px; border-radius: 50%;
        z-index: 99999; cursor: pointer; background: #9e9891;
        transition: background 0.3s;
      }
      #${DOT_ID}.ot-pulse { animation: otPulse 1.8s ease-out infinite; }
      @keyframes otPulse {
        0%   { box-shadow: 0 0 0 0 currentColor; }
        70%  { box-shadow: 0 0 0 7px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      @media (prefers-reduced-motion: reduce) { #${DOT_ID}.ot-pulse { animation: none; } }
    `;
    document.head.appendChild(style);
  }

  function _createDot() {
    if (document.getElementById(DOT_ID)) return;
    _injectDotStyles();
    const el = document.createElement('div');
    el.id = DOT_ID;
    el.setAttribute('role', 'button');
    el.addEventListener('click', async () => {
      const st = _computeStatus();
      if (st.state === 'unlinked' || st.state === 'paused') {
        await _interactiveSignIn();
        _setStatus();
      } else if (st.state !== 'syncing') {
        syncNow();
      }
    });
    document.body.appendChild(el);
  }

  function _renderDot(st) {
    const el = document.getElementById(DOT_ID);
    if (!el) return;
    const s = DOT_STYLE[st.state] || DOT_STYLE.unlinked;
    el.style.background = s.color;
    el.style.color = s.color;
    el.classList.toggle('ot-pulse', s.pulse);
    let title = APP_BRAND.name + ': ' + s.label;
    if (st.state === 'synced' && st.lastSyncAt) {
      title += ' · ' + new Date(st.lastSyncAt).toLocaleString();
    }
    el.title = title;
  }

  function _setStatus() {
    const st = _computeStatus();
    _renderDot(st);
    _statusListeners.forEach((fn) => {
      try { fn(st); } catch (e) { _warn('onStatus listener error:', e); }
    });
  }

  /* ══════════════════════════════════════════════════════════
     BANNER (used only for the idle "Refresh / Sign in" prompt)
  ══════════════════════════════════════════════════════════ */

  const BANNER_ID = 'ot-storage-banner';

  function _hideBanner() {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
  }

  function _showBanner(html, buttons) {
    _hideBanner();
    const b = document.createElement('div');
    b.id = BANNER_ID;
    b.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #18181d; color: #ededf0; padding: 14px 20px;
      border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 13px;
      display: flex; align-items: center; gap: 12px; z-index: 99999;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1);
      max-width: 520px; width: calc(100vw - 40px);
    `;
    b.innerHTML = `<span style="font-size:20px;">☁️</span><span style="flex:1;line-height:1.5;">${html}</span>`;
    buttons.forEach(([label, fn]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = `
        background:#3a8c5c;color:#fff;border:none;padding:9px 14px;
        border-radius:8px;font-size:13px;font-family:'DM Sans',sans-serif;
        font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;
      `;
      btn.addEventListener('click', () => { _hideBanner(); fn(); });
      b.appendChild(btn);
    });
    document.body.appendChild(b);
  }

  /* ══════════════════════════════════════════════════════════
     THEME MODULE
  ══════════════════════════════════════════════════════════ */

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
    document.head.insertBefore(style, document.head.firstChild);
  }

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
    html.style.zoom = fs;   // zoom scales px-based layouts; 1 = untouched

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
      document.documentElement.dataset.theme = 'dark';
    }
  }

  /* ══════════════════════════════════════════════════════════
     BRAND FOOTER (global, bottom-centre, Sydney time)
  ══════════════════════════════════════════════════════════ */

  const _MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const BRAND_TIME_ZONE = 'Australia/Sydney';

  function _formatBrandDate(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: BRAND_TIME_ZONE,
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = type => (parts.find(p => p.type === type) || {}).value || '';
    let hh = get('hour');
    if (hh === '24') hh = '00';
    const monthNum = parseInt(get('month'), 10);
    const mmm = _MONTH_ABBR[monthNum - 1] || get('month');
    return `${get('day')}-${mmm}-${get('year')} ${hh}:${get('minute')}`;
  }

  /* Deprecated no-op: the footer is global now. Kept so old calls don't throw. */
  function _renderBrandFooter() {}

  function _injectGlobalFooterStyles() {
    if (document.getElementById('ot-global-footer-styles')) return;
    const style = document.createElement('style');
    style.id = 'ot-global-footer-styles';
    style.textContent = `
      #ot-global-footer {
        position: fixed; left: 50%; bottom: 6px; transform: translateX(-50%);
        z-index: 9998; pointer-events: none; text-align: center;
        max-width: calc(100vw - 32px); white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
        font-family: 'DM Sans', sans-serif; font-size: 11px; font-style: italic;
        color: var(--text3, #8a8478);
        background: var(--bg, transparent); padding: 3px 12px; border-radius: 8px;
        opacity: 0.9;
      }
      @media (max-width: 640px) { #ot-global-footer { display: none; } }
    `;
    document.head.appendChild(style);
  }

  function _renderGlobalFooter() {
    if (!document.body) return;
    _injectGlobalFooterStyles();
    let el = document.getElementById('ot-global-footer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ot-global-footer';
      document.body.appendChild(el);
    }
    let when = new Date(document.lastModified);
    if (isNaN(when.getTime()) || when.getTime() === 0) when = null;
    const stamp = _formatBrandDate(when);
    const parts = [APP_BRAND.tagline, APP_VERSION, stamp ? ('Last updated ' + stamp) : null].filter(Boolean);
    el.textContent = parts.join(' | ');
  }

  /* ══════════════════════════════════════════════════════════
     SHARED STYLES + NAV MODULE
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

  const _GRIP_CHAR = '⠿';
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

  function _navLabelOverride(id) {
    try { return localStorage.getItem(NAV_LABEL_PREFIX + id) || null; }
    catch (e) { return null; }
  }
  function _setNavLabelOverride(id, label) {
    try {
      if (label && String(label).trim()) localStorage.setItem(NAV_LABEL_PREFIX + id, String(label).trim());
      else localStorage.removeItem(NAV_LABEL_PREFIX + id);
    } catch (e) {}
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
    label.textContent = _navLabelOverride(page.id) || page.label;
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
    container.appendChild(_makeNavLink(NAV_SETTINGS, false));
    _wireNavDrag(container);
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
      try { fn(key, value); } catch (e) { _warn('onChange listener error:', e); }
    });
  }
  function _fireSync() {
    _syncListeners.forEach(fn => {
      try { fn(); } catch (e) { _warn('onSync listener error:', e); }
    });
  }

  /* ══════════════════════════════════════════════════════════
     DATA WRITES
  ══════════════════════════════════════════════════════════ */

  function _stampKey(k) {
    _cache[KT] = Object.assign({}, _cache[KT] || {}, { [k]: Date.now() });
  }

  function _onLocalChange() {
    _dirty = true;
    _writeMirror();                       // always: survives reloads and offline
    if (_live && _tokenValid()) _schedulePush();
    _setStatus();
  }

  /* Replace the whole data set. Keys that disappear are timestamped as
     deletions so the replacement wins on the next merge. */
  function _replaceCache(newObj) {
    const now = Date.now();
    const old = _cache || {};
    const times = {};
    Object.keys(old).forEach(k => { if (k !== KT && !_has(newObj, k)) times[k] = now; });
    Object.keys(newObj).forEach(k => { if (k !== KT) times[k] = now; });
    _cache = Object.assign({}, newObj, { [KT]: times });
    _onLocalChange();
    _applyTheme(_cache);
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
    _createDot();
    _renderGlobalFooter();
    _startWatchdog();
    _trackActivity();

    window.addEventListener('online', _setStatus);
    window.addEventListener('offline', _setStatus);

    // Best-effort: flush a pending live push when the page is left.
    window.addEventListener('pagehide', () => {
      if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
      if (_dirty && _live && _tokenValid()) _liveTick();
    });

    _markReady();
    _authoritative = true;   // the device mirror is the store that pages open from
    _fireSync();
    if (_live) setLive(true);  // resume Live without a login if the token is still valid
    _setStatus();
  }

  /* ── Top-level startup: cache from the mirror immediately ── */
  _cache = _readMirror();
  _loadToken();
  _live = _lsGet(LIVE_KEY) === '1';
  _lastSyncAt = parseInt(_lsGet(LAST_SYNC_KEY) || '0', 10) || 0;
  _injectBaseTheme();
  _applyThemeFromSnapshot();
  _applyTheme(_cache);

  /* ══════════════════════════════════════════════════════════
     BRAND SEQUENCE LOOP (unchanged from v5.6)
  ══════════════════════════════════════════════════════════ */

  function _injectBrandTraceStyles() {
    if (document.getElementById('ot-brand-seq-styles')) return;
    const style = document.createElement('style');
    style.id = 'ot-brand-seq-styles';
    style.textContent = `
      #otBrandName{color:var(--text);}
      #otBrandName .ot-seq-part{display:inline-block;opacity:0;transform:scale(.5);
        transition:opacity .3s ease, transform .42s cubic-bezier(.34,1.56,.64,1);}
      #otBrandName .ot-seq-part.ot-in{opacity:1;transform:scale(1);}
      @media (prefers-reduced-motion: reduce){
        #otBrandName .ot-seq-part{opacity:1;transform:none;transition:none;}
      }
    `;
    document.head.appendChild(style);
  }

  function _tickLogo(el) {
    el.classList.remove('uncheck', 'is-checked');
    void el.offsetWidth;
    el.classList.add('animating');
    el.addEventListener('animationend', function done(e) {
      if (e.animationName === 'logoTickDraw') {
        el.removeEventListener('animationend', done);
        el.classList.remove('animating');
        el.classList.add('is-checked');
      }
    });
  }
  function _untickLogo(el) {
    el.classList.remove('animating', 'is-checked');
    void el.offsetWidth;
    el.classList.add('uncheck');
    el.addEventListener('animationend', function done(e) {
      if (e.animationName === 'logoBoxUnfill') {
        el.removeEventListener('animationend', done);
        el.classList.remove('uncheck');
      }
    });
  }

  function _runBrandTrace() {
    var name = document.getElementById('otBrandName');
    var logo = document.getElementById('logoCheck');
    if (!name || !logo || name.__otTraced) return;
    name.__otTraced = true;

    if (!name.textContent) name.textContent = APP_BRAND.name;

    var fresh = logo.cloneNode(true);
    fresh.classList.remove('animating', 'is-checked', 'uncheck');
    logo.parentNode.replaceChild(fresh, logo);
    logo = fresh;

    _injectBrandTraceStyles();

    function splitBrand(s) {
      var i = s.indexOf('+');
      return i === -1 ? [s] : [s.slice(0, i), '+', s.slice(i + 1)];
    }

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function boot() {
      var full = name.textContent || APP_BRAND.name;
      name.textContent = '';
      var parts = splitBrand(full).map(function (txt) {
        var span = document.createElement('span');
        span.className = 'ot-seq-part';
        span.textContent = txt;
        name.appendChild(span);
        return span;
      });

      if (name.nextSibling !== logo) name.parentNode.insertBefore(logo, name.nextSibling);

      if (reduce) {
        parts.forEach(function (p) { p.classList.add('ot-in'); });
        _tickLogo(logo);
        return;
      }

      var STEP = 380, BASE = 560, HOLD = 1700;
      var timers = [];
      function clearTimers() { timers.forEach(clearTimeout); timers = []; }
      function cycle() {
        clearTimers();
        parts.forEach(function (p) { p.classList.remove('ot-in'); });
        if (logo.classList.contains('is-checked')) _untickLogo(logo);
        parts.forEach(function (p, i) {
          timers.push(setTimeout(function () { p.classList.add('ot-in'); }, BASE + STEP * i));
        });
        timers.push(setTimeout(function () { _tickLogo(logo); }, BASE + STEP * parts.length));
        timers.push(setTimeout(cycle, BASE + STEP * parts.length + HOLD));
      }
      cycle();
    }

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { requestAnimationFrame(boot); });
    else setTimeout(boot, 0);

    var checked = false;
    logo.addEventListener('animationend', function (e) {
      if (e.animationName === 'logoTickDraw') checked = true;
      if (e.animationName === 'logoBoxUnfill') checked = false;
    });
    logo.addEventListener('click', function () { checked ? _untickLogo(logo) : _tickLogo(logo); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _runBrandTrace);
  else _runBrandTrace();

  /* ══════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════ */

  const OT = {

    brand: APP_BRAND,

    setTitle(t) {
      if (t != null) { try { document.title = String(t); } catch (e) {} }
    },

    renderBrandFooter: _renderBrandFooter,

    isDark() {
      const v = _cache ? _cache['TODAY_DARK'] : null;
      return (v !== undefined && v !== null) ? v === '1' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    },
    applyTheme() { _applyTheme(_cache || {}); },

    navPages: NAV_PAGES.map(p => ({ ...p })),

    getNavLabel(id) {
      const ov = _navLabelOverride(id);
      if (ov) return ov;
      const p = NAV_PAGES.find(x => x.id === id) || (NAV_SETTINGS.id === id ? NAV_SETTINGS : null);
      return p ? p.label : '';
    },
    setNavLabel(id, label) {
      _setNavLabelOverride(id, label);
      _buildNav();
    },

    isReady()         { return _ready; },
    isAuthoritative() { return _authoritative; },

    onReady(fn) {
      if (_ready) fn();
      else _readyQueue.push(fn);
    },

    onSync(fn) {
      _syncListeners.push(fn);
      if (_authoritative) { try { fn(); } catch (e) {} }
    },

    onChange(fn) { _changeListeners.push(fn); },

    async get(key) {
      if (!_ready || !_cache) return null;
      const val = _cache[key];
      return (val === undefined || val === null) ? null : String(val);
    },

    async set(key, value) {
      if (!_cache) _cache = {};
      _cache[key] = value;
      _stampKey(key);
      _onLocalChange();
      if (THEME_KEYS.indexOf(key) !== -1) _applyTheme(_cache);
      _fireChange(key, value);
    },

    async remove(key) {
      if (!_cache) return;
      delete _cache[key];
      _stampKey(key);                     // a timestamped delete
      _onLocalChange();
      if (THEME_KEYS.indexOf(key) !== -1) _applyTheme(_cache);
      _fireChange(key, null);
    },

    async keys() {
      return _cache ? Object.keys(_cache).filter(k => k !== KT) : [];
    },

    async getAll() {
      if (!_cache) return {};
      const out = { ..._cache };
      return out;
    },

    async setAll(obj) {
      _replaceCache(obj || {});
      _fireSync();
    },

    async clear() {
      _replaceCache({});
      _fireSync();
    },

    /* ── Sync ── */
    sync: syncNow,
    setLive(on) { return setLive(on); },
    isLive() { return _live; },
    undoLastSync,
    getBackups() {
      return _getBackups().map(b => ({
        at: b.at,
        keys: Object.keys(b.data).filter(k => k !== KT).length,
      }));
    },
    getStatus: _computeStatus,
    onStatus(fn) {
      _statusListeners.push(fn);
      try { fn(_computeStatus()); } catch (e) {}
    },
    lastSyncAt() { return _lastSyncAt || null; },

    /* ── Auth ── */
    signIn() { return _interactiveSignIn().then(ok => { _setStatus(); return ok; }); },
    pickFile() { return this.signIn(); },

    async forget() {
      const old = _token;
      _dropToken();
      _fileId = null;
      _remoteMod = null;
      _dirty = false;
      _lsDel(SIGNED_IN_KEY);
      _lsDel(CONSENT_KEY);
      _tokenClient = null;
      if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
      _live = false;
      _lsSet(LIVE_KEY, '0');
      _lastError = null;
      try {
        if (window.google && google.accounts && google.accounts.oauth2 && old) {
          google.accounts.oauth2.revoke(old, () => {});
        }
      } catch (e) {}
      _setStatus();
    },
  };

  global.OT = OT;
  _init();

})(window);
