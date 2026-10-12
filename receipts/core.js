/* core.js — Household Receipts offline engine.
 * Shared by index.html (the page) and sw.js (the service worker).
 * Holds the photo queue in IndexedDB and sends it to the Apps Script backend.
 * No DOM access in here, so the service worker can run it too. */
(function (root) {
  'use strict';

  const DB_NAME = 'household-receipts';
  const DB_VERSION = 2;
  const QUEUE = 'queue';
  const KV = 'kv';
  const INBOX = 'inbox';   // files handed over by the Android share sheet, waiting for the page to resize + queue them
  const UPLOAD_TIMEOUT_MS = 150000;
  const STALE_UPLOAD_MS = 4 * 60 * 1000;   // an "uploading" record older than this is retried

  /* ---------------- IndexedDB ---------------- */

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(QUEUE)) {
          const s = db.createObjectStore(QUEUE, { keyPath: 'id' });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(INBOX)) db.createObjectStore(INBOX, { keyPath: 'id' });
      };
      req.onsuccess = function () {
        const db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error || new Error('IndexedDB failed to open')); };
      req.onblocked = function () { /* another tab holds an old version; the open resolves when it closes */ };
    });
    return dbPromise;
  }

  function run(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try { result = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { Promise.resolve(result).then(resolve, reject); };
        tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
        tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
      });
    });
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function putRecord(rec) { return run(QUEUE, 'readwrite', function (s) { s.put(rec); return rec; }); }
  function getRecord(id) { return run(QUEUE, 'readonly', function (s) { return reqToPromise(s.get(id)); }); }
  function deleteRecord(id) { return run(QUEUE, 'readwrite', function (s) { s.delete(id); return id; }); }
  function allRecords() {
    return run(QUEUE, 'readonly', function (s) { return reqToPromise(s.getAll()); }).then(function (list) {
      return (list || []).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    });
  }
  function kvGet(key) {
    return run(KV, 'readonly', function (s) { return reqToPromise(s.get(key)); }).then(function (r) { return r ? r.value : null; });
  }
  function kvSet(key, value) { return run(KV, 'readwrite', function (s) { s.put({ key: key, value: value }); return value; }); }
  function inboxAdd(blob, meta) {
    const rec = Object.assign({ id: uuid(), createdAt: Date.now(), blob: blob }, meta || {});
    return run(INBOX, 'readwrite', function (s) { s.put(rec); return rec; });
  }
  function inboxAll() { return run(INBOX, 'readonly', function (s) { return reqToPromise(s.getAll()); }).then(function (l) { return l || []; }); }
  function inboxDelete(id) { return run(INBOX, 'readwrite', function (s) { s.delete(id); return id; }); }

  /* ---------------- Config ---------------- */

  function normalizeUrl(u) {
    u = String(u || '').trim();
    if (!u) return '';
    return u.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }

  function getConfig() {
    return kvGet('config').then(function (c) {
      c = c || {};
      return {
        url: normalizeUrl(c.url || ''),
        token: String(c.token || '').trim(),
        who: String(c.who || '').trim(),
        tokenBad: !!c.tokenBad,
        camOnOpen: c.camOnOpen !== false,
        camZoom: Number(c.camZoom) > 0 ? Number(c.camZoom) : 1,
        camWideId: String(c.camWideId || ''),
        bankAccount: String(c.bankAccount || '')
      };
    });
  }
  function setConfig(cfg) {
    return getConfig().then(function (old) {
      const merged = Object.assign({}, old, cfg || {});
      merged.url = normalizeUrl(merged.url);
      merged.token = String(merged.token || '').trim();
      if (merged.url !== old.url || merged.token !== old.token) merged.tokenBad = false;
      return kvSet('config', merged).then(function () { return merged; });
    });
  }
  function configReady(cfg) { return !!(cfg && cfg.url && cfg.token); }

  /* ---------------- Encoding helpers ---------------- */

  function blobToBase64(blob) {
    return blob.arrayBuffer().then(function (buf) {
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    });
  }

  function sha256Hex(blob) {
    return blob.arrayBuffer().then(function (buf) {
      if (root.crypto && root.crypto.subtle) {
        return root.crypto.subtle.digest('SHA-256', buf).then(function (hash) {
          return Array.prototype.map.call(new Uint8Array(hash), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        });
      }
      // Fallback (non-secure context): FNV-1a over the bytes, still unique enough for dedupe
      const bytes = new Uint8Array(buf);
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let i = 0; i < bytes.length; i++) {
        h1 ^= bytes[i]; h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 ^= bytes[(bytes.length - 1 - i)]; h2 = Math.imul(h2, 0x01000193) >>> 0;
      }
      return 'fnv' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + bytes.length.toString(16);
    });
  }

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* ---------------- Backend calls ---------------- */

  function fetchWithTimeout(url, options, ms) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    if (ctrl) options.signal = ctrl.signal;
    return fetch(url, options).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (text) {
        let data = null;
        try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (!data) {
          const looksHtml = /<html|<!doctype/i.test(text);
          const err = new Error(looksHtml
            ? 'The backend URL did not answer as a web app (got a web page). Use the /exec URL from Deploy → Web app, with access set to Anyone.'
            : 'Unexpected reply from the backend (HTTP ' + res.status + ').');
          err.permanent = looksHtml;
          throw err;
        }
        return data;
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      const err = new Error(e && e.name === 'AbortError' ? 'Timed out' : 'No connection');
      err.network = true;
      throw err;
    });
  }

  function postJson(cfg, payload, timeoutMs) {
    payload = Object.assign({ token: cfg.token }, payload || {});
    return fetchWithTimeout(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // no CORS preflight (Apps Script can't answer one)
      body: JSON.stringify(payload),
      redirect: 'follow'
    }, timeoutMs || UPLOAD_TIMEOUT_MS);
  }

  function getJson(cfg, params, timeoutMs) {
    const q = Object.assign({ token: cfg.token }, params || {});
    const qs = Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
    return fetchWithTimeout(cfg.url + '?' + qs, { method: 'GET', redirect: 'follow' }, timeoutMs || 45000);
  }

  function ping(cfg) { return getJson(cfg, { action: 'ping' }, 30000); }
  function fetchSummary(cfg) { return getJson(cfg, { action: 'summary' }, 90000); }

  /* ---------------- Queue + sync ---------------- */

  function backoffMs(attempts) {
    return Math.min(30 * 60 * 1000, 30000 * Math.pow(2, Math.max(0, attempts - 1)));
  }

  /**
   * Adds a ready-to-send file to the queue. Returns the record.
   * blob  = what Drive keeps (jpeg, png or pdf)
   * meta  = { thumb, who, capturedAt, kind: 'photo'|'screenshot'|'pdf', pages: [jpeg blobs] (slices for Claude, optional) }
   */
  function enqueue(blob, meta) {
    meta = meta || {};
    return sha256Hex(blob).then(function (hash) {
      return allRecords().then(function (list) {
        const dup = list.find(function (r) { return r.hash === hash && r.status !== 'rejected'; });
        if (dup) { dup.duplicateOf = true; return dup; }
        const rec = {
          id: uuid(),
          createdAt: Date.now(),
          capturedAt: meta.capturedAt || new Date().toISOString(),
          status: 'pending',          // pending | uploading | done | rejected | error
          attempts: 0,
          nextTryAt: 0,
          lastError: '',
          retryable: true,
          hash: hash,
          mime: blob.type || (meta.kind === 'pdf' ? 'application/pdf' : 'image/jpeg'),
          size: blob.size,
          blob: blob,
          pages: Array.isArray(meta.pages) && meta.pages.length > 1 ? meta.pages : null,
          kind: meta.kind || 'photo',
          thumb: meta.thumb || null,
          who: meta.who || '',
          result: null,
          message: ''
        };
        return putRecord(rec);
      });
    });
  }

  function isDue(rec, now) {
    if (rec.status === 'pending') return true;
    if (rec.status === 'error') return rec.retryable && (rec.nextTryAt || 0) <= now;
    if (rec.status === 'uploading') return (now - (rec.uploadStartedAt || 0)) > STALE_UPLOAD_MS;
    return false;
  }

  function applyResponse(rec, data) {
    if (data && data.ok) {
      rec.attempts = 0; rec.lastError = ''; rec.retryable = true; rec.nextTryAt = 0;
      if (data.status === 'not_a_receipt') {
        rec.status = 'rejected';
        rec.message = data.message || 'That did not look like a receipt.';
        rec.blob = null; rec.pages = null;
      } else {
        rec.status = 'done';
        rec.result = data.receipt || null;
        rec.receiptId = data.receiptId || (data.receipt && data.receipt.id) || '';
        rec.duplicate = !!data.duplicate;
        rec.duplicateOf = data.duplicateOf || '';
        rec.duplicateStrength = data.duplicateStrength || '';
        rec.doneAt = Date.now();
        rec.blob = null; rec.pages = null; // safely in Drive now; free the phone's space
      }
      return rec;
    }
    const code = data && data.error;
    rec.attempts = (rec.attempts || 0) + 1;
    rec.status = 'error';
    if (code === 'bad_token') {
      rec.retryable = false;
      rec.lastError = 'Join word is wrong — check Settings.';
      rec.configProblem = true;
    } else if (code === 'in_progress') {
      rec.retryable = true;
      rec.nextTryAt = Date.now() + 60000;
      rec.lastError = 'Still being read on the server';
      rec.attempts = Math.max(0, rec.attempts - 1);
    } else if (data && data.retryable === false && !code) {
      rec.retryable = false;
      rec.lastError = (data && data.message) || 'The backend refused this file.';
    } else {
      rec.retryable = data ? data.retryable !== false : true;
      rec.nextTryAt = Date.now() + backoffMs(rec.attempts);
      rec.lastError = (data && (data.message || data.error)) || 'Unknown error';
    }
    return rec;
  }

  /** Sends one record now (ignores backoff). */
  function uploadOne(rec, cfg) {
    if (!rec.blob) {
      rec.status = 'error'; rec.retryable = false; rec.lastError = 'File is no longer on this phone.';
      return putRecord(rec);
    }
    rec.status = 'uploading';
    rec.uploadStartedAt = Date.now();
    if (!rec.who && cfg.who) rec.who = cfg.who;   // snapped before a name was chosen
    return putRecord(rec).then(function () {
      return Promise.all([blobToBase64(rec.blob)].concat((rec.pages || []).map(blobToBase64)));
    }).then(function (encoded) {
      const payload = {
        action: 'receipt',
        hash: rec.hash,
        image: encoded[0],
        mime: rec.mime,
        kind: rec.kind || 'photo',
        who: rec.who || cfg.who || '',
        capturedAt: rec.capturedAt,
        clientId: rec.id
      };
      if (encoded.length > 1) payload.pages = encoded.slice(1);
      return postJson(cfg, payload);
    }).then(function (data) {
      return getRecord(rec.id).then(function (fresh) {
        if (!fresh) return null;                       // deleted while uploading
        applyResponse(fresh, data);
        return putRecord(fresh);
      });
    }, function (err) {
      return getRecord(rec.id).then(function (fresh) {
        if (!fresh) return null;
        if (err && err.network) {
          fresh.status = 'pending';                      // no signal: try again later, not an error
          fresh.lastError = err.message;
        } else {
          fresh.attempts = (fresh.attempts || 0) + 1;
          fresh.status = 'error';
          fresh.retryable = !(err && err.permanent);
          fresh.nextTryAt = Date.now() + backoffMs(fresh.attempts);
          fresh.lastError = (err && err.message) || String(err);
          if (err && err.permanent) fresh.configProblem = true;
        }
        return putRecord(fresh);
      });
    });
  }

  /** The page and the service worker can both try to sync at once; a Web Lock makes them take turns. */
  function withSyncLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('household-receipts-sync', fn);
    }
    return fn();
  }

  let syncInFlight = null;
  /** Sends everything that is due. Resolves with {sent, failed, remaining, skipped}. */
  function syncAll(opts) {
    opts = opts || {};
    if (syncInFlight) return syncInFlight;
    syncInFlight = withSyncLock(function () { return syncAllInner(opts); }).finally(function () { syncInFlight = null; });
    return syncInFlight;
  }

  function syncAllInner(opts) {
    return getConfig().then(function (cfg) {
      const out = { sent: 0, failed: 0, remaining: 0, skipped: 0, noConfig: false, offline: false };
      if (!configReady(cfg)) { out.noConfig = true; return out; }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        out.offline = true;
        return allRecords().then(function (list) {
          out.remaining = list.filter(function (r) { return r.status === 'pending' || r.status === 'uploading' || (r.status === 'error' && r.retryable); }).length;
          return out;
        });
      }
      return allRecords().then(function (list) {
        const now = Date.now();
        const due = list.filter(function (r) {
          if (opts.force && r.status === 'error' && r.retryable) return true;   // force = ignore backoff
          return isDue(r, now);
        }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        let chain = Promise.resolve();
        due.forEach(function (rec) {
          chain = chain.then(function () {
            return getRecord(rec.id).then(function (fresh) {
              // re-check: the other context (page / service worker) may have sent it meanwhile
              if (!fresh) return null;
              const stillDue = (opts.force && fresh.status === 'error' && fresh.retryable) || isDue(fresh, Date.now());
              if (!stillDue) { out.skipped++; return null; }
              if (opts.force) fresh.nextTryAt = 0;
              return uploadOne(fresh, cfg);
            }).then(function (saved) {
              if (!saved) return;
              if (saved.status === 'done' || saved.status === 'rejected') out.sent++;
              else out.failed++;
              if (opts.onProgress) { try { opts.onProgress(saved); } catch (e) { /* ignore */ } }
              if (saved.configProblem) { throw { stopSync: true }; }
            });
          });
        });
        return chain.catch(function (e) { if (!(e && e.stopSync)) throw e; }).then(function () {
          return allRecords();
        }).then(function (after) {
          out.remaining = after.filter(function (r) { return r.status === 'pending' || r.status === 'uploading' || (r.status === 'error' && r.retryable); }).length;
          return out;
        });
      });
    }).finally(function () { syncInFlight = null; });
    return syncInFlight;
  }

  /** Removes finished records older than `days` (keeps the queue small). */
  function pruneDone(days) {
    const cutoff = Date.now() - (days == null ? 60 : days) * 86400000;
    return allRecords().then(function (list) {
      const old = list.filter(function (r) { return (r.status === 'done' || r.status === 'rejected') && (r.doneAt || r.createdAt || 0) < cutoff; });
      return Promise.all(old.map(function (r) { return deleteRecord(r.id); })).then(function () { return old.length; });
    });
  }

  root.ReceiptsCore = {
    openDb: openDb, putRecord: putRecord, getRecord: getRecord, deleteRecord: deleteRecord, allRecords: allRecords,
    kvGet: kvGet, kvSet: kvSet, inboxAdd: inboxAdd, inboxAll: inboxAll, inboxDelete: inboxDelete,
    getConfig: getConfig, setConfig: setConfig, configReady: configReady,
    blobToBase64: blobToBase64, sha256Hex: sha256Hex, uuid: uuid,
    postJson: postJson, getJson: getJson, ping: ping, fetchSummary: fetchSummary,
    enqueue: enqueue, uploadOne: uploadOne, syncAll: syncAll, pruneDone: pruneDone, applyResponse: applyResponse, isDue: isDue, backoffMs: backoffMs
  };
})(typeof self !== 'undefined' ? self : this);
