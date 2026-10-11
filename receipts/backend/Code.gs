/**
 * Household Receipts — Apps Script backend
 * ---------------------------------------------------------------
 * The phone app posts a receipt photo here. This script:
 *   1. checks the photo hasn't been filed already (so retries never double-file)
 *   2. saves the photo to a Drive folder
 *   3. reads the receipt with Claude — store, date, every line item, taxes, total
 *   4. files it into the "Household Receipts" Google Sheet (Receipts + Items tabs)
 *   5. serves the dashboard numbers back to the app (doGet ?action=summary)
 *
 * ONE-TIME SETUP (in the Apps Script editor):
 *   1. Project Settings → Script Properties → add  ANTHROPIC_API_KEY = sk-ant-...
 *   2. Select the function  setup  and press Run (accept the permissions prompt).
 *      It creates the Sheet + Drive folder and prints your join word in the log.
 *   3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   4. Paste the web app URL and the join word into the phone app's Settings.
 */

const CONFIG = {
  SHEET_NAME: 'Household Receipts',
  FOLDER_NAME: 'Household Receipts (photos)',
  DEFAULT_MODEL: 'claude-sonnet-5-5',   // override with script property CLAUDE_MODEL
  DEFAULT_TOKEN: 'prairie482',          // the join word baked into the phone app; rotateJoinWord() changes it
  MAX_TOKENS: 6000,
  TZ: 'America/Edmonton',
  CURRENCY: 'CAD',
  CATEGORIES: [
    'Groceries', 'Dining & Takeout', 'Fuel', 'Vehicle', 'Household Supplies',
    'Home & Hardware', 'Clothing', 'Health & Pharmacy', 'Personal Care',
    'Kids & Baby', 'Pets', 'Entertainment', 'Electronics', 'Gifts', 'Travel',
    'Alcohol & Tobacco', 'Office & Stationery', 'Farm & Ranch', 'Other'
  ],
  STORE_TYPES: [
    'Grocery', 'Gas Station', 'Restaurant', 'Hardware', 'Pharmacy',
    'Department Store', 'Online', 'Farm Supply', 'Clothing', 'Other'
  ],
  TABS: {
    RECEIPTS: 'Receipts',
    ITEMS: 'Items',
    CATEGORIES: 'Categories',
    LOG: 'Log'
  },
  RECEIPT_HEADERS: [
    'Receipt ID', 'Date', 'Time', 'Store', 'Store Type', 'Item Count', 'Subtotal',
    'GST/HST', 'Other Tax', 'Tip', 'Total', 'Payment', 'Who', 'Status',
    'Needs Review', 'Review Notes', 'Photo', 'Hash', 'Captured At', 'Filed At',
    'Photo File ID', 'Confidence'
  ],
  ITEM_HEADERS: [
    'Receipt ID', 'Date', 'Store', 'Item', 'Qty', 'Unit Price', 'Line Total',
    'Category', 'Who', 'Notes'
  ]
};

// Column numbers (1-based) in the Receipts tab — keep in sync with RECEIPT_HEADERS
const RC = {
  ID: 1, DATE: 2, TIME: 3, STORE: 4, STORE_TYPE: 5, ITEM_COUNT: 6, SUBTOTAL: 7,
  GST: 8, OTHER_TAX: 9, TIP: 10, TOTAL: 11, PAYMENT: 12, WHO: 13, STATUS: 14,
  NEEDS_REVIEW: 15, REVIEW_NOTES: 16, PHOTO: 17, HASH: 18, CAPTURED_AT: 19,
  FILED_AT: 20, FILE_ID: 21, CONFIDENCE: 22
};

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
    'Next: Deploy → New deployment → Web app (Execute as Me, Anyone), then paste the',
    'web app URL + join word into the phone app Settings.'
  ];
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** Optional: run to confirm the Claude key works (logs the reply). */
function testClaudeKey() {
  const res = callClaude_([{ type: 'text', text: 'Reply with the single word OK.' }], 20);
  Logger.log('Claude replied: ' + res.text);
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
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    log_('error', 'doPost: ' + err + (err.stack ? '\n' + err.stack : ''));
    return json_({ ok: false, error: 'server_error', message: String(err), retryable: true });
  }
}

function ping_() {
  const props = PropertiesService.getScriptProperties();
  const ss = getSpreadsheet_();
  return {
    ok: true,
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
 * payload: { token, action:'receipt', hash, image (base64 jpeg, no data: prefix),
 *            mime, who, capturedAt (ISO), clientId }
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

  // ---- Phase 1 (under lock): dedupe + reserve a row ----------------------
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let existing, receiptId;
  try {
    existing = findReceiptByHash_(sh, hash);
    if (existing) {
      if (existing.status === 'ok' || existing.status === 'not_a_receipt') {
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
      sh.appendRow(row);
      existing = readReceiptRow_(sh, sh.getLastRow());
    }
  } finally {
    lock.releaseLock();
  }

  // ---- Phase 2 (no lock): save the photo if we don't have it yet ---------
  if (!existing.fileId) {
    if (!image) {
      sh.getRange(existing.row, RC.STATUS).setValue('error');
      return { ok: false, error: 'no_photo', retryable: true, message: 'Photo missing on the server; resend it.' };
    }
    const file = savePhoto_(image, payload.mime, receiptId);
    existing.fileId = file.getId();
    existing.photoUrl = file.getUrl();
    sh.getRange(existing.row, RC.FILE_ID).setValue(existing.fileId);
    sh.getRange(existing.row, RC.PHOTO).setValue(existing.photoUrl);
  }
  existing.who = existing.who || who;
  existing.capturedAt = existing.capturedAt || capturedAt;

  // ---- Phase 3: read it with Claude and file it --------------------------
  return processExisting_(ss, sh, existing);
}

/** Reads the saved photo with Claude and files the result. Returns the API response. */
function processExisting_(ss, sh, existing) {
  const file = DriveApp.getFileById(existing.fileId);
  const blob = file.getBlob();
  const b64 = Utilities.base64Encode(blob.getBytes());
  const mime = blob.getContentType() || 'image/jpeg';
  const capturedAt = existing.capturedAt instanceof Date ? existing.capturedAt : (parseIso_(existing.capturedAt) || new Date());

  let parsed;
  try {
    parsed = extractReceipt_(b64, mime, capturedAt);
  } catch (err) {
    log_('error', 'extract ' + existing.id + ': ' + err);
    sh.getRange(existing.row, RC.STATUS).setValue('error');
    sh.getRange(existing.row, RC.REVIEW_NOTES).setValue('Read failed: ' + String(err).slice(0, 200));
    // A 4xx from the API (other than rate limiting) means this photo will fail the same way next time
    const permanent = /Claude API 4(?!29)\d\d/.test(String(err));
    return {
      ok: false, error: 'extract_failed', retryable: !permanent,
      message: permanent ? 'The receipt reader rejected this photo (' + String(err).slice(0, 120) + ')' : 'Could not read the receipt right now. It is saved and will be retried.'
    };
  }

  if (parsed.is_receipt === false) {
    sh.getRange(existing.row, RC.STATUS).setValue('not_a_receipt');
    sh.getRange(existing.row, RC.REVIEW_NOTES).setValue(parsed.notes || 'Photo did not look like a receipt');
    sh.getRange(existing.row, RC.FILED_AT).setValue(new Date());
    try { file.setName('NOT A RECEIPT ' + existing.id + '.jpg'); } catch (e) {}
    return { ok: true, status: 'not_a_receipt', receiptId: existing.id, message: 'That photo did not look like a receipt.', duplicate: false };
  }

  const rec = normalizeReceipt_(parsed, capturedAt);
  rec.id = existing.id;
  rec.who = existing.who;
  rec.hash = existing.hash;
  rec.photoUrl = existing.photoUrl;
  rec.fileId = existing.fileId;
  rec.capturedAt = capturedAt;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeReceipt_(ss, sh, existing.row, rec);
  } finally {
    lock.releaseLock();
  }

  try {
    file.setName(safeName_(rec.date + ' ' + rec.store + ' $' + rec.total.toFixed(2) + ' (' + rec.id + ').jpg'));
  } catch (e) { /* cosmetic */ }

  return {
    ok: true,
    status: 'ok',
    duplicate: false,
    receiptId: rec.id,
    receipt: publicReceipt_(rec)
  };
}

/** Response for a receipt that was already filed (idempotent retry). */
function receiptResponse_(ss, existing, duplicate) {
  if (existing.status === 'not_a_receipt') {
    return { ok: true, status: 'not_a_receipt', receiptId: existing.id, duplicate: duplicate, message: 'That photo did not look like a receipt.' };
  }
  const items = readItemsFor_(ss, existing.id);
  return {
    ok: true,
    status: 'ok',
    duplicate: duplicate,
    receiptId: existing.id,
    receipt: {
      id: existing.id,
      date: existing.date,
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
    items: rec.items.map(function (it) {
      return { name: it.name, qty: it.qty, unitPrice: it.unitPrice, lineTotal: it.lineTotal, category: it.category };
    })
  };
}

/* ===================================================================
 *  CLAUDE EXTRACTION
 * =================================================================== */

function extractReceipt_(b64, mime, capturedAt) {
  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const captured = Utilities.formatDate(capturedAt, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
  const cats = getCategories_();

  const instructions = [
    'Read this receipt photo and return ONLY a JSON object — no markdown, no commentary — with exactly this shape:',
    '{',
    '  "is_receipt": true,',
    '  "store": "store name, cleaned up (e.g. Costco, Safeway, Peavey Mart, Tim Hortons)",',
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
    '  "payment": "Visa" | "Mastercard" | "Debit" | "Cash" | "Amex" | "Gift card" | other | null,',
    '  "confidence": number between 0 and 1,',
    '  "notes": "one short line about anything you were unsure of, or empty"',
    '}',
    '',
    'Rules:',
    '- Every purchased line becomes one item. Expand abbreviations into plain English ("ORG BNNA" -> "Organic bananas", "PC WHL MLK 4L" -> "PC whole milk 4L").',
    '- line_total is the price actually charged for that line (after any instant discount shown on the same line). qty is 1 unless the receipt shows a quantity; for weighed goods use qty 1 and put the weight in the name.',
    '- Discounts, coupons and member savings that appear as their own line become items with a NEGATIVE line_total and a name starting with "Discount:".',
    '- Bottle deposits, enviro fees, bag fees and tips-on-receipt are their own items (category Other).',
    '- Taxes (GST, HST, PST, QST) are NOT items; put them in gst / other_tax. HST goes in gst.',
    '- total is the amount actually paid. subtotal is the pre-tax subtotal if printed.',
    '- Category is about what the item is, not where it was bought: a hammer from Walmart is Home & Hardware; a sandwich from a gas station is Dining & Takeout.',
    '- If part of the receipt is unreadable, make your best guess and lower confidence.',
    '- If the photo is not a receipt at all (or shows nothing purchased), return {"is_receipt": false, "notes": "why"}.',
    '',
    'Today is ' + today + ' (Mountain Time). The photo was taken ' + captured + '. Most receipts are dated the same day or a few days earlier.'
  ].join('\n');

  const content = [
    { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
    { type: 'text', text: instructions }
  ];
  const res = callClaude_(content, CONFIG.MAX_TOKENS);
  const obj = parseJsonLoose_(res.text);
  if (!obj || typeof obj !== 'object') throw new Error('Claude returned no JSON');
  return obj;
}

/** Calls the Messages API with one retry on rate limit / overload. Returns {text, raw}. */
function callClaude_(content, maxTokens) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (Project Settings → Script Properties)');

  const body = {
    model: getModel_(),
    max_tokens: maxTokens || CONFIG.MAX_TOKENS,
    system: 'You are a meticulous bookkeeper who transcribes retail receipts for a Canadian household budget. You always answer with valid JSON only.',
    messages: [{ role: 'user', content: content }]
  };
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
 *  SHEET I/O
 * =================================================================== */

function writeReceipt_(ss, sh, row, rec) {
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
  values[RC.STATUS - 1] = 'ok';
  values[RC.NEEDS_REVIEW - 1] = rec.needsReview ? 'YES' : '';
  values[RC.REVIEW_NOTES - 1] = rec.reviewNotes;
  values[RC.PHOTO - 1] = rec.photoUrl;
  values[RC.HASH - 1] = rec.hash;
  values[RC.CAPTURED_AT - 1] = rec.capturedAt;
  values[RC.FILED_AT - 1] = new Date();
  values[RC.FILE_ID - 1] = rec.fileId;
  values[RC.CONFIDENCE - 1] = rec.confidence === null ? '' : rec.confidence;
  sh.getRange(row, 1, 1, values.length).setValues([values]);

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

function readReceiptRow_(sh, row) {
  const v = sh.getRange(row, 1, 1, CONFIG.RECEIPT_HEADERS.length).getValues()[0];
  const filedAt = v[RC.FILED_AT - 1];
  return {
    row: row,
    id: String(v[RC.ID - 1]),
    date: v[RC.DATE - 1] instanceof Date ? Utilities.formatDate(v[RC.DATE - 1], CONFIG.TZ, 'yyyy-MM-dd') : String(v[RC.DATE - 1] || ''),
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
    fileId: String(v[RC.FILE_ID - 1] || '')
  };
}

/* ===================================================================
 *  DASHBOARD SUMMARY
 * =================================================================== */

function buildSummary_() {
  const ss = getSpreadsheet_();
  ensureTabs_(ss);
  const sh = ss.getSheetByName(CONFIG.TABS.RECEIPTS);
  const ish = ss.getSheetByName(CONFIG.TABS.ITEMS);

  const receipts = [];
  const lastR = sh.getLastRow();
  if (lastR >= 2) {
    const vals = sh.getRange(2, 1, lastR - 1, CONFIG.RECEIPT_HEADERS.length).getValues();
    vals.forEach(function (v) {
      if (String(v[RC.STATUS - 1]) !== 'ok') return;
      const d = v[RC.DATE - 1];
      const date = d instanceof Date ? Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd') : String(d || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      receipts.push({
        id: String(v[RC.ID - 1]),
        date: date,
        month: date.slice(0, 7),
        store: String(v[RC.STORE - 1] || 'Unknown store'),
        storeType: String(v[RC.STORE_TYPE - 1] || ''),
        total: num_(v[RC.TOTAL - 1]) || 0,
        subtotal: num_(v[RC.SUBTOTAL - 1]),
        itemCount: num_(v[RC.ITEM_COUNT - 1]) || 0,
        who: String(v[RC.WHO - 1] || ''),
        needsReview: String(v[RC.NEEDS_REVIEW - 1] || '') === 'YES',
        photoUrl: String(v[RC.PHOTO - 1] || '')
      });
    });
  }
  const byId = {};
  receipts.forEach(function (r) { byId[r.id] = r; });

  const items = [];
  const lastI = ish.getLastRow();
  if (lastI >= 2) {
    const vals = ish.getRange(2, 1, lastI - 1, CONFIG.ITEM_HEADERS.length).getValues();
    vals.forEach(function (v) {
      const r = byId[String(v[0])];
      if (!r) return;
      items.push({
        receiptId: r.id, month: r.month, name: String(v[3] || ''),
        qty: num_(v[4]) || 1, lineTotal: num_(v[6]) || 0,
        category: String(v[7] || 'Other'), who: r.who, store: r.store
      });
    });
  }

  // Tax & tip per receipt = total minus what the lines add up to
  const lineSumByReceipt = {};
  items.forEach(function (it) { lineSumByReceipt[it.receiptId] = (lineSumByReceipt[it.receiptId] || 0) + it.lineTotal; });

  function bucket() { return { total: 0, count: 0, cat: {}, store: {}, storeCount: {}, who: {}, item: {} }; }
  function add(b, r) {
    b.total += r.total; b.count += 1;
    b.store[r.store] = (b.store[r.store] || 0) + r.total;
    b.storeCount[r.store] = (b.storeCount[r.store] || 0) + 1;
    const w = r.who || 'Unknown';
    b.who[w] = (b.who[w] || 0) + r.total;
    const extra = round2_(r.total - (lineSumByReceipt[r.id] || 0));
    if (Math.abs(extra) >= 0.01) b.cat['Tax & tip'] = (b.cat['Tax & tip'] || 0) + extra;
  }
  function addItem(b, it) {
    b.cat[it.category] = (b.cat[it.category] || 0) + it.lineTotal;
    const key = it.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || it.lineTotal <= 0) return;
    if (!b.item[key]) b.item[key] = { name: it.name, total: 0, count: 0 };
    b.item[key].total += it.lineTotal;
    b.item[key].count += it.qty > 0 ? it.qty : 1;
  }
  function finish(b, topN) {
    const toList = function (obj, countObj) {
      return Object.keys(obj).map(function (k) {
        const o = { name: k, total: round2_(obj[k]) };
        if (countObj) o.count = countObj[k] || 0;
        return o;
      }).sort(function (a, b2) { return b2.total - a.total; });
    };
    return {
      total: round2_(b.total),
      count: b.count,
      byCategory: toList(b.cat),
      byStore: toList(b.store, b.storeCount).slice(0, topN),
      byWho: toList(b.who),
      topItems: Object.keys(b.item).map(function (k) {
        const o = b.item[k];
        return { name: o.name, total: round2_(o.total), count: Math.round(o.count * 100) / 100 };
      }).sort(function (a, b2) { return b2.total - a.total; }).slice(0, topN)
    };
  }

  const all = bucket();
  const monthB = {};
  receipts.forEach(function (r) {
    add(all, r);
    if (!monthB[r.month]) monthB[r.month] = bucket();
    add(monthB[r.month], r);
  });
  items.forEach(function (it) {
    addItem(all, it);
    if (monthB[it.month]) addItem(monthB[it.month], it);
  });

  const monthKeys = Object.keys(monthB).sort().reverse().slice(0, 24);
  const months = monthKeys.map(function (m) {
    const o = finish(monthB[m], 12);
    o.month = m;
    o.label = monthLabel_(m);
    return o;
  });

  const dates = receipts.map(function (r) { return r.date; }).sort();
  const recent = receipts.slice().sort(function (a, b) {
    return (b.date + b.id).localeCompare(a.date + a.id);
  }).slice(0, 30).map(function (r) {
    return { id: r.id, date: r.date, store: r.store, total: round2_(r.total), items: r.itemCount, who: r.who, needsReview: r.needsReview, photoUrl: r.photoUrl };
  });

  const allOut = finish(all, 15);
  allOut.from = dates[0] || null;
  allOut.to = dates[dates.length - 1] || null;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    currency: CONFIG.CURRENCY,
    sheetUrl: ss.getUrl(),
    needsReview: receipts.filter(function (r) { return r.needsReview; }).length,
    months: months,
    allTime: allOut,
    recent: recent
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
  }

  let ish = ss.getSheetByName(CONFIG.TABS.ITEMS);
  if (!ish) ish = ss.insertSheet(CONFIG.TABS.ITEMS);
  if (ish.getLastRow() === 0) {
    ish.getRange(1, 1, 1, CONFIG.ITEM_HEADERS.length).setValues([CONFIG.ITEM_HEADERS]).setFontWeight('bold');
    ish.setFrozenRows(1);
    ish.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    ish.getRange('F:G').setNumberFormat('#,##0.00');
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

function savePhoto_(b64, mime, receiptId) {
  const clean = String(b64).replace(/^data:[^;]+;base64,/, '');
  const bytes = Utilities.base64Decode(clean);
  const type = (mime && /^image\//.test(mime)) ? mime : 'image/jpeg';
  const ext = type === 'image/png' ? '.png' : (type === 'image/webp' ? '.webp' : '.jpg');
  const blob = Utilities.newBlob(bytes, type, receiptId + ext);
  return getFolder_().createFile(blob);
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

function parseIso_(s) {
  if (!s) return null;
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s;
  const d = new Date(String(s));
  return isNaN(d.getTime()) ? null : d;
}

function num_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
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
