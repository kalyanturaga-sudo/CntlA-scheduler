/* ============================================================
   storage.js  —  Onetrack Shared Storage Engine  v2.0
   ------------------------------------------------------------
   Upgrades v1.0 with persistent file handle via IndexedDB.
   The file handle now survives browser restarts — Chrome only
   asks for a one-click permission grant on each new session
   instead of making you re-pick the file every time.

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

   HOW IT WORKS (v2.0):
   1. First time ever: banner appears → user picks onetrack-data.json
      (ideally from a Google Drive desktop folder for cloud sync)
   2. The FileSystemFileHandle is saved into IndexedDB under the
      key OT_HANDLE. IndexedDB survives cache clears and restarts.
   3. On every subsequent visit Chrome auto-restores the handle
      and shows a small "Allow access?" chip at the top of the
      page — one click, no file picker needed.
   4. Every set() debounces and writes the full JSON to disk.
   5. File lives in your Google Drive folder → free cloud sync
      across devices that share the same Drive.

   FUTURE (Phase 3 — Google Drive API):
   Swap _readFile / _writeFile for Drive REST calls.
   Nothing in the HTML files changes.
   ============================================================ */

(function (global) {
  'use strict';

  /* ── Constants ── */
  const IDB_NAME     = 'OT_STORAGE';       // IndexedDB database name
  const IDB_STORE    = 'handles';           // object store name
  const IDB_KEY      = 'OT_HANDLE';        // key under which handle is stored
  const BANNER_ID    = 'ot-storage-banner';
  const INDICATOR_ID = 'ot-sync-indicator';

  /* ── Internal state ── */
  let _fileHandle  = null;   // FileSystemFileHandle
  let _cache       = null;   // in-memory mirror of the JSON file
  let _ready       = false;
  let _readyQueue  = [];     // callbacks waiting for ready
  let _writeTimer  = null;   // debounce timer for writes

  /* ══════════════════════════════════════════════════════════
     INDEXEDDB — persist and restore file handle across sessions
  ══════════════════════════════════════════════════════════ */

  function _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function _saveHandleToIDB(handle) {
    try {
      const db = await _openIDB();
      return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readwrite');
        const req = tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        req.onsuccess = () => resolve();
        req.onerror   = e  => reject(e.target.error);
      });
    } catch (err) {
      console.warn('[Onetrack storage] Could not save handle to IDB:', err);
    }
  }

  async function _loadHandleFromIDB() {
    try {
      const db = await _openIDB();
      return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = e => resolve(e.target.result || null);
        req.onerror   = e => reject(e.target.error);
      });
    } catch (err) {
      console.warn('[Onetrack storage] Could not load handle from IDB:', err);
      return null;
    }
  }

  async function _clearHandleFromIDB() {
    try {
      const db = await _openIDB();
      return new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(IDB_KEY);
        tx.oncomplete = () => resolve();
      });
    } catch (err) { /* silent */ }
  }

  /* ══════════════════════════════════════════════════════════
     INDICATOR — small dot in top-right showing sync status
     green = saved  |  orange = saving  |  red = error  |  grey = unlinked
  ══════════════════════════════════════════════════════════ */

  function _createIndicator() {
    if (document.getElementById(INDICATOR_ID)) return;
    const el = document.createElement('div');
    el.id = INDICATOR_ID;
    el.title = 'Onetrack storage: saved';
    el.style.cssText = `
      position: fixed;
      top: 14px;
      right: 14px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #9e9891;
      z-index: 99999;
      transition: background 0.3s;
      box-shadow: 0 0 0 2px rgba(158,152,145,0.25);
      cursor: pointer;
    `;
    document.body.appendChild(el);

    /* Click indicator to re-pick file at any time */
    el.addEventListener('click', () => _pickFile());
  }

  function _setIndicator(state) {
    const el = document.getElementById(INDICATOR_ID);
    if (!el) return;
    const states = {
      saving:   { bg: '#c17b3f', sh: 'rgba(193,123,63,0.25)',  title: 'Onetrack: saving…'       },
      saved:    { bg: '#3a8c5c', sh: 'rgba(58,140,92,0.25)',   title: 'Onetrack: saved ✓'        },
      error:    { bg: '#c0392b', sh: 'rgba(192,57,43,0.25)',   title: 'Onetrack: error — click to re-link' },
      unlinked: { bg: '#9e9891', sh: 'rgba(158,152,145,0.25)', title: 'Onetrack: click to link file' },
      waiting:  { bg: '#6b9fd4', sh: 'rgba(107,159,212,0.25)', title: 'Onetrack: click Allow in browser bar' },
    };
    const s = states[state] || states.unlinked;
    el.style.background = s.bg;
    el.style.boxShadow  = `0 0 0 2px ${s.sh}`;
    el.title = s.title;
  }

  /* ══════════════════════════════════════════════════════════
     BANNER — shown when no file is linked
  ══════════════════════════════════════════════════════════ */

  function _showBanner(msg) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.style.cssText = `
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #1e1c18;
        color: #f0ece6;
        padding: 14px 20px;
        border-radius: 12px;
        font-family: 'DM Sans', sans-serif;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 14px;
        z-index: 99999;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        border: 1px solid rgba(255,255,255,0.1);
        max-width: 500px;
        width: calc(100vw - 40px);
      `;
      document.body.appendChild(banner);
    }

    /* Default message — first time setup */
    const text = msg || `
      <strong style="color:#d4935a;">Link your data file</strong><br>
      <span style="color:#a09890;font-size:12px;">
        Pick <code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;">onetrack-data.json</code>
        — ideally from your Google Drive folder for cloud sync
      </span>
    `;

    banner.innerHTML = `
      <span style="font-size:20px;">📂</span>
      <span style="flex:1;line-height:1.5;">${text}</span>
      <button id="ot-pick-btn" style="
        background:#3a8c5c;color:#fff;border:none;padding:9px 16px;
        border-radius:8px;font-size:13px;font-family:'DM Sans',sans-serif;
        font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;
      ">Pick File</button>
    `;

    document.getElementById('ot-pick-btn').addEventListener('click', async () => {
      await _pickFile();
    });
  }

  function _hideBanner() {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
  }

  /* ══════════════════════════════════════════════════════════
     FILE HANDLE — pick new or restore from IDB
  ══════════════════════════════════════════════════════════ */

  async function _pickFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Onetrack Data', accept: { 'application/json': ['.json'] } }],
        excludeAcceptAllOption: false,
        multiple: false,
      });
      _fileHandle = handle;
      await _saveHandleToIDB(handle);   // ← persist for next session
      await _loadFromFile();
      _hideBanner();
      _setIndicator('saved');
      _markReady();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[Onetrack storage] File pick error:', err);
        _setIndicator('error');
      }
    }
  }

  /* Try to restore the persisted handle from IndexedDB.
     Returns true if successfully reconnected, false otherwise. */
  async function _tryRestoreHandle() {
    const handle = await _loadHandleFromIDB();
    if (!handle) return false;

    /* queryPermission tells us if we already have access,
       or if Chrome needs a user gesture to re-grant it.      */
    let perm = await handle.queryPermission({ mode: 'readwrite' });

    if (perm === 'granted') {
      /* Already allowed — no user interaction needed */
      _fileHandle = handle;
      await _loadFromFile();
      _hideBanner();
      _setIndicator('saved');
      _markReady();
      return true;
    }

    if (perm === 'prompt') {
      /* Chrome needs one click to re-grant permission.
         Show a minimal banner explaining this.          */
      _setIndicator('waiting');
      _showBanner(`
        <strong style="color:#6b9fd4;">Almost ready</strong><br>
        <span style="color:#a09890;font-size:12px;">
          Click <strong style="color:#f0ece6;">Allow</strong> below to reconnect your data file —
          no need to pick it again
        </span>
      `);

      /* Replace button label */
      const btn = document.getElementById('ot-pick-btn');
      if (btn) {
        btn.textContent = 'Allow Access';
        btn.style.background = '#6b9fd4';
        btn.onclick = async () => {
          try {
            perm = await handle.requestPermission({ mode: 'readwrite' });
            if (perm === 'granted') {
              _fileHandle = handle;
              await _loadFromFile();
              _hideBanner();
              _setIndicator('saved');
              _markReady();
            } else {
              /* User denied — fall back to full pick */
              await _pickFile();
            }
          } catch (err) {
            await _pickFile();
          }
        };
      }
      return true;   // handled (waiting for user click)
    }

    /* Permission denied — clear the stale handle, start fresh */
    await _clearHandleFromIDB();
    return false;
  }

  /* ══════════════════════════════════════════════════════════
     READ / WRITE
  ══════════════════════════════════════════════════════════ */

  async function _loadFromFile() {
    try {
      const file = await _fileHandle.getFile();
      const text = await file.text();
      _cache = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      console.warn('[Onetrack storage] Could not read file, starting fresh:', err);
      _cache = {};
    }
  }

  async function _writeToFile() {
    if (!_fileHandle) return;
    try {
      _setIndicator('saving');
      const writable = await _fileHandle.createWritable();
      await writable.write(JSON.stringify(_cache, null, 2));
      await writable.close();
      _setIndicator('saved');
    } catch (err) {
      console.error('[Onetrack storage] Write error:', err);
      _setIndicator('error');
    }
  }

  /* Batches rapid saves into one disk write (300 ms debounce) */
  function _scheduleSave() {
    if (_writeTimer) clearTimeout(_writeTimer);
    _writeTimer = setTimeout(() => {
      _writeToFile();
      _writeTimer = null;
    }, 300);
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
     FALLBACK — browsers without File System Access API
     (Firefox, Safari) — silently uses localStorage
  ══════════════════════════════════════════════════════════ */

  function _fallbackToLocalStorage() {
    console.warn('[Onetrack storage] File System Access API unavailable. Using localStorage fallback.');
    _cache = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      _cache[k] = localStorage.getItem(k);
    }
    _markReady();
  }

  /* ══════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════ */

  async function _init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _init);
      return;
    }

    _createIndicator();
    _setIndicator('unlinked');

    if (!('showOpenFilePicker' in window)) {
      _fallbackToLocalStorage();
      return;
    }

    /* Try to restore from IndexedDB first */
    const restored = await _tryRestoreHandle();

    /* Nothing in IDB — show the first-time setup banner */
    if (!restored) {
      _showBanner();
    }
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC API  (identical to v1.0 — no HTML changes needed)
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

    /* Re-pick file at any time (also wired to indicator dot click) */
    pickFile: _pickFile,

    /* Force re-read from disk (useful if file was edited externally) */
    async reload() {
      if (_fileHandle) await _loadFromFile();
    },

    /* Forget the saved handle — use if you want to link a different file */
    async forget() {
      await _clearHandleFromIDB();
      _fileHandle = null;
      _cache      = null;
      _ready      = false;
      _setIndicator('unlinked');
      _showBanner();
    },
  };

  global.OT = OT;
  _init();

})(window);
