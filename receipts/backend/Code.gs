/**
 * Household Receipts — Apps Script backend  (v1.1)
 * ---------------------------------------------------------------
 * The phone app posts receipts here (photos, long screenshots cut into slices,
 * or PDF receipts). This script:
 *   1. checks the file hasn't been filed already (so retries never double-file)
 *   2. saves it to a Drive folder
 *   3. reads the receipt with Claude — store, date, every line item, taxes, total
 *   4. catches the same purchase filed twice (same store, date, total, time/items)
 *   5. files it into the "Household Receipts" Google Sheet (Receipts + Items tabs)
 *   6. matches it against uploaded bank transactions (Bank tab)
 *   7. serves the dashboard feed back to the app (doGet ?action=summary)
 *
 * Bank statements (CSV export, PDF statement, or screenshots of the banking app)
 * are posted with action=bank. Every charge is matched to a receipt; charges with
 * no receipt are listed in the app, where one tap files them as an expense
 * ("Add as expense", remembered as a rule) or marks them "Not spending".
 *
 * ONE-TIME SETUP (in the Apps Script editor):
 *   1. Project Settings → Script Properties → add  ANTHROPIC_API_KEY = sk-ant-...
 *   2. Select the function  setup  and press Run (accept the permissions prompt).
 *      It creates the Sheet + Drive folder and prints your join word in the log.
 *   3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   4. Paste the web app URL into the phone app (DEFAULTS.url in index.html, or Settings).
 */

const CONFIG = {
  SHEET_NAME: 'Household Receipts',
  FOLDER_NAME: 'Household Receipts (photos)',
  PAGES_FOLDER: '_pages',               // slices of long screenshots live here (one file per slice)
  DEFAULT_MODEL: 'claude-sonnet-5-5',   // override with script property CLAUDE_MODEL
  DEFAULT_THINKING: 'off',              // 'off' = no up-front thinking (fast, cheap); 'adaptive' lets the model think first. Script property CLAUDE_THINKING overrides.
  DEFAULT_EFFORT: 'medium',             // low | medium | high. Script property CLAUDE_EFFORT overrides.
  DEFAULT_TOKEN: 'prairie482',          // the join word baked into the phone app; rotateJoinWord() changes it
  MAX_TOKENS: 8000,
  BANK_MAX_TOKENS: 12000,
  TZ: 'America/Edmonton',
  CURRENCY: 'CAD',
  CATEGORIES: [
    'Groceries', 'Dining & Takeout', 'Fuel', 'Vehicle', 'Household Supplies',
    'Home & Hardware', 'Clothing', 'Health & Pharmacy', 'Personal Care',
    'Kids & Baby', 'Pets', 'Entertainment', 'Electronics', 'Gifts', 'Travel',
    'Alcohol & Tobacco', 'Office & Stationery', 'Farm & Ranch',
    'Utilities & Bills', 'Phone & Internet', 'Insurance', 'Subscriptions & Memberships',
    'Bank Fees & Interest', 'Other'
  ],
  STORE_TYPES: [
    'Grocery', 'Gas Station', 'Restaurant', 'Hardware', 'Pharmacy',
    'Department Store', 'Online', 'Farm Supply', 'Clothing', 'Other'
  ],
  TABS: {
    RECEIPTS: 'Receipts',
    ITEMS: 'Items',
    BANK: 'Bank',
    RULES: 'Bank Rules',
    BUDGETS: 'Budgets',
    CATEGORIES: 'Categories',
    LOG: 'Log'
  },
  RECEIPT_HEADERS: [
    'Receipt ID', 'Date', 'Time', 'Store', 'Store Type', 'Item Count', 'Subtotal',
    'GST/HST', 'Other Tax', 'Tip', 'Total', 'Payment', 'Who', 'Status',
    'Needs Review', 'Review Notes', 'Photo', 'Hash', 'Captured At', 'Filed At',
    'Photo File ID', 'Confidence', 'Source', 'Pages', 'Duplicate Of', 'Bank Txn', 'Match Note'
  ],
  ITEM_HEADERS: [
    'Receipt ID', 'Date', 'Store', 'Item', 'Qty', 'Unit Price', 'Line Total',
    'Category', 'Who', 'Notes'
  ],
  BANK_HEADERS: [
    'Txn ID', 'Date', 'Description', 'Amount', 'Direction', 'Account', 'Source File',
    'Status', 'Receipt ID', 'Note', 'Uploaded At'
  ],
  RULE_HEADERS: ['Pattern', 'Action', 'Category', 'Added'],
  BUDGET_HEADERS: ['Category', 'Monthly Budget', 'Proposed', 'Updated'],
  MATCH_WINDOW_BEFORE: 1,   // a bank charge may be dated up to 1 day before the receipt (time zones)
  MATCH_WINDOW_AFTER: 6,    // ...or post up to 6 days after the purchase
  ITEMS_MONTHS: 15,         // how many months of line items the dashboard feed carries
  NO_RECEIPT_DAYS: 120      // how far back "charges with no receipt" are listed
};

// Column numbers (1-based) in the Receipts tab — keep in sync with RECEIPT_HEADERS
const RC = {
  ID: 1, DATE: 2, TIME: 3, STORE: 4, STORE_TYPE: 5, ITEM_COUNT: 6, SUBTOTAL: 7,
  GST: 8, OTHER_TAX: 9, TIP: 10, TOTAL: 11, PAYMENT: 12, WHO: 13, STATUS: 14,
  NEEDS_REVIEW: 15, REVIEW_NOTES: 16, PHOTO: 17, HASH: 18, CAPTURED_AT: 19,
  FILED_AT: 20, FILE_ID: 21, CONFIDENCE: 22, SOURCE: 23, PAGES: 24, DUP_OF: 25,
  BANK_TXN: 26, MATCH_NOTE: 27
};
// Bank tab columns
const BC = { ID: 1, DATE: 2, DESC: 3, AMOUNT: 4, DIR: 5, ACCOUNT: 6, SOURCE: 7, STATUS: 8, RECEIPT: 9, NOTE: 10, UPLOADED: 11 };

/* ===================================================================
 *  SETUP + MAINTENANCE (run from the editor)
 * =================================================================== */

/** Run once. Creates the Sheet, the photo folder and a join word, then logs them. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = getSpreadsheet_();
  ensureTabs_(ss);
  const folder = getFolder_();

  if (!props.getProperty('APP_TOKEN')) {
    props.setProperty('APP_TOKEN', CONFIG.DEFAULT_TOKEN);
  }

  const lines = [
    '',
    '=== Household Receipts backend is ready ===',
    'Sheet:      ' + ss.getUrl(),
    'Photos:     ' + folder.getUrl(),
    'Join word:  ' + props.getProperty('APP_TOKEN'),
    'Model:      ' + getModel_(),
    'Claude key: ' + (props.getProperty('ANTHROPIC_API_KEY') ? 'set' : 'MISSING — add ANTHROPIC_API_KEY in Project Settings → Script Properties'),
    'Time zone:  ' + Session.getScriptTimeZone() + (Session.getScriptTimeZone() === CONFIG.TZ ? '' : '  (set appsscript.json timeZone to ' + CONFIG.TZ + ')'),
    '',
    'Next: Deploy → New deployment → Web app (Execute as Me, Anyone), then put the',
    'web app URL into the phone app.'
  ];
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** Optional: run to confirm the Claude key works (logs the reply). */
function testClaudeKey() {
  const res = callClaude_([{ type: 'text', text: 'Return ONLY this JSON: {"ok": true}' }], 200);
  const u = (res.raw && res.raw.usage) || {};
  Logger.log('Claude replied: ' + res.text + '   (model ' + getModel_() + ', output tokens ' + u.output_tokens + ', thinking tokens ' + ((u.output_tokens_details || {}).thinking_tokens || 0) + ')');
  return res.text;
}

/** Optional: prints a new join word (old links stop working). */
function rotateJoinWord() {
  const w = makeJoinWord_();
  PropertiesService.getScriptProperties().setProperty('APP_TOKEN', w);
  Logger.log('New join word: ' + w);
  return w;
}

/** Optional: re-run extraction on every receipt whose status is "error". */
function retryErrors() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const last = sh.getLastRow();
  if (last < 2) return 'nothing to retry';
  const statuses = sh.getRange(2, RC.STATUS, last - 1, 1).getValues();
  let n = 0;
  for (let i = 0; i < statuses.length; i++) {
    if (String(statuses[i][0]) === 'error') {
      const row = i + 2;
      const existing = readReceiptRow_(sh, row);
      try {
        processExisting_(ss, sh, existing);
        n++;
      } catch (err) {
        log_('warn', 'retryErrors row ' + row + ': ' + err);
      }
    }
  }
  Logger.log('Retried ' + n + ' receipt(s)');
  return n;
}

/** Optional: re-run bank matching over everything (safe to run any time). */
function rematchAll() {
  const ss = getSpreadsheet_();
  const out = reconcile_(ss);
  Logger.log(JSON.stringify(out));
  return out;
}

/* ===================================================================
 *  WEB APP ENTRY POINTS
 * =================================================================== */

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (!checkToken_(p.token)) return json_({ ok: false, error: 'bad_token', message: 'Join word is wrong.' });
    const action = p.action || 'ping';
    if (action === 'ping') return json_(ping_());
    if (action === 'summary') return json_(buildSummary_());
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    log_('error', 'doGet: ' + err + (err.stack ? '\n' + err.stack : ''));
    return json_({ ok: false, error: 'server_error', message: String(err), retryable: true });
  }
}

function doPost(e) {
  let payload = {};
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json', message: 'Could not read the request.' });
  }
  try {
    if (!checkToken_(payload.token)) return json_({ ok: false, error: 'bad_token', message: 'Join word is wrong.' });
    const action = payload.action || 'receipt';
    if (action === 'ping') return json_(ping_());
    if (action === 'receipt') return json_(handleReceipt_(payload));
    if (action === 'bank') return json_(handleBank_(payload));
    if (action === 'bank_action') return json_(handleBankAction_(payload));
    if (action === 'resolve') return json_(handleResolve_(payload));
    if (action === 'review') return json_(handleReview_(payload));
    if (action === 'budget') return json_(handleBudget_(payload));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    log_('error', 'doPost ' + (payload.action || '') + ': ' + err + (err.stack ? '\n' + err.stack : ''));
    return json_({ ok: false, error: 'server_error', message: String(err), retryable: true });
  }
}

function ping_() {
  const props = PropertiesService.getScriptProperties();
  const ss = getSpreadsheet_();
  return {
    ok: true,
    version: '1.1',
    sheetUrl: ss.getUrl(),
    model: getModel_(),
    claudeKey: !!props.getProperty('ANTHROPIC_API_KEY'),
    time: new Date().toISOString()
  };
}

/* ===================================================================
 *  RECEIPT PIPELINE
 * =================================================================== */

/**
 * payload: { token, action:'receipt', hash, image (base64, no data: prefix), mime,
 *            kind: 'photo' | 'screenshot' | 'pdf',
 *            pages: [base64 jpeg slices] (long screenshots only; `image` is then the
 *            whole screenshot for Drive and `pages` are what Claude reads),
 *            who, capturedAt (ISO), clientId }
 */
function handleReceipt_(payload) {
  const hash = String(payload.hash || '').trim();
  const image = String(payload.image || '');
  if (!hash || hash.length < 16) return { ok: false, error: 'bad_request', message: 'Missing photo hash.' };
  if (!image && !payload.retryOnly) return { ok: false, error: 'bad_request', message: 'Missing photo.' };

  const ss = getSpreadsheet_();
  ensureTabs_(ss);
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const who = cleanWho_(payload.who);
  const capturedAt = parseIso_(payload.capturedAt) || new Date();
  const kind = cleanKind_(payload.kind, payload.mime);
  const pages = Array.isArray(payload.pages) ? payload.pages.filter(function (p) { return p && String(p).length > 100; }) : [];

  // ---- Phase 1 (under lock): dedupe + reserve a row ----------------------
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let existing, receiptId;
  try {
    existing = findReceiptByHash_(sh, hash);
    if (existing) {
      if (existing.status === 'ok' || existing.status === 'not_a_receipt' || existing.status === 'duplicate') {
        return receiptResponse_(ss, existing, true);
      }
      // 'processing' = another request is on it right now (or died). If it is
      // older than 10 minutes treat it as dead and take it over.
      if (existing.status === 'processing' && (Date.now() - existing.filedAtMs) < 10 * 60 * 1000) {
        return { ok: false, error: 'in_progress', retryable: true, message: 'Already being filed, try again shortly.' };
      }
      receiptId = existing.id;
      sh.getRange(existing.row, RC.STATUS).setValue('processing');
      sh.getRange(existing.row, RC.FILED_AT).setValue(new Date());
    } else {
      receiptId = makeReceiptId_(capturedAt);
      const row = new Array(CONFIG.RECEIPT_HEADERS.length).fill('');
      row[RC.ID - 1] = receiptId;
      row[RC.DATE - 1] = noon_(capturedAt);
      row[RC.WHO - 1] = who;
      row[RC.STATUS - 1] = 'processing';
      row[RC.HASH - 1] = hash;
      row[RC.CAPTURED_AT - 1] = capturedAt;
      row[RC.FILED_AT - 1] = new Date();
      row[RC.SOURCE - 1] = kind;
      row[RC.PAGES - 1] = pages.length || 1;
      sh.appendRow(row);
      existing = readReceiptRow_(sh, sh.getLastRow());
    }
  } finally {
    lock.releaseLock();
  }

  // ---- Phase 2 (no lock): save the file(s) if we don't have them yet ------
  if (!existing.fileId) {
    if (!image) {
      sh.getRange(existing.row, RC.STATUS).setValue('error');
      return { ok: false, error: 'no_photo', retryable: true, message: 'Photo missing on the server; resend it.' };
    }
    const file = saveFile_(image, payload.mime, receiptId, kind);
    existing.fileId = file.getId();
    existing.photoUrl = file.getUrl();
    sh.getRange(existing.row, RC.FILE_ID).setValue(existing.fileId);
    sh.getRange(existing.row, RC.PHOTO).setValue(existing.photoUrl);
    if (pages.length > 1) {
      savePages_(pages, receiptId);
      sh.getRange(existing.row, RC.PAGES).setValue(pages.length);
      existing.pages = pages.length;
    }
  }
  existing.who = existing.who || who;
  existing.capturedAt = existing.capturedAt || capturedAt;
  existing.source = existing.source || kind;

  // ---- Phase 3: read it with Claude and file it --------------------------
  return processExisting_(ss, sh, existing, pages.length > 1 ? pages : null);
}

/** Reads the saved file with Claude and files the result. Returns the API response. */
function processExisting_(ss, sh, existing, pagesB64) {
  const file = DriveApp.getFileById(existing.fileId);
  const blob = file.getBlob();
  const mime = blob.getContentType() || 'image/jpeg';
  const capturedAt = existing.capturedAt instanceof Date ? existing.capturedAt : (parseIso_(existing.capturedAt) || new Date());
  const kind = existing.source || cleanKind_('', mime);

  // What Claude reads: PDF as a document; a long screenshot as its slices; a photo as itself
  let blocks = [];
  if (mime === 'application/pdf') {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(blob.getBytes()) } });
  } else {
    let pages = pagesB64;
    if (!pages && existing.pages > 1) pages = loadPages_(existing.id);
    if (pages && pages.length > 1) {
      pages.forEach(function (p, i) {
        blocks.push({ type: 'text', text: 'Slice ' + (i + 1) + ' of ' + pages.length + (i === 0 ? ' (top)' : (i === pages.length - 1 ? ' (bottom)' : '')) + ':' });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(p).replace(/^data:[^;]+;base64,/, '') } });
      });
    } else {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: Utilities.base64Encode(blob.getBytes()) } });
    }
  }

  let parsed;
  try {
    parsed = extractReceipt_(blocks, kind, capturedAt, blocks.length > 1 ? Math.ceil(blocks.length / 2) : 1);
  } catch (err) {
    log_('error', 'extract ' + existing.id + ': ' + err);
    sh.getRange(existing.row, RC.STATUS).setValue('error');
    sh.getRange(existing.row, RC.REVIEW_NOTES).setValue('Read failed: ' + String(err).slice(0, 200));
    // A 4xx from the API (other than rate limiting) means this file will fail the same way next time
    const permanent = /Claude API 4(?!29)\d\d/.test(String(err));
    return {
      ok: false, error: 'extract_failed', retryable: !permanent,
      message: permanent ? 'The receipt reader rejected this file (' + String(err).slice(0, 120) + ')' : 'Could not read the receipt right now. It is saved and will be retried.'
    };
  }

  if (parsed.is_receipt === false) {
    sh.getRange(existing.row, RC.STATUS).setValue('not_a_receipt');
    sh.getRange(existing.row, RC.REVIEW_NOTES).setValue(parsed.notes || 'File did not look like a receipt');
    sh.getRange(existing.row, RC.FILED_AT).setValue(new Date());
    try { file.setName('NOT A RECEIPT ' + existing.id + extFor_(mime)); } catch (e) {}
    return { ok: true, status: 'not_a_receipt', receiptId: existing.id, message: 'That did not look like a receipt.', duplicate: false };
  }

  const rec = normalizeReceipt_(parsed, capturedAt);
  rec.id = existing.id;
  rec.who = existing.who;
  rec.hash = existing.hash;
  rec.photoUrl = existing.photoUrl;
  rec.fileId = existing.fileId;
  rec.capturedAt = capturedAt;
  rec.source = kind;
  rec.pages = existing.pages || 1;

  // Same purchase already filed from a different photo / phone / screenshot?
  const dup = findSemanticDuplicate_(ss, sh, rec, existing.row);
  if (dup) {
    rec.duplicateOf = dup.id;
    rec.duplicateStrength = dup.strong ? 'strong' : 'possible';
    if (!dup.strong) {
      rec.needsReview = true;
      rec.reviewNotes = ['Possible duplicate of ' + dup.id + ' (' + dup.store + ' ' + dup.date + ' $' + Number(dup.total).toFixed(2) + ')'].concat(rec.reviewNotes ? [rec.reviewNotes] : []).join('; ');
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeReceipt_(ss, sh, existing.row, rec, dup && dup.strong ? 'duplicate' : 'ok');
  } finally {
    lock.releaseLock();
  }

  try {
    const prefix = dup && dup.strong ? 'DUPLICATE ' : '';
    file.setName(safeName_(prefix + rec.date + ' ' + rec.store + ' $' + rec.total.toFixed(2) + ' (' + rec.id + ')' + extFor_(mime)));
  } catch (e) { /* cosmetic */ }

  // Line it up with the bank (only receipts that count)
  if (!(dup && dup.strong)) {
    try { reconcile_(ss, { receiptIds: [rec.id] }); } catch (e) { log_('warn', 'reconcile after ' + rec.id + ': ' + e); }
  }

  return {
    ok: true,
    status: 'ok',
    duplicate: false,
    duplicateOf: rec.duplicateOf || '',
    duplicateStrength: rec.duplicateStrength || '',
    receiptId: rec.id,
    receipt: publicReceipt_(rec)
  };
}

/** Response for a receipt that was already filed (idempotent retry). */
function receiptResponse_(ss, existing, duplicate) {
  if (existing.status === 'not_a_receipt') {
    return { ok: true, status: 'not_a_receipt', receiptId: existing.id, duplicate: duplicate, message: 'That did not look like a receipt.' };
  }
  const items = readItemsFor_(ss, existing.id);
  return {
    ok: true,
    status: 'ok',
    duplicate: duplicate,
    duplicateOf: existing.dupOf || '',
    duplicateStrength: existing.dupOf ? (existing.status === 'duplicate' ? 'strong' : 'possible') : '',
    receiptId: existing.id,
    receipt: {
      id: existing.id,
      date: existing.date,
      time: existing.time,
      store: existing.store,
      storeType: existing.storeType,
      total: existing.total,
      subtotal: existing.subtotal,
      gst: existing.gst,
      otherTax: existing.otherTax,
      tip: existing.tip,
      payment: existing.payment,
      who: existing.who,
      needsReview: existing.needsReview,
      reviewNotes: existing.reviewNotes,
      photoUrl: existing.photoUrl,
      source: existing.source,
      items: items
    }
  };
}

function publicReceipt_(rec) {
  return {
    id: rec.id,
    date: rec.date,
    time: rec.time,
    store: rec.store,
    storeType: rec.storeType,
    total: rec.total,
    subtotal: rec.subtotal,
    gst: rec.gst,
    otherTax: rec.otherTax,
    tip: rec.tip,
    payment: rec.payment,
    who: rec.who,
    needsReview: rec.needsReview,
    reviewNotes: rec.reviewNotes,
    confidence: rec.confidence,
    photoUrl: rec.photoUrl,
    source: rec.source,
    items: rec.items.map(function (it) {
      return { name: it.name, qty: it.qty, unitPrice: it.unitPrice, lineTotal: it.lineTotal, category: it.category };
    })
  };
}

/* ===================================================================
 *  DUPLICATES (same purchase, different file)
 * =================================================================== */

/**
 * Looks for an already-filed receipt with the same store, date and total.
 * Returns null, or { id, store, date, total, strong }:
 *   strong   = same time printed on both, or the same line items → filed twice; not counted
 *   possible = time differs/unknown and items differ → counted, but flagged for a look
 */
function findSemanticDuplicate_(ss, sh, rec, excludeRow) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, 1, last - 1, CONFIG.RECEIPT_HEADERS.length).getValues();
  const myStore = normStore_(rec.store);
  const myItems = itemKeys_(rec.items);
  let best = null;
  for (let i = 0; i < vals.length; i++) {
    const row = i + 2;
    if (row === excludeRow) continue;
    const v = vals[i];
    if (String(v[RC.STATUS - 1]) !== 'ok') continue;
    const total = num_(v[RC.TOTAL - 1]);
    if (total === null || Math.abs(total - rec.total) > 0.011) continue;
    const d = v[RC.DATE - 1];
    const date = d instanceof Date ? Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd') : String(d || '');
    if (date !== rec.date) continue;
    const store = String(v[RC.STORE - 1] || '');
    if (!storesSimilar_(myStore, normStore_(store))) continue;

    const otherTime = String(v[RC.TIME - 1] || '');
    let strong = false;
    if (rec.time && otherTime && minutesApart_(rec.time, otherTime) <= 2) strong = true;
    if (!strong && rec.time && otherTime && minutesApart_(rec.time, otherTime) > 2) {
      // Both have a time and they differ: two separate purchases (two coffees). Not a duplicate.
      continue;
    }
    if (!strong) {
      const otherItems = itemKeys_(readItemsFor_(ss, String(v[RC.ID - 1])));
      const overlap = itemOverlap_(myItems, otherItems);
      if (myItems.length && otherItems.length && myItems.length === otherItems.length && overlap >= 0.8) strong = true;
      else if (myItems.length && otherItems.length && overlap < 0.5 && myItems.length >= 3 && otherItems.length >= 3) continue; // clearly different baskets
    }
    const cand = { id: String(v[RC.ID - 1]), store: store, date: date, total: total, strong: strong };
    if (!best || (strong && !best.strong)) best = cand;
    if (best.strong) break;
  }
  return best;
}

function itemKeys_(items) {
  return (items || []).map(function (it) {
    return String(it.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + round2_(it.lineTotal).toFixed(2);
  });
}

function itemOverlap_(a, b) {
  if (!a.length || !b.length) return 0;
  const set = {};
  b.forEach(function (k) { set[k] = (set[k] || 0) + 1; });
  let hit = 0;
  a.forEach(function (k) { if (set[k]) { set[k]--; hit++; } });
  return hit / Math.max(a.length, b.length);
}

function minutesApart_(t1, t2) {
  const m1 = /^(\d{1,2}):(\d{2})/.exec(t1), m2 = /^(\d{1,2}):(\d{2})/.exec(t2);
  if (!m1 || !m2) return 9999;
  return Math.abs((Number(m1[1]) * 60 + Number(m1[2])) - (Number(m2[1]) * 60 + Number(m2[2])));
}

/** Store names reduced to something comparable: "Costco Wholesale #123" → "costco" */
function normStore_(s) {
  let t = String(s || '').toLowerCase();
  t = t.replace(/\.(ca|com)\b/g, ' ');
  t = t.replace(/[^a-z0-9]+/g, ' ');
  t = t.replace(/\b(inc|ltd|llc|co|the|store|stores|wholesale|canada|supercentre|supercenter|market|markets|limited|corp|corporation|company|and|of)\b/g, ' ');
  t = t.replace(/\b\d+\b/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function storesSimilar_(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return true;
  const fa = a.split(' ')[0], fb = b.split(' ')[0];
  return fa.length >= 4 && fa === fb;
}

/** App action: resolve a flagged duplicate. { receiptId, decision: 'keep' | 'remove' } */
function handleResolve_(payload) {
  const id = String(payload.receiptId || '').trim();
  const decision = String(payload.decision || '').trim();
  if (!id || (decision !== 'keep' && decision !== 'remove')) return { ok: false, error: 'bad_request', message: 'Need receiptId and decision.' };
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const ex = findReceiptById_(sh, id);
  if (!ex) return { ok: false, error: 'not_found', message: 'Receipt not found.' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (decision === 'keep') {
      sh.getRange(ex.row, RC.STATUS).setValue('ok');
      sh.getRange(ex.row, RC.DUP_OF).setValue('');
      const notes = ex.reviewNotes.split(';').map(function (s) { return s.trim(); }).filter(function (s) { return s && !/^Possible duplicate/i.test(s); });
      sh.getRange(ex.row, RC.REVIEW_NOTES).setValue(notes.join('; '));
      sh.getRange(ex.row, RC.NEEDS_REVIEW).setValue(notes.length ? 'YES' : '');
    } else {
      sh.getRange(ex.row, RC.STATUS).setValue('duplicate');
      sh.getRange(ex.row, RC.NEEDS_REVIEW).setValue('');
      sh.getRange(ex.row, RC.BANK_TXN).setValue('');
      sh.getRange(ex.row, RC.MATCH_NOTE).setValue('');
    }
  } finally {
    lock.releaseLock();
  }
  try {
    const file = DriveApp.getFileById(ex.fileId);
    const name = file.getName().replace(/^DUPLICATE /, '');
    file.setName(decision === 'remove' ? 'DUPLICATE ' + name : name);
  } catch (e) { /* cosmetic */ }
  try { reconcile_(ss); } catch (e) { log_('warn', 'reconcile after resolve: ' + e); }
  return { ok: true, receiptId: id, status: decision === 'keep' ? 'ok' : 'duplicate' };
}

/** App action: "Looks right" — clears the needs-review flag. { receiptId } */
function handleReview_(payload) {
  const id = String(payload.receiptId || '').trim();
  if (!id) return { ok: false, error: 'bad_request', message: 'Need receiptId.' };
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const ex = findReceiptById_(sh, id);
  if (!ex) return { ok: false, error: 'not_found', message: 'Receipt not found.' };
  sh.getRange(ex.row, RC.NEEDS_REVIEW).setValue('');
  sh.getRange(ex.row, RC.REVIEW_NOTES).setValue((ex.reviewNotes ? ex.reviewNotes + ' ' : '') + '(checked ' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd') + ')');
  return { ok: true, receiptId: id };
}

/* ===================================================================
 *  CLAUDE EXTRACTION
 * =================================================================== */

function extractReceipt_(blocks, kind, capturedAt, sliceCount) {
  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const captured = Utilities.formatDate(capturedAt, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
  const cats = getCategories_();

  const what = kind === 'pdf' ? 'this PDF receipt / order confirmation / invoice'
    : (kind === 'screenshot' ? 'this screenshot of a receipt, order confirmation or order summary' : 'this receipt photo');

  const instructions = [
    'Read ' + what + ' and return ONLY a JSON object — no markdown, no commentary — with exactly this shape:',
    '{',
    '  "is_receipt": true,',
    '  "store": "store or website name, cleaned up (e.g. Costco, Safeway, Peavey Mart, Tim Hortons, Amazon.ca)",',
    '  "store_type": one of ' + JSON.stringify(CONFIG.STORE_TYPES) + ',',
    '  "date": "YYYY-MM-DD" or null,',
    '  "time": "HH:MM" (24h) or null,',
    '  "currency": "CAD" unless the receipt clearly shows another currency,',
    '  "items": [ { "name": "plain-English item name", "qty": number, "unit_price": number or null, "line_total": number, "category": one of ' + JSON.stringify(cats) + ' } ],',
    '  "subtotal": number or null,',
    '  "gst": number or null,',
    '  "other_tax": number or null,',
    '  "tip": number or null,',
    '  "total": number,',
    '  "payment": "Visa" | "Mastercard" | "Debit" | "Cash" | "Amex" | "Gift card" | "PayPal" | other | null,',
    '  "confidence": number between 0 and 1,',
    '  "notes": "one short line about anything you were unsure of, or empty"',
    '}',
    '',
    'Rules:',
    '- Every purchased line becomes one item. Expand abbreviations into plain English ("ORG BNNA" -> "Organic bananas", "PC WHL MLK 4L" -> "PC whole milk 4L").',
    '- line_total is the price actually charged for that line (after any instant discount shown on the same line). qty is 1 unless the receipt shows a quantity; for weighed goods use qty 1 and put the weight in the name.',
    '- Discounts, coupons and member savings that appear as their own line become items with a NEGATIVE line_total and a name starting with "Discount:".',
    '- Bottle deposits, enviro fees, bag fees, shipping/delivery charges and tips-on-receipt are their own items (category Other; shipping is category Other).',
    '- Taxes (GST, HST, PST, QST) are NOT items; put them in gst / other_tax. HST goes in gst.',
    '- total is the amount actually paid (the grand total / order total). subtotal is the pre-tax subtotal if printed.',
    '- Category is about what the item is, not where it was bought: a hammer from Walmart is Home & Hardware; a sandwich from a gas station is Dining & Takeout.',
    '- For online orders: store is the website/seller, date is the order date, payment is the card shown. If the page shows several separate orders, transcribe the one with the most detail and say in notes that others were present.',
    '- If part of it is unreadable, make your best guess and lower confidence.',
    '- If it is not a receipt at all (or shows nothing purchased), return {"is_receipt": false, "notes": "why"}.'
  ];
  if (sliceCount > 1) {
    instructions.push('- The ' + sliceCount + ' images are consecutive slices of ONE long screenshot, top to bottom, with a little overlap between neighbours. Read them as one page; a line that appears at the bottom of one slice and the top of the next is the same line — count it once.');
  }
  instructions.push('', 'Today is ' + today + ' (Mountain Time). The file was captured ' + captured + '. Most receipts are dated the same day or a few days earlier.');

  const content = blocks.concat([{ type: 'text', text: instructions.join('\n') }]);
  const res = callClaude_(content, CONFIG.MAX_TOKENS);
  const obj = parseJsonLoose_(res.text);
  if (!obj || typeof obj !== 'object') throw new Error('Claude returned no JSON');
  return obj;
}

/** Calls the Messages API with retries on rate limit / overload. Returns {text, raw}. */
function callClaude_(content, maxTokens) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (Project Settings → Script Properties)');

  const body = {
    model: getModel_(),
    max_tokens: maxTokens || CONFIG.MAX_TOKENS,
    system: 'You are a meticulous bookkeeper who transcribes retail receipts and bank statements for a Canadian household budget. You always answer with valid JSON only.',
    messages: [{ role: 'user', content: content }]
  };
  // Thinking is on by default for current models and counts against max_tokens; transcription does not need it.
  const props = PropertiesService.getScriptProperties();
  const thinking = String(props.getProperty('CLAUDE_THINKING') || CONFIG.DEFAULT_THINKING).toLowerCase();
  const effort = String(props.getProperty('CLAUDE_EFFORT') || CONFIG.DEFAULT_EFFORT).toLowerCase();
  if (thinking === 'adaptive') body.thinking = { type: 'adaptive' };
  else if (thinking !== 'default') body.thinking = { type: 'between_tools' };
  if (effort !== 'default') body.output_config = { effort: effort };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
    const code = resp.getResponseCode();
    const text = resp.getContentText();
    if (code >= 200 && code < 300) {
      const data = JSON.parse(text);
      const out = (data.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
      return { text: out, raw: data };
    }
    lastErr = 'Claude API ' + code + ': ' + text.slice(0, 300);
    if (code === 429 || code === 529 || code >= 500) {
      Utilities.sleep(2500 * (attempt + 1));
      continue;
    }
    break; // 4xx other than rate limit: don't retry
  }
  throw new Error(lastErr);
}

/** Pulls the first {...} object out of a model reply, tolerating code fences and chatter. */
function parseJsonLoose_(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* fall through */ }
  }
  return null;
}

/* ===================================================================
 *  NORMALIZE + VALIDATE
 * =================================================================== */

function normalizeReceipt_(raw, capturedAt) {
  const notes = [];
  const cats = getCategories_();
  const catSet = {};
  cats.forEach(function (c) { catSet[c.toLowerCase()] = c; });

  const items = (Array.isArray(raw.items) ? raw.items : []).map(function (it) {
    const name = String((it && it.name) || '').trim() || 'Unlabelled item';
    const qty = num_(it && it.qty);
    const unit = num_(it && it.unit_price);
    let line = num_(it && it.line_total);
    if (line === null && unit !== null) line = round2_(unit * (qty || 1));
    if (line === null) { line = 0; notes.push('No price read for "' + name + '"'); }
    const catRaw = String((it && it.category) || '').trim().toLowerCase();
    const category = catSet[catRaw] || 'Other';
    return { name: name, qty: qty === null ? 1 : qty, unitPrice: unit, lineTotal: round2_(line), category: category };
  });

  const itemsSum = round2_(items.reduce(function (s, it) { return s + it.lineTotal; }, 0));
  let subtotal = num_(raw.subtotal);
  let gst = num_(raw.gst);
  let otherTax = num_(raw.other_tax);
  let tip = num_(raw.tip);
  let total = num_(raw.total);

  if (total === null) {
    total = round2_((subtotal !== null ? subtotal : itemsSum) + (gst || 0) + (otherTax || 0) + (tip || 0));
    notes.push('Total not read; computed from lines');
  }
  if (subtotal === null) subtotal = itemsSum;

  // Sanity checks
  const tolerance = Math.max(0.05, Math.abs(subtotal) * 0.01);
  if (items.length === 0) notes.push('No line items read');
  if (items.length && Math.abs(itemsSum - subtotal) > tolerance) {
    notes.push('Lines add to $' + itemsSum.toFixed(2) + ' but subtotal is $' + subtotal.toFixed(2));
  }
  const expectedTotal = round2_(subtotal + (gst || 0) + (otherTax || 0) + (tip || 0));
  if (Math.abs(expectedTotal - total) > Math.max(0.05, Math.abs(total) * 0.01)) {
    notes.push('Subtotal + tax = $' + expectedTotal.toFixed(2) + ' but total is $' + total.toFixed(2));
  }

  // Date
  let date = String(raw.date || '').trim();
  const captured = Utilities.formatDate(capturedAt, CONFIG.TZ, 'yyyy-MM-dd');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = captured;
    notes.push('Date not read; used photo date');
  } else {
    const d = dateFromYmd_(date);
    const capturedD = dateFromYmd_(captured);
    const diffDays = (capturedD - d) / 86400000;
    if (diffDays < -1) { notes.push('Receipt date ' + date + ' is in the future; used photo date'); date = captured; }
    else if (diffDays > 400) notes.push('Receipt date ' + date + ' is over a year old');
  }

  const confidence = num_(raw.confidence);
  if (confidence !== null && confidence < 0.7) notes.push('Low confidence (' + confidence + ')');
  if (raw.notes && String(raw.notes).trim()) notes.push(String(raw.notes).trim());

  const storeTypeRaw = String(raw.store_type || '').trim().toLowerCase();
  const storeType = CONFIG.STORE_TYPES.filter(function (s) { return s.toLowerCase() === storeTypeRaw; })[0] || 'Other';

  return {
    date: date,
    time: /^\d{1,2}:\d{2}/.test(String(raw.time || '')) ? String(raw.time) : '',
    store: String(raw.store || '').trim() || 'Unknown store',
    storeType: storeType,
    currency: String(raw.currency || CONFIG.CURRENCY).toUpperCase(),
    items: items,
    subtotal: subtotal,
    gst: gst,
    otherTax: otherTax,
    tip: tip,
    total: total,
    payment: String(raw.payment || '').trim(),
    confidence: confidence,
    needsReview: notes.length > 0,
    reviewNotes: notes.join('; ')
  };
}

/* ===================================================================
 *  BANK STATEMENTS
 * =================================================================== */

/**
 * payload: { token, action:'bank', kind: 'csv' | 'pdf' | 'image', data (CSV text, or base64),
 *            mime, name (file name), account (optional label), pages: [base64 slices] (tall screenshots) }
 */
function handleBank_(payload) {
  const kind = String(payload.kind || '').toLowerCase();
  const name = String(payload.name || '').slice(0, 80) || ('upload ' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm'));
  const accountLabel = String(payload.account || '').trim().slice(0, 40);
  const ss = getSpreadsheet_();
  ensureTabs_(ss);

  let parsed;
  if (kind === 'csv') {
    const text = String(payload.data || '');
    if (!text.trim()) return { ok: false, error: 'bad_request', message: 'The file was empty.' };
    parsed = parseBankCsv_(text);
  } else if (kind === 'pdf' || kind === 'image') {
    const blocks = [];
    if (kind === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: String(payload.data || '').replace(/^data:[^;]+;base64,/, '') } });
    } else {
      const pages = Array.isArray(payload.pages) && payload.pages.length ? payload.pages : [payload.data];
      pages.forEach(function (p, i) {
        if (pages.length > 1) blocks.push({ type: 'text', text: 'Slice ' + (i + 1) + ' of ' + pages.length + ':' });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: pages.length > 1 ? 'image/jpeg' : (String(payload.mime || 'image/jpeg')), data: String(p).replace(/^data:[^;]+;base64,/, '') } });
      });
    }
    parsed = extractBankTransactions_(blocks, kind, blocks.length);
  } else {
    return { ok: false, error: 'bad_request', message: 'kind must be csv, pdf or image.' };
  }

  if (!parsed.transactions.length) {
    return { ok: false, error: 'no_transactions', retryable: false, message: 'No transactions were found in that file.' + (parsed.note ? ' ' + parsed.note : '') };
  }
  const account = accountLabel || parsed.account || 'Bank';
  const result = importTransactions_(ss, parsed.transactions, name, account);
  result.ok = true;
  result.account = account;
  result.note = parsed.note || '';
  return result;
}

/** CSV export from online banking → [{date, desc, amount, dir}]. Claude maps the columns once; the numbers are parsed here. */
function parseBankCsv_(text) {
  let rows = Utilities.parseCsv(text.replace(/^﻿/, ''));
  rows = rows.filter(function (r) { return r && r.some(function (c) { return String(c).trim() !== ''; }); });
  if (!rows.length) return { transactions: [], account: '', note: 'Empty file' };
  // Some exports use semicolons
  if (rows.every(function (r) { return r.length === 1; }) && /;/.test(rows[0][0])) {
    rows = rows.map(function (r) { return String(r[0]).split(';'); });
  }
  const sample = rows.slice(0, 8);
  const mapping = mapCsvColumns_(sample);
  return applyCsvMapping_(rows, mapping);
}

function mapCsvColumns_(sample) {
  const prompt = [
    'Here are the first rows of a bank or credit card transaction export (CSV, parsed into cells). Tell me how to read it.',
    'Return ONLY a JSON object:',
    '{',
    '  "has_header": true or false,',
    '  "date_col": column index (0-based) of the transaction date,',
    '  "date_format": one of "YYYY-MM-DD", "YYYY/MM/DD", "YYYYMMDD", "MM/DD/YYYY", "DD/MM/YYYY", "MM-DD-YYYY", "DD-MM-YYYY", "MMM D, YYYY", "D MMM YYYY", "DD-MMM-YYYY", "MMM D", "ISO_DATETIME",',
    '  "description_cols": [column indexes that together describe the transaction, in order],',
    '  "amount_mode": "signed" or "debit_credit",',
    '  "amount_col": index (signed mode) or null,',
    '  "negative_is_out": true if in signed mode a NEGATIVE number means money going out (a purchase); false if positive means out,',
    '  "debit_col": index (debit_credit mode; money out) or null,',
    '  "credit_col": index (debit_credit mode; money in) or null,',
    '  "balance_col": index of a running balance column or null,',
    '  "account_col": index of a column holding the account / card number or null,',
    '  "account": "short label for the account if it can be told from the data (e.g. Visa 1234, Chequing), else null",',
    '  "notes": "anything unusual"',
    '}',
    'Hints: Canadian bank exports are usually month-first when the format is ambiguous (MM/DD/YYYY). On a credit card export, purchases are normally positive numbers in a "debit"/"amount" column and payments are in a credit column or negative.',
    '',
    'Rows:',
    JSON.stringify(sample)
  ].join('\n');
  const res = callClaude_([{ type: 'text', text: prompt }], 1200);
  const m = parseJsonLoose_(res.text);
  if (!m || typeof m !== 'object' || m.date_col == null) throw new Error('Could not understand the CSV layout');
  return m;
}

function applyCsvMapping_(rows, m) {
  const out = [];
  const start = m.has_header ? 1 : 0;
  const descCols = Array.isArray(m.description_cols) && m.description_cols.length ? m.description_cols : [1];
  let account = m.account ? String(m.account) : '';
  let skipped = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDateFlexible_(r[m.date_col], m.date_format);
    if (!date) { skipped++; continue; }
    const desc = descCols.map(function (c) { return String(r[c] || '').trim(); }).filter(Boolean).join(' ').replace(/\s+/g, ' ');
    let amount = null, dir = 'out';
    if (m.amount_mode === 'debit_credit') {
      const deb = num_(r[m.debit_col]);
      const cre = num_(r[m.credit_col]);
      if (deb !== null && deb !== 0) { amount = Math.abs(deb); dir = 'out'; }
      else if (cre !== null && cre !== 0) { amount = Math.abs(cre); dir = 'in'; }
    } else {
      const a = num_(r[m.amount_col]);
      if (a !== null && a !== 0) {
        amount = Math.abs(a);
        const neg = a < 0;
        dir = (m.negative_is_out ? neg : !neg) ? 'out' : 'in';
      }
    }
    if (amount === null) { skipped++; continue; }
    if (!account && m.account_col != null && r[m.account_col]) account = String(r[m.account_col]).replace(/\*+/g, '').slice(-8);
    out.push({ date: date, desc: desc || '(no description)', amount: round2_(amount), dir: dir });
  }
  return { transactions: out, account: account ? labelAccount_(account) : '', note: skipped ? skipped + ' row(s) skipped' : '' };
}

function labelAccount_(s) {
  s = String(s).trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8 && /^\d/.test(s)) return 'Card ' + digits.slice(-4);
  return s.slice(0, 40);
}

/** PDF statement or screenshot(s) → Claude transcribes the transactions. */
function extractBankTransactions_(blocks, kind, n) {
  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const prompt = [
    'This is ' + (kind === 'pdf' ? 'a bank or credit card statement (PDF)' : 'a screenshot of a banking app or online banking transaction list') + '.',
    'Transcribe EVERY transaction and return ONLY a JSON object:',
    '{',
    '  "account": "short label for the account if shown (e.g. CIBC Visa 1234, Chequing), else null",',
    '  "transactions": [ { "date": "YYYY-MM-DD", "description": "as shown, cleaned up", "amount": positive number, "direction": "out" | "in", "pending": true|false } ],',
    '  "notes": "anything unusual, or empty"',
    '}',
    'Rules:',
    '- direction "out" = money leaving the account: purchases, withdrawals, bill payments, transfers out, fees. "in" = deposits, refunds, payments received, transfers in.',
    '- amount is always positive; direction carries the sign.',
    '- Ignore running balances, opening/closing balance lines, minimum payment lines and totals.',
    '- If only a day and month are shown, use the most recent occurrence on or before today (' + today + '). If a statement period is shown, use its year.',
    '- Keep each transaction exactly once even if it appears twice (e.g. a pending and a posted copy): keep the posted one.',
    n > 1 ? '- The images are consecutive slices of ONE long screenshot, top to bottom, with a little overlap; a row cut across two slices is one transaction.' : '',
    'Today is ' + today + ' (Mountain Time).'
  ].filter(Boolean).join('\n');
  const res = callClaude_(blocks.concat([{ type: 'text', text: prompt }]), CONFIG.BANK_MAX_TOKENS);
  const obj = parseJsonLoose_(res.text);
  if (!obj || typeof obj !== 'object') throw new Error('Claude returned no JSON for the statement');
  const txns = (Array.isArray(obj.transactions) ? obj.transactions : []).map(function (t) {
    const date = parseDateFlexible_(t && t.date, 'YYYY-MM-DD');
    const amount = num_(t && t.amount);
    if (!date || amount === null || amount === 0) return null;
    return { date: date, desc: String((t && t.description) || '').trim() || '(no description)', amount: round2_(Math.abs(amount)), dir: String((t && t.direction) || 'out').toLowerCase() === 'in' ? 'in' : 'out' };
  }).filter(Boolean);
  return { transactions: txns, account: obj.account ? labelAccount_(String(obj.account)) : '', note: obj.notes ? String(obj.notes) : '' };
}

/** Writes new transactions to the Bank tab (skipping ones already there), applies rules, then matches receipts. */
function importTransactions_(ss, txns, sourceName, account) {
  const bsh = ss.getSheetByName(CONFIG.TABS.BANK);
  const existing = {};
  const last = bsh.getLastRow();
  if (last >= 2) {
    bsh.getRange(2, BC.ID, last - 1, 1).getValues().forEach(function (r) { existing[String(r[0])] = true; });
  }
  const rules = readRules_(ss);
  const seen = {};
  const rows = [];
  const out = { added: 0, already: 0, credits: 0, ignored: 0, autoExpense: 0, from: null, to: null };
  const toExpense = [];
  const now = new Date();

  txns.forEach(function (t) {
    const base = [account, t.date, t.desc.toUpperCase().replace(/\s+/g, ' ').trim(), t.amount.toFixed(2), t.dir].join('|');
    seen[base] = (seen[base] || 0) + 1;
    const id = 'T' + sha256Hex_(base + '|' + seen[base]).slice(0, 14);
    if (existing[id]) { out.already++; return; }
    existing[id] = true;
    let status = 'no_receipt', note = '';
    if (t.dir === 'in') { status = 'credit'; out.credits++; }
    else {
      const rule = matchRule_(rules, t.desc);
      if (rule && rule.action === 'ignore') { status = 'ignored'; note = 'rule'; out.ignored++; }
      else if (rule && rule.action === 'expense') { status = 'expense'; note = 'rule'; toExpense.push({ id: id, t: t, category: rule.category }); out.autoExpense++; }
    }
    rows.push([id, dateFromYmd_(t.date), t.desc, t.amount, t.dir, account, sourceName, status, '', note, now]);
    out.added++;
    if (!out.from || t.date < out.from) out.from = t.date;
    if (!out.to || t.date > out.to) out.to = t.date;
  });

  if (rows.length) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      bsh.getRange(bsh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
      toExpense.forEach(function (x) {
        const rid = createBankExpense_(ss, x.t, account, x.category, x.id);
        const row = findBankRow_(bsh, x.id);
        if (row) bsh.getRange(row, BC.RECEIPT).setValue(rid);
      });
    } finally {
      lock.releaseLock();
    }
  }
  const rec = reconcile_(ss);
  out.matched = rec.matchedNow;
  out.noReceipt = rec.noReceipt;
  out.noReceiptTotal = rec.noReceiptTotal;
  return out;
}

/** A bank charge filed as an expense without a receipt: one receipt row + one item line. */
function createBankExpense_(ss, t, account, category, txnId) {
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const id = 'B' + Utilities.formatDate(dateFromYmd_(t.date), CONFIG.TZ, 'yyyyMMdd') + '-' + txnId.slice(1, 6);
  const store = prettyDesc_(t.desc);
  const cats = getCategories_();
  const cat = cats.indexOf(category) >= 0 ? category : 'Other';
  const rec = {
    id: id, date: t.date, time: '', store: store, storeType: 'Other',
    items: [{ name: store, qty: 1, unitPrice: null, lineTotal: t.amount, category: cat }],
    subtotal: t.amount, gst: null, otherTax: null, tip: null, total: t.amount,
    payment: account, who: 'Bank', needsReview: false, reviewNotes: '',
    photoUrl: '', hash: 'bank:' + txnId, capturedAt: new Date(), fileId: '', confidence: null,
    source: 'bank', pages: 1, bankTxn: txnId, matchNote: 'from statement'
  };
  sh.appendRow([id]);                      // reserve a real (non-empty) row, then fill it in
  writeReceipt_(ss, sh, sh.getLastRow(), rec, 'ok');
  return id;
}

const DESC_WORDS_ = { AMZN: 'Amazon', MKTP: 'Marketplace', 'WAL-MART': 'Walmart', WALMART: 'Walmart', 'CDN TIRE': 'Canadian Tire', CANTIRE: 'Canadian Tire', RCSS: 'Real Canadian Superstore', SDM: 'Shoppers Drug Mart', PETROCAN: 'Petro-Canada', MCDONALDS: "McDonald's", 'MCDONALD S': "McDonald's" };

/** "COSTCO WHOLESALE W1234 GRANDE PRAIRIE AB" → "Costco Wholesale" (store-ish name from a bank description) */
function prettyDesc_(desc) {
  let s = ' ' + String(desc || '').toUpperCase() + ' ';
  s = s.replace(/^\s*(SQ|TST|SP|PAYPAL|PP|PY|APL|GOOGLE)\s*\*\s*/, ' ');       // payment-processor prefixes
  s = s.replace(/\*[A-Z0-9]+/g, ' ').replace(/#\s*\d+/g, ' ');                 // *2K4J7 refs, #123 store numbers
  s = s.replace(/\S*\d\S*/g, ' ');                                              // any token with a digit
  Object.keys(DESC_WORDS_).forEach(function (k) { s = s.replace(new RegExp('\\b' + k.replace(/[-]/g, '\\-') + '\\b', 'g'), ' ' + DESC_WORDS_[k].toUpperCase() + ' '); });
  s = s.replace(/\b(GRANDE PRAIRIE|PEACE RIVER|EDMONTON|CALGARY|FAIRVIEW|HIGH PRAIRIE|TORONTO|VANCOUVER|ONLINE|INTERNET|WWW|HTTPS?|COM)\b/g, ' ');
  for (let i = 0; i < 3; i++) s = s.replace(/(^|\s)(AB|BC|SK|MB|ON|QC|NB|NS|PE|NL|YT|NT|NU|CA|CAN|CANADA|USA|US)\s*$/, ' ').replace(/\s+$/, ' ');
  s = s.replace(/[^A-Z&'.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = String(desc || '').trim();
  const out = s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  return Object.keys(DESC_WORDS_).reduce(function (acc, k) {
    const nice = DESC_WORDS_[k];
    return acc.replace(new RegExp('\\b' + nice.replace(/[-'.]/g, function (c) { return '\\' + c; }) + '\\b', 'i'), nice);
  }, out).slice(0, 60);
}

/** App action on a bank charge. { txnId, do: 'expense' | 'ignore' | 'undo', category, remember } */
function handleBankAction_(payload) {
  const txnId = String(payload.txnId || '').trim();
  const what = String(payload['do'] || payload.action2 || '').trim();
  if (!txnId || ['expense', 'ignore', 'undo'].indexOf(what) < 0) return { ok: false, error: 'bad_request', message: 'Need txnId and do.' };
  const ss = getSpreadsheet_();
  const bsh = ss.getSheetByName(CONFIG.TABS.BANK);
  const row = findBankRow_(bsh, txnId);
  if (!row) return { ok: false, error: 'not_found', message: 'Transaction not found.' };
  const v = bsh.getRange(row, 1, 1, CONFIG.BANK_HEADERS.length).getValues()[0];
  const t = { date: ymd_(v[BC.DATE - 1]), desc: String(v[BC.DESC - 1] || ''), amount: num_(v[BC.AMOUNT - 1]) || 0, dir: String(v[BC.DIR - 1] || 'out') };
  const account = String(v[BC.ACCOUNT - 1] || 'Bank');
  const status = String(v[BC.STATUS - 1] || '');
  const linked = String(v[BC.RECEIPT - 1] || '');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (what === 'undo') {
      if (status === 'expense' && linked) removeBankExpense_(ss, linked);
      bsh.getRange(row, BC.STATUS).setValue(t.dir === 'in' ? 'credit' : 'no_receipt');
      bsh.getRange(row, BC.RECEIPT).setValue('');
      bsh.getRange(row, BC.NOTE).setValue('');
    } else if (what === 'ignore') {
      if (status === 'expense' && linked) removeBankExpense_(ss, linked);
      bsh.getRange(row, BC.STATUS).setValue('ignored');
      bsh.getRange(row, BC.RECEIPT).setValue('');
      bsh.getRange(row, BC.NOTE).setValue('not spending');
      if (payload.remember) addRule_(ss, t.desc, 'ignore', '');
    } else {
      if (status === 'matched') return { ok: false, error: 'already_matched', message: 'That charge already has a receipt.' };
      if (status === 'expense' && linked) removeBankExpense_(ss, linked);
      const category = String(payload.category || 'Other');
      const rid = createBankExpense_(ss, t, account, category, txnId);
      bsh.getRange(row, BC.STATUS).setValue('expense');
      bsh.getRange(row, BC.RECEIPT).setValue(rid);
      bsh.getRange(row, BC.NOTE).setValue('added in app');
      if (payload.remember) addRule_(ss, t.desc, 'expense', category);
    }
  } finally {
    lock.releaseLock();
  }
  if (what === 'undo') { try { reconcile_(ss); } catch (e) { /* best effort */ } }
  return { ok: true, txnId: txnId, status: String(bsh.getRange(row, BC.STATUS).getValue()) };
}

function removeBankExpense_(ss, receiptId) {
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const ex = findReceiptById_(sh, receiptId);
  if (!ex) return;
  deleteItemsFor_(ss.getSheetByName(CONFIG.TABS.ITEMS), receiptId);
  sh.deleteRow(ex.row);
}

/* ---- rules: "always file TELUS MOBILITY as Phone & Internet" ---- */

function rulePattern_(desc) {
  return String(desc || '').toUpperCase().replace(/[0-9#*]+/g, ' ').replace(/[^A-Z&' ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28);
}

function readRules_(ss) {
  const rsh = ss.getSheetByName(CONFIG.TABS.RULES);
  const last = rsh.getLastRow();
  if (last < 2) return [];
  return rsh.getRange(2, 1, last - 1, 3).getValues().map(function (r) {
    return { pattern: String(r[0] || '').trim().toUpperCase(), action: String(r[1] || '').trim().toLowerCase(), category: String(r[2] || '').trim() };
  }).filter(function (r) { return r.pattern && (r.action === 'expense' || r.action === 'ignore'); });
}

function matchRule_(rules, desc) {
  const p = rulePattern_(desc);
  if (!p) return null;
  let best = null;
  rules.forEach(function (r) {
    if (p === r.pattern || p.indexOf(r.pattern) === 0 || (r.pattern.length >= 8 && p.indexOf(r.pattern) >= 0)) {
      if (!best || r.pattern.length > best.pattern.length) best = r;
    }
  });
  return best;
}

function addRule_(ss, desc, action, category) {
  const p = rulePattern_(desc);
  if (!p) return;
  const rsh = ss.getSheetByName(CONFIG.TABS.RULES);
  const last = rsh.getLastRow();
  if (last >= 2) {
    const vals = rsh.getRange(2, 1, last - 1, 3).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim().toUpperCase() === p) {
        rsh.getRange(i + 2, 2, 1, 3).setValues([[action, category, new Date()]]);
        return;
      }
    }
  }
  rsh.appendRow([p, action, category, new Date()]);
}

/* ---- matching receipts ↔ bank charges ---- */

/**
 * Lines up receipts with bank charges: same amount (to the cent, or a restaurant tip on top),
 * charge dated within -1..+6 days of the receipt, store name as a tie-breaker. Existing
 * matches are kept; broken ones (receipt removed) are cleared. Returns counts.
 */
function reconcile_(ss, opts) {
  opts = opts || {};
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const bsh = ss.getSheetByName(CONFIG.TABS.BANK);
  const out = { matchedNow: 0, noReceipt: 0, noReceiptTotal: 0, unlinked: 0 };

  const lastB = bsh.getLastRow();
  const bank = [];
  if (lastB >= 2) {
    bsh.getRange(2, 1, lastB - 1, CONFIG.BANK_HEADERS.length).getValues().forEach(function (v, i) {
      bank.push({ row: i + 2, id: String(v[BC.ID - 1]), date: ymd_(v[BC.DATE - 1]), desc: String(v[BC.DESC - 1] || ''), amount: num_(v[BC.AMOUNT - 1]) || 0, dir: String(v[BC.DIR - 1] || 'out'), account: String(v[BC.ACCOUNT - 1] || ''), status: String(v[BC.STATUS - 1] || ''), receiptId: String(v[BC.RECEIPT - 1] || ''), note: String(v[BC.NOTE - 1] || '') });
    });
  }
  const lastR = sh.getLastRow();
  const receipts = [];
  if (lastR >= 2) {
    sh.getRange(2, 1, lastR - 1, CONFIG.RECEIPT_HEADERS.length).getValues().forEach(function (v, i) {
      const status = String(v[RC.STATUS - 1] || '');
      if (status !== 'ok' && status !== 'superseded') return;
      receipts.push({ row: i + 2, id: String(v[RC.ID - 1]), date: ymd_(v[RC.DATE - 1]), store: String(v[RC.STORE - 1] || ''), storeType: String(v[RC.STORE_TYPE - 1] || ''), total: num_(v[RC.TOTAL - 1]) || 0, tip: num_(v[RC.TIP - 1]), payment: String(v[RC.PAYMENT - 1] || ''), status: status, source: String(v[RC.SOURCE - 1] || 'photo'), bankTxn: String(v[RC.BANK_TXN - 1] || ''), note: String(v[RC.MATCH_NOTE - 1] || '') });
    });
  }
  if (!bank.length) { return out; }
  const bankById = {}; bank.forEach(function (b) { bankById[b.id] = b; });
  const recById = {}; receipts.forEach(function (r) { recById[r.id] = r; });
  const writes = [];   // [sheet, row, col, value]

  // 1. Clear links that no longer hold
  bank.forEach(function (b) {
    if (b.status === 'matched') {
      const r = recById[b.receiptId];
      if (!r || r.status !== 'ok' || r.source === 'bank') {
        b.status = 'no_receipt'; b.receiptId = ''; b.note = '';
        writes.push([bsh, b.row, BC.STATUS, 'no_receipt'], [bsh, b.row, BC.RECEIPT, ''], [bsh, b.row, BC.NOTE, '']);
        out.unlinked++;
      }
    }
  });
  receipts.forEach(function (r) {
    if (r.bankTxn && r.source !== 'bank') {
      const b = bankById[r.bankTxn];
      if (!b || b.receiptId !== r.id) { r.bankTxn = ''; writes.push([sh, r.row, RC.BANK_TXN, ''], [sh, r.row, RC.MATCH_NOTE, '']); }
    }
  });

  // 2. Candidates
  const freeTx = bank.filter(function (b) { return b.dir === 'out' && (b.status === 'no_receipt' || b.status === 'expense'); });
  const freeRc = receipts.filter(function (r) { return r.status === 'ok' && r.source !== 'bank' && !r.bankTxn && !/^cash$/i.test(r.payment); });
  const pairs = [];
  freeRc.forEach(function (r) {
    const rT = dateFromYmd_(r.date).getTime();
    freeTx.forEach(function (b) {
      const dayDiff = Math.round((dateFromYmd_(b.date).getTime() - rT) / 86400000);
      if (dayDiff < -CONFIG.MATCH_WINDOW_BEFORE || dayDiff > CONFIG.MATCH_WINDOW_AFTER) return;
      const diff = round2_(b.amount - r.total);
      let score = 0, tip = 0;
      if (Math.abs(diff) <= 0.011) score = 100;
      else if (diff > 0 && /restaurant/i.test(r.storeType) && diff <= Math.max(2, r.total * 0.3)) { score = 60; tip = diff; }
      else return;
      score -= Math.abs(dayDiff) * 3;
      if (descMatchesStore_(b.desc, r.store)) score += 25;
      if (b.status === 'expense') score -= 5;   // prefer a charge nobody has touched
      pairs.push({ r: r, b: b, score: score, tip: tip, dayDiff: dayDiff });
    });
  });
  pairs.sort(function (a, b) { return b.score - a.score; });
  const usedR = {}, usedB = {};
  pairs.forEach(function (p) {
    if (usedR[p.r.id] || usedB[p.b.id]) return;
    usedR[p.r.id] = true; usedB[p.b.id] = true;
    let note = p.b.account + ' ' + p.b.date;
    if (p.b.status === 'expense' && p.b.receiptId) {
      // A charge that was filed from the statement now has a real receipt: the receipt wins
      const old = recById[p.b.receiptId];
      if (old) writes.push([sh, old.row, RC.STATUS, 'superseded'], [sh, old.row, RC.MATCH_NOTE, 'replaced by ' + p.r.id]);
    }
    if (p.tip > 0) {
      note += ' (incl. tip $' + p.tip.toFixed(2) + ')';
      writes.push([sh, p.r.row, RC.TIP, round2_((p.r.tip || 0) + p.tip)], [sh, p.r.row, RC.TOTAL, p.b.amount]);
    }
    if (!descMatchesStore_(p.b.desc, p.r.store)) note += ' · ' + prettyDesc_(p.b.desc);
    writes.push([sh, p.r.row, RC.BANK_TXN, p.b.id], [sh, p.r.row, RC.MATCH_NOTE, note]);
    writes.push([bsh, p.b.row, BC.STATUS, 'matched'], [bsh, p.b.row, BC.RECEIPT, p.r.id], [bsh, p.b.row, BC.NOTE, p.r.store + ' $' + p.r.total.toFixed(2)]);
    p.b.status = 'matched'; p.b.receiptId = p.r.id;
    out.matchedNow++;
  });

  writes.forEach(function (w) { w[0].getRange(w[1], w[2]).setValue(w[3]); });
  bank.forEach(function (b) { if (b.dir === 'out' && b.status === 'no_receipt') { out.noReceipt++; out.noReceiptTotal = round2_(out.noReceiptTotal + b.amount); } });
  return out;
}

const DESC_ALIASES_ = { amzn: 'amazon', mktp: 'amazon', wal: 'walmart', walmart: 'walmart', cdn: 'canadian', cantire: 'canadian tire', ctc: 'canadian tire', 'tim': 'tim hortons', hortons: 'tim hortons', mcd: 'mcdonalds', mcdonald: 'mcdonalds', superstore: 'superstore', rcss: 'superstore', 'real': 'superstore', petrocan: 'petro-canada', petro: 'petro-canada', shell: 'shell', esso: 'esso', husky: 'husky', costco: 'costco', sobeys: 'sobeys', safeway: 'safeway', nofrills: 'no frills', dollarama: 'dollarama', homedepot: 'home depot', lowes: 'lowes', rona: 'rona', peavey: 'peavey mart', ufa: 'ufa', shoppers: 'shoppers drug mart', sdm: 'shoppers drug mart', staples: 'staples', bestbuy: 'best buy', ikea: 'ikea', netflix: 'netflix', spotify: 'spotify', telus: 'telus', rogers: 'rogers', bell: 'bell', atco: 'atco', epcor: 'epcor', enmax: 'enmax', fortis: 'fortis' };

function descTokens_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (t) { return t.length >= 3 && !/^\d+$/.test(t); })
    .map(function (t) { return DESC_ALIASES_[t] || t; });
}

function descMatchesStore_(desc, store) {
  const a = descTokens_(desc), b = descTokens_(store);
  if (!a.length || !b.length) return false;
  const joinedA = a.join(' ');
  for (let i = 0; i < b.length; i++) {
    const t = b[i];
    if (t.length < 3) continue;
    if (a.indexOf(t) >= 0 || joinedA.indexOf(t) >= 0) return true;
    for (let j = 0; j < a.length; j++) { if (a[j].length >= 4 && (a[j].indexOf(t) === 0 || t.indexOf(a[j]) === 0)) return true; }
  }
  return false;
}

/* ===================================================================
 *  BUDGETS
 * =================================================================== */

function readBudgets_(ss) {
  const bsh = ss.getSheetByName(CONFIG.TABS.BUDGETS);
  const out = { budgets: {}, proposed: {} };
  const last = bsh.getLastRow();
  if (last < 2) return out;
  bsh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
    const cat = String(r[0] || '').trim();
    if (!cat) return;
    const b = num_(r[1]), p = num_(r[2]);
    if (b !== null) out.budgets[cat] = round2_(b);
    if (p !== null) out.proposed[cat] = round2_(p);
  });
  return out;
}

/** App action: save budgets. { budgets: {category: amount}, proposed: {category: amount} } */
function handleBudget_(payload) {
  const budgets = payload.budgets && typeof payload.budgets === 'object' ? payload.budgets : {};
  const proposed = payload.proposed && typeof payload.proposed === 'object' ? payload.proposed : {};
  const ss = getSpreadsheet_();
  ensureTabs_(ss);
  const bsh = ss.getSheetByName(CONFIG.TABS.BUDGETS);
  const cats = getCategories_().slice();
  Object.keys(budgets).concat(Object.keys(proposed)).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
  const old = readBudgets_(ss);
  const now = new Date();
  const rows = cats.map(function (c) {
    const b = num_(budgets[c]);
    const p = num_(proposed[c]);
    const bOut = b === null ? (old.budgets[c] != null && !(c in budgets) ? old.budgets[c] : '') : round2_(b);
    const pOut = p === null ? (old.proposed[c] != null ? old.proposed[c] : '') : round2_(p);
    return [c, bOut, pOut, now];
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const last = bsh.getLastRow();
    if (last >= 2) bsh.getRange(2, 1, last - 1, CONFIG.BUDGET_HEADERS.length).clearContent();
    bsh.getRange(2, 1, rows.length, CONFIG.BUDGET_HEADERS.length).setValues(rows);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, budgets: readBudgets_(ss).budgets };
}

/* ===================================================================
 *  SHEET I/O
 * =================================================================== */

function writeReceipt_(ss, sh, row, rec, status) {
  const values = new Array(CONFIG.RECEIPT_HEADERS.length).fill('');
  values[RC.ID - 1] = rec.id;
  values[RC.DATE - 1] = dateFromYmd_(rec.date);
  values[RC.TIME - 1] = rec.time;
  values[RC.STORE - 1] = rec.store;
  values[RC.STORE_TYPE - 1] = rec.storeType;
  values[RC.ITEM_COUNT - 1] = rec.items.length;
  values[RC.SUBTOTAL - 1] = rec.subtotal;
  values[RC.GST - 1] = rec.gst === null ? '' : rec.gst;
  values[RC.OTHER_TAX - 1] = rec.otherTax === null ? '' : rec.otherTax;
  values[RC.TIP - 1] = rec.tip === null ? '' : rec.tip;
  values[RC.TOTAL - 1] = rec.total;
  values[RC.PAYMENT - 1] = rec.payment;
  values[RC.WHO - 1] = rec.who;
  values[RC.STATUS - 1] = status || 'ok';
  values[RC.NEEDS_REVIEW - 1] = rec.needsReview ? 'YES' : '';
  values[RC.REVIEW_NOTES - 1] = rec.reviewNotes;
  values[RC.PHOTO - 1] = rec.photoUrl || '';
  values[RC.HASH - 1] = rec.hash;
  values[RC.CAPTURED_AT - 1] = rec.capturedAt;
  values[RC.FILED_AT - 1] = new Date();
  values[RC.FILE_ID - 1] = rec.fileId || '';
  values[RC.CONFIDENCE - 1] = rec.confidence === null || rec.confidence === undefined ? '' : rec.confidence;
  values[RC.SOURCE - 1] = rec.source || 'photo';
  values[RC.PAGES - 1] = rec.pages || 1;
  values[RC.DUP_OF - 1] = rec.duplicateOf || '';
  values[RC.BANK_TXN - 1] = rec.bankTxn || '';
  values[RC.MATCH_NOTE - 1] = rec.matchNote || '';
  sh.getRange(row, 1, 1, values.length).setValues([values]);
  // appendRow() in phase 1 gives date cells an automatic date-time format; put the column formats back
  sh.getRange(row, RC.DATE).setNumberFormat('yyyy-mm-dd');
  sh.getRange(row, RC.CAPTURED_AT, 1, 2).setNumberFormat('yyyy-mm-dd hh:mm');

  // Items: remove any old lines for this receipt (retry case), then append
  const ish = ss.getSheetByName(CONFIG.TABS.ITEMS);
  deleteItemsFor_(ish, rec.id);
  if (rec.items.length) {
    const d = dateFromYmd_(rec.date);
    const rows = rec.items.map(function (it) {
      return [rec.id, d, rec.store, it.name, it.qty, it.unitPrice === null ? '' : it.unitPrice, it.lineTotal, it.category, rec.who, ''];
    });
    ish.getRange(ish.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function deleteItemsFor_(ish, receiptId) {
  const last = ish.getLastRow();
  if (last < 2) return;
  const ids = ish.getRange(2, 1, last - 1, 1).getValues();
  // delete bottom-up so row numbers stay valid
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === receiptId) ish.deleteRow(i + 2);
  }
}

function readItemsFor_(ss, receiptId) {
  const ish = ss.getSheetByName(CONFIG.TABS.ITEMS);
  const last = ish.getLastRow();
  if (last < 2) return [];
  const vals = ish.getRange(2, 1, last - 1, CONFIG.ITEM_HEADERS.length).getValues();
  return vals.filter(function (r) { return String(r[0]) === receiptId; }).map(function (r) {
    return { name: r[3], qty: num_(r[4]), unitPrice: num_(r[5]), lineTotal: num_(r[6]) || 0, category: r[7] };
  });
}

function findReceiptByHash_(sh, hash) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const hashes = sh.getRange(2, RC.HASH, last - 1, 1).getValues();
  for (let i = 0; i < hashes.length; i++) {
    if (String(hashes[i][0]) === hash) return readReceiptRow_(sh, i + 2);
  }
  return null;
}

function findReceiptById_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const ids = sh.getRange(2, RC.ID, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === id) return readReceiptRow_(sh, i + 2);
  }
  return null;
}

function findBankRow_(bsh, txnId) {
  const last = bsh.getLastRow();
  if (last < 2) return 0;
  const ids = bsh.getRange(2, BC.ID, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === txnId) return i + 2;
  return 0;
}

function readReceiptRow_(sh, row) {
  const v = sh.getRange(row, 1, 1, CONFIG.RECEIPT_HEADERS.length).getValues()[0];
  const filedAt = v[RC.FILED_AT - 1];
  return {
    row: row,
    id: String(v[RC.ID - 1]),
    date: ymd_(v[RC.DATE - 1]),
    time: String(v[RC.TIME - 1] || ''),
    store: String(v[RC.STORE - 1] || ''),
    storeType: String(v[RC.STORE_TYPE - 1] || ''),
    subtotal: num_(v[RC.SUBTOTAL - 1]),
    gst: num_(v[RC.GST - 1]),
    otherTax: num_(v[RC.OTHER_TAX - 1]),
    tip: num_(v[RC.TIP - 1]),
    total: num_(v[RC.TOTAL - 1]),
    payment: String(v[RC.PAYMENT - 1] || ''),
    who: String(v[RC.WHO - 1] || ''),
    status: String(v[RC.STATUS - 1] || ''),
    needsReview: String(v[RC.NEEDS_REVIEW - 1] || '') === 'YES',
    reviewNotes: String(v[RC.REVIEW_NOTES - 1] || ''),
    photoUrl: String(v[RC.PHOTO - 1] || ''),
    hash: String(v[RC.HASH - 1] || ''),
    capturedAt: v[RC.CAPTURED_AT - 1] instanceof Date ? v[RC.CAPTURED_AT - 1] : parseIso_(v[RC.CAPTURED_AT - 1]),
    filedAtMs: filedAt instanceof Date ? filedAt.getTime() : 0,
    fileId: String(v[RC.FILE_ID - 1] || ''),
    source: String(v[RC.SOURCE - 1] || ''),
    pages: num_(v[RC.PAGES - 1]) || 1,
    dupOf: String(v[RC.DUP_OF - 1] || ''),
    bankTxn: String(v[RC.BANK_TXN - 1] || '')
  };
}

/* ===================================================================
 *  DASHBOARD FEED  (the app does the period maths)
 * =================================================================== */

function buildSummary_() {
  const ss = getSpreadsheet_();
  ensureTabs_(ss);
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const ish = ss.getSheetByName(CONFIG.TABS.ITEMS);
  const bsh = ss.getSheetByName(CONFIG.TABS.BANK);
  const cats = getCategories_();
  const catIdx = {}; cats.forEach(function (c, i) { catIdx[c] = i; });
  function cat(c) { if (!(c in catIdx)) { catIdx[c] = cats.length; cats.push(c); } return catIdx[c]; }
  const whos = []; const whoIdx = {};
  function who(w) { w = w || 'Unknown'; if (!(w in whoIdx)) { whoIdx[w] = whos.length; whos.push(w); } return whoIdx[w]; }

  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const itemsFrom = monthsAgoYmd_(CONFIG.ITEMS_MONTHS);
  const recentFrom = daysAgoYmd_(45);

  const receipts = [];
  const removedDups = [];
  const idToIdx = {};
  const lastR = sh.getLastRow();
  if (lastR >= 2) {
    const vals = sh.getRange(2, 1, lastR - 1, CONFIG.RECEIPT_HEADERS.length).getValues();
    vals.forEach(function (v) {
      const status = String(v[RC.STATUS - 1]);
      const date = ymd_(v[RC.DATE - 1]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      if (status === 'duplicate') {
        if (date >= recentFrom) removedDups.push({ id: String(v[RC.ID - 1]), of: String(v[RC.DUP_OF - 1] || ''), d: date, s: String(v[RC.STORE - 1] || ''), t: num_(v[RC.TOTAL - 1]) || 0, f: String(v[RC.FILE_ID - 1] || '') });
        return;
      }
      if (status !== 'ok') return;
      const r = {
        id: String(v[RC.ID - 1]), d: date, s: String(v[RC.STORE - 1] || 'Unknown store'), st: String(v[RC.STORE_TYPE - 1] || ''),
        t: num_(v[RC.TOTAL - 1]) || 0, w: who(String(v[RC.WHO - 1] || '')), n: num_(v[RC.ITEM_COUNT - 1]) || 0,
        src: String(v[RC.SOURCE - 1] || 'photo'), pay: String(v[RC.PAYMENT - 1] || ''),
        bm: String(v[RC.BANK_TXN - 1] || ''), f: String(v[RC.FILE_ID - 1] || ''), c: {}, _ls: 0
      };
      if (String(v[RC.NEEDS_REVIEW - 1] || '') === 'YES') { r.nr = 1; r.rn = String(v[RC.REVIEW_NOTES - 1] || '').slice(0, 200); }
      if (String(v[RC.DUP_OF - 1] || '')) r.dup = String(v[RC.DUP_OF - 1]);
      idToIdx[r.id] = receipts.length;
      receipts.push(r);
    });
  }

  // Items → per-receipt category split (tax & tip spread across the lines) + compact item rows
  const items = [];
  const lastI = ish.getLastRow();
  if (lastI >= 2) {
    const vals = ish.getRange(2, 1, lastI - 1, CONFIG.ITEM_HEADERS.length).getValues();
    vals.forEach(function (v) {
      const idx = idToIdx[String(v[0])];
      if (idx === undefined) return;
      const r = receipts[idx];
      const line = num_(v[6]) || 0;
      const ci = cat(String(v[7] || 'Other'));
      r.c[ci] = (r.c[ci] || 0) + line;
      r._ls += line;
      if (r.d >= itemsFrom) items.push([idx, String(v[3] || ''), num_(v[4]) || 1, round2_(line), ci]);
    });
  }
  receipts.forEach(function (r) {
    // Scale line categories so they add up to what was actually paid (tax, tip, rounding)
    const keys = Object.keys(r.c);
    if (!keys.length || r._ls <= 0) { r.c = {}; r.c[cat('Other')] = round2_(r.t); }
    else {
      const f = r.t / r._ls;
      let acc = 0;
      keys.forEach(function (k, i) {
        const val = i === keys.length - 1 ? round2_(r.t - acc) : round2_(r.c[k] * f);
        r.c[k] = val; acc = round2_(acc + val);
      });
    }
    delete r._ls;
  });

  // Bank: accounts, charges with no receipt, counts
  const accounts = {};
  const noReceipt = [];
  const noReceiptFrom = daysAgoYmd_(CONFIG.NO_RECEIPT_DAYS);
  const lastB = bsh.getLastRow();
  let bankRows = 0;
  if (lastB >= 2) {
    bsh.getRange(2, 1, lastB - 1, CONFIG.BANK_HEADERS.length).getValues().forEach(function (v) {
      bankRows++;
      const acct = String(v[BC.ACCOUNT - 1] || 'Bank');
      const date = ymd_(v[BC.DATE - 1]);
      const status = String(v[BC.STATUS - 1] || '');
      const dir = String(v[BC.DIR - 1] || 'out');
      const up = v[BC.UPLOADED - 1] instanceof Date ? v[BC.UPLOADED - 1].getTime() : 0;
      if (!accounts[acct]) accounts[acct] = { name: acct, from: date, to: date, count: 0, matched: 0, noReceipt: 0, lastUpload: up };
      const a = accounts[acct];
      a.count++;
      if (date && (date < a.from || !a.from)) a.from = date;
      if (date && date > a.to) a.to = date;
      if (up > a.lastUpload) a.lastUpload = up;
      if (status === 'matched') a.matched++;
      if (dir === 'out' && status === 'no_receipt') {
        a.noReceipt++;
        if (date >= noReceiptFrom) noReceipt.push({ id: String(v[BC.ID - 1]), d: date, desc: String(v[BC.DESC - 1] || ''), amt: num_(v[BC.AMOUNT - 1]) || 0, acct: acct });
      }
    });
  }
  noReceipt.sort(function (a, b) { return b.d.localeCompare(a.d); });

  const budgets = readBudgets_(ss);
  return {
    ok: true,
    v: 2,
    generatedAt: new Date().toISOString(),
    today: today,
    currency: CONFIG.CURRENCY,
    sheetUrl: ss.getUrl(),
    categories: cats,
    whos: whos,
    receipts: receipts,
    items: items,
    itemsFrom: itemsFrom,
    removedDups: removedDups,
    bank: { accounts: Object.keys(accounts).map(function (k) { return accounts[k]; }).sort(function (a, b) { return b.to.localeCompare(a.to); }), rows: bankRows, noReceipt: noReceipt.slice(0, 250) },
    budgets: budgets.budgets,
    proposed: budgets.proposed
  };
}

/* ===================================================================
 *  HELPERS
 * =================================================================== */

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate below */ }
  }
  const ss = SpreadsheetApp.create(CONFIG.SHEET_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  ensureTabs_(ss);
  return ss;
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  const folder = DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getPagesFolder_() {
  const parent = getFolder_();
  const it = parent.getFoldersByName(CONFIG.PAGES_FOLDER);
  if (it.hasNext()) return it.next();
  return parent.createFolder(CONFIG.PAGES_FOLDER);
}

function ensureTabs_(ss) {
  let sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  if (!sh) {
    sh = ss.getSheets()[0];
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length === 1) sh.setName(CONFIG.TABS.RECEIPTS);
    else sh = ss.insertSheet(CONFIG.TABS.RECEIPTS);
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, CONFIG.RECEIPT_HEADERS.length).setValues([CONFIG.RECEIPT_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    sh.getRange('G:K').setNumberFormat('#,##0.00');
    sh.getRange('S:T').setNumberFormat('yyyy-mm-dd hh:mm');
  } else {
    // Sheet made by an older version: add any header cells that are missing
    const hdr = sh.getRange(1, 1, 1, CONFIG.RECEIPT_HEADERS.length).getValues()[0];
    let have = 0;
    for (let i = 0; i < hdr.length; i++) if (String(hdr[i] || '').trim()) have = i + 1;
    if (have < CONFIG.RECEIPT_HEADERS.length) {
      sh.getRange(1, have + 1, 1, CONFIG.RECEIPT_HEADERS.length - have).setValues([CONFIG.RECEIPT_HEADERS.slice(have)]).setFontWeight('bold');
    }
  }

  let ish = ss.getSheetByName(CONFIG.TABS.ITEMS);
  if (!ish) ish = ss.insertSheet(CONFIG.TABS.ITEMS);
  if (ish.getLastRow() === 0) {
    ish.getRange(1, 1, 1, CONFIG.ITEM_HEADERS.length).setValues([CONFIG.ITEM_HEADERS]).setFontWeight('bold');
    ish.setFrozenRows(1);
    ish.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    ish.getRange('F:G').setNumberFormat('#,##0.00');
  }

  let bsh = ss.getSheetByName(CONFIG.TABS.BANK);
  if (!bsh) bsh = ss.insertSheet(CONFIG.TABS.BANK);
  if (bsh.getLastRow() === 0) {
    bsh.getRange(1, 1, 1, CONFIG.BANK_HEADERS.length).setValues([CONFIG.BANK_HEADERS]).setFontWeight('bold');
    bsh.setFrozenRows(1);
    bsh.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    bsh.getRange('D:D').setNumberFormat('#,##0.00');
    bsh.getRange('K:K').setNumberFormat('yyyy-mm-dd hh:mm');
  }

  let rsh = ss.getSheetByName(CONFIG.TABS.RULES);
  if (!rsh) rsh = ss.insertSheet(CONFIG.TABS.RULES);
  if (rsh.getLastRow() === 0) {
    rsh.getRange(1, 1, 1, CONFIG.RULE_HEADERS.length).setValues([CONFIG.RULE_HEADERS]).setFontWeight('bold');
    rsh.setFrozenRows(1);
  }

  let gsh = ss.getSheetByName(CONFIG.TABS.BUDGETS);
  if (!gsh) gsh = ss.insertSheet(CONFIG.TABS.BUDGETS);
  if (gsh.getLastRow() === 0) {
    gsh.getRange(1, 1, 1, CONFIG.BUDGET_HEADERS.length).setValues([CONFIG.BUDGET_HEADERS]).setFontWeight('bold');
    gsh.setFrozenRows(1);
    gsh.getRange('B:C').setNumberFormat('#,##0.00');
  }

  let csh = ss.getSheetByName(CONFIG.TABS.CATEGORIES);
  if (!csh) csh = ss.insertSheet(CONFIG.TABS.CATEGORIES);
  if (csh.getLastRow() === 0) {
    csh.getRange(1, 1).setValue('Category (edit this list; the app reads it)').setFontWeight('bold');
    csh.getRange(2, 1, CONFIG.CATEGORIES.length, 1).setValues(CONFIG.CATEGORIES.map(function (c) { return [c]; }));
  }

  let lsh = ss.getSheetByName(CONFIG.TABS.LOG);
  if (!lsh) lsh = ss.insertSheet(CONFIG.TABS.LOG);
  if (lsh.getLastRow() === 0) {
    lsh.getRange(1, 1, 1, 3).setValues([['When', 'Level', 'Message']]).setFontWeight('bold');
  }
}

function getCategories_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('categories');
  if (hit) return JSON.parse(hit);
  let cats = CONFIG.CATEGORIES.slice();
  try {
    const ss = getSpreadsheet_();
    const csh = ss.getSheetByName(CONFIG.TABS.CATEGORIES);
    if (csh && csh.getLastRow() >= 2) {
      const vals = csh.getRange(2, 1, csh.getLastRow() - 1, 1).getValues()
        .map(function (r) { return String(r[0] || '').trim(); })
        .filter(function (s) { return s; });
      if (vals.length) cats = vals;
    }
  } catch (e) { /* fall back to defaults */ }
  if (cats.indexOf('Other') < 0) cats.push('Other');
  cache.put('categories', JSON.stringify(cats), 600);
  return cats;
}

function getModel_() {
  return PropertiesService.getScriptProperties().getProperty('CLAUDE_MODEL') || CONFIG.DEFAULT_MODEL;
}

function checkToken_(token) {
  const want = PropertiesService.getScriptProperties().getProperty('APP_TOKEN') || CONFIG.DEFAULT_TOKEN;
  return String(token || '').trim().toLowerCase() === String(want).trim().toLowerCase();
}

function cleanKind_(kind, mime) {
  kind = String(kind || '').toLowerCase();
  if (kind === 'pdf' || kind === 'screenshot' || kind === 'photo' || kind === 'bank') return kind;
  return /pdf/i.test(String(mime || '')) ? 'pdf' : 'photo';
}

function extFor_(mime) {
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

function saveFile_(b64, mime, receiptId, kind) {
  const clean = String(b64).replace(/^data:[^;]+;base64,/, '');
  const bytes = Utilities.base64Decode(clean);
  let type = String(mime || '');
  if (kind === 'pdf' || /pdf/i.test(type)) type = 'application/pdf';
  else if (!/^image\//.test(type)) type = 'image/jpeg';
  const blob = Utilities.newBlob(bytes, type, receiptId + extFor_(type));
  return getFolder_().createFile(blob);
}

function savePages_(pages, receiptId) {
  const folder = getPagesFolder_();
  pages.forEach(function (p, i) {
    const bytes = Utilities.base64Decode(String(p).replace(/^data:[^;]+;base64,/, ''));
    folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', receiptId + '-p' + (i + 1) + '.jpg'));
  });
}

function loadPages_(receiptId) {
  const folder = getPagesFolder_();
  const found = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const m = new RegExp('^' + receiptId.replace(/[-]/g, '\\-') + '-p(\\d+)\\.jpg$').exec(f.getName());
    if (m) found.push({ n: Number(m[1]), b64: Utilities.base64Encode(f.getBlob().getBytes()) });
  }
  found.sort(function (a, b) { return a.n - b.n; });
  return found.map(function (x) { return x.b64; });
}

function makeReceiptId_(d) {
  const stamp = Utilities.formatDate(d || new Date(), CONFIG.TZ, 'yyyyMMdd-HHmmss');
  const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
  return 'R' + stamp + '-' + suffix;
}

function makeJoinWord_() {
  const words = ['maple', 'river', 'prairie', 'cedar', 'aurora', 'willow', 'moose', 'spruce', 'harvest', 'meadow', 'canola', 'north'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = 100 + Math.floor(Math.random() * 900);
  return w + n;
}

function cleanWho_(who) {
  const w = String(who || '').trim();
  return w ? w.slice(0, 30) : 'Unknown';
}

function sha256Hex_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function parseIso_(s) {
  if (!s) return null;
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
  const d = new Date(String(s));
  return isNaN(d.getTime()) ? null : d;
}

function num_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim();
  const paren = /^\(.*\)$/.test(s);          // (12.34) = negative in some exports
  const trailingMinus = /-$/.test(s);
  s = s.replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  let n = parseFloat(s);
  if (!isFinite(n)) return null;
  if ((paren || trailingMinus) && n > 0) n = -n;
  return n;
}

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** Date object at noon local for a yyyy-MM-dd string (noon avoids DST/offset day shifts). */
function dateFromYmd_(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return noon_(new Date());
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

function noon_(d) {
  const ymd = Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd');
  return dateFromYmd_(ymd);
}

function ymd_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, CONFIG.TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function daysAgoYmd_(days) {
  return Utilities.formatDate(new Date(Date.now() - days * 86400000), CONFIG.TZ, 'yyyy-MM-dd');
}

function monthsAgoYmd_(months) {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - months, 1, 12, 0, 0);
  return Utilities.formatDate(m, CONFIG.TZ, 'yyyy-MM-dd');
}

const MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Many bank date formats → 'YYYY-MM-DD' (or '' if it cannot be read). `fmt` is the hint from the column mapping. */
function parseDateFlexible_(v, fmt) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, CONFIG.TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  if (!s) return '';
  fmt = String(fmt || '').toUpperCase();
  const pad = function (n) { return ('0' + n).slice(-2); };
  const mk = function (y, m, d) {
    y = Number(y); m = Number(m); d = Number(d);
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100)) return '';
    return y + '-' + pad(m) + '-' + pad(d);
  };
  let m;
  if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s))) return mk(m[1], m[2], m[3]);                 // 2026-10-03, 2026/10/03, ISO datetime
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return mk(m[1], m[2], m[3]);                                 // 20261003
  if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/.exec(s))) {                                          // 10/03/2026 or 03/10/2026
    const a = Number(m[1]), b = Number(m[2]);
    const dayFirst = /^DD/.test(fmt) || (a > 12 && b <= 12);
    return dayFirst ? mk(m[3], b, a) : mk(m[3], a, b);
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})?$/.exec(s))) {                                      // Oct 3, 2026 / Oct 3
    const mo = MONTHS_[m[1].slice(0, 3).toLowerCase()]; if (!mo) return '';
    return m[3] ? mk(m[3], mo, m[2]) : recentYear_(mo, Number(m[2]));
  }
  if ((m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s-]*(\d{4})?$/.exec(s))) {                                  // 3 Oct 2026 / 03-OCT-2026 / 3 Oct
    const mo = MONTHS_[m[2].slice(0, 3).toLowerCase()]; if (!mo) return '';
    return m[3] ? mk(m[3], mo, m[1]) : recentYear_(mo, Number(m[1]));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd');
}

/** "Oct 3" with no year → the most recent Oct 3 that is not in the future. */
function recentYear_(mo, day) {
  const now = new Date();
  let y = now.getFullYear();
  const pad = function (n) { return ('0' + n).slice(-2); };
  let out = y + '-' + pad(mo) + '-' + pad(day);
  if (out > Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd')) out = (y - 1) + '-' + pad(mo) + '-' + pad(day);
  return out;
}

function monthLabel_(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

function safeName_(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
}

function log_(level, message) {
  try {
    const ss = getSpreadsheet_();
    const lsh = ss.getSheetByName(CONFIG.TABS.LOG);
    if (lsh) lsh.appendRow([new Date(), level, String(message).slice(0, 2000)]);
  } catch (e) { /* never let logging break a request */ }
  if (level === 'error') console.error(message); else console.log(message);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
