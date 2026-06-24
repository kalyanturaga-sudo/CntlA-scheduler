/* ============================================================
   storage.js  —  Onetrack Shared Storage Engine  v3.0
   ------------------------------------------------------------
   Phase 3: Google Drive API backend.
   Works on ANY browser/device, including iPad Safari — replaces
   the v2.0 File System Access API (Chrome-desktop-only) approach.

   PUBLIC API (unchanged — all HTML files work as-is):
     await OT.get(key)            → value (string) or null
     await OT.set(key, value)     → void
     await OT.remove(key)         → void
     await OT.keys()              → string[]
     await OT.clear()             → void
     await OT.getAll()            → { key: value, ... }
     await OT.setAll(obj)         → void  (used by import)
     OT.onReady(fn)               → call fn when file is linked
     OT.isReady()                 → true/false

   HOW IT WORKS (v3.0):
   1. On load, shows a "Sign in with Google" banner.
   2. User signs in once via Google Identity Services (popup).
   3. Script searches Drive for a file named onetrack-data.json
      (creates it if missing).
   4. Reads its JSON content into memory.
   5. Every set() debounces and PATCHes the full JSON back to
      that Drive file via the Drive v3 REST API.
   6. Access token lives in memory only — you'll re-click "Sign
      in" once per browser session (token expires ~1 hour), but
      no need to re-pick a file. This is normal for OAuth in a
      pure client-side (no backend) app.

   CONFIG — edit these two lines if you ever need to:
   ============================================================ */
  const GOOGLE_CLIENT_ID = '356548061716-4fjrgh28vetubhuu2cf4ano859tnftuv.apps.googleusercontent.com';
  const DRIVE_FILE_NAME  = 'onetrack-data.json';
/* ============================================================ */

(function (global) {
  'use strict';

  const SCOPE        = 'https://www.googleapis.com/auth/drive';
  const BANNER_ID     = 'ot-storage-banner';
  const INDICATOR_ID  = 'ot-sync-indicator';

  /* ── Internal state ── */
  let _accessToken = null;   // in-memory only, not persisted
  let _fileId      = null;   // Drive file ID, once located/created
  let _cache       = null;   // in-memory mirror of the JSON file
  let _ready       = false;
  let _readyQueue  = [];
  let _writeTimer  = null;
  let _tokenClient = null;

  /* ══════════════════════════════════════════════════════════
     INDICATOR
  ══════════════════════════════════════════════════════════ */

  function _createIndicator() {
    if (document.getElementById(INDICATOR_ID)) return;
    const el = document.createElement('div');
    el.id = INDICATOR_ID;
    el.title = 'Onetrack storage: unlinked';
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
      saving:   { bg: '#c17b3f', sh: 'rgba(193,123,63,0.25)',  title: 'Onetrack: saving…' },
      saved:    { bg: '#3a8c5c', sh: 'rgba(58,140,92,0.25)',   title: 'Onetrack: saved ✓' },
      error:    { bg: '#c0392b', sh: 'rgba(192,57,43,0.25)',   title: 'Onetrack: error — click to re-link' },
      unlinked: { bg: '#9e9891', sh: 'rgba(158,152,145,0.25)', title: 'Onetrack: click to sign in' },
      loading:  { bg: '#6b9fd4', sh: 'rgba(107,159,212,0.25)', title: 'Onetrack: connecting…' },
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
        background: #1e1c18; color: #f0ece6; padding: 14px 20px;
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

  /* ══════════════════════════════════════════════════════════
     GOOGLE IDENTITY SERVICES — load script + token client
  ══════════════════════════════════════════════════════════ */

  function _loadGisScript() {
    return new Promise((resolve, reject) => {
      if (global.google && global.google.accounts && global.google.accounts.oauth2) {
        resolve(); return;
      }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function _signIn() {
    try {
      _setIndicator('loading');
      await _loadGisScript();
      if (!_tokenClient) {
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPE,
          callback: async (resp) => {
            if (resp.error) {
              console.error('[Onetrack storage] OAuth error:', resp);
              _setIndicator('error');
              return;
            }
            _accessToken = resp.access_token;
            await _connectToFile();
          },
        });
      }
      _tokenClient.requestAccessToken({ prompt: _accessToken ? '' : 'consent' });
    } catch (err) {
      console.error('[Onetrack storage] Sign-in error:', err);
      _setIndicator('error');
    }
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
      // token expired mid-session
      _accessToken = null;
      _hideBanner();
      _setIndicator('unlinked');
      _showBanner(
        '<strong style="color:#d4935a;">Session expired</strong><br><span style="color:#a09890;font-size:12px;">Sign in again to keep syncing.</span>',
        'Sign in',
        _signIn
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

    // Not found — create a fresh empty one
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
    try {
      _cache = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      console.warn('[Onetrack storage] Could not parse Drive file, starting fresh:', err);
      _cache = {};
    }
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
      console.error('[Onetrack storage] Write error:', err);
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
      _fileId = await _findOrCreateFile();
      await _loadFromFile();
      _hideBanner();
      _setIndicator('saved');
      _markReady();
    } catch (err) {
      console.error('[Onetrack storage] Connect error:', err);
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

  /* ══════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════ */

  function _init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _init);
      return;
    }
    _createIndicator();
    _setIndicator('unlinked');
    _showBanner(
      '<strong style="color:#d4935a;">Sign in to sync</strong><br><span style="color:#a09890;font-size:12px;">Connect your Google account to load and save your checklists.</span>',
      'Sign in',
      _signIn
    );
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC API (identical to v1.0/v2.0 — no HTML changes needed)
  ══════════════════════════════════════════════════════════ */

  const OT = {

    isReady()   { return _ready; },

    onReady(fn) {
      if (_ready) fn();
      else _readyQueue.push(fn);
    },

    async get(key) {
      if (!_ready || !_cache) return null;
      const val = _cache[key];
      return (val === undefined || val === null) ? null : String(val);
    },

    async set(key, value) {
      if (!_cache) _cache = {};
      _cache[key] = value;
      _scheduleSave();
    },

    async remove(key) {
      if (!_cache) return;
      delete _cache[key];
      _scheduleSave();
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
    },

    async clear() {
      _cache = {};
      await _writeToFile();
    },

    /* Manually trigger sign-in (also wired to indicator dot click) */
    pickFile: _signIn,
    signIn: _signIn,

    /* Force re-read from Drive (useful if file was edited elsewhere) */
    async reload() {
      if (_fileId) await _loadFromFile();
    },

    /* Forget current session — forces a fresh sign-in */
    async forget() {
      _accessToken = null;
      _fileId      = null;
      _cache       = null;
      _ready       = false;
      _setIndicator('unlinked');
      _showBanner(
        '<strong style="color:#d4935a;">Sign in to sync</strong><br><span style="color:#a09890;font-size:12px;">Connect your Google account to load and save your checklists.</span>',
        'Sign in',
        _signIn
      );
    },
  };

  global.OT = OT;
  _init();

})(window);
