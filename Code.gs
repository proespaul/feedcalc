/**
 * PRO Electrical | Price feed for the Feed Calculator
 *
 * Serves the priced rows of the "Materials Price List" sheet as JSON so the app can price a cable run
 * and search for gear. Add ?wire=1 to the URL for the wire and breaker rows only.
 * Read-only: this script never writes to the sheet.
 *
 * Deploy once (script.google.com -> New project -> paste this file):
 *   Deploy -> New deployment -> Type: Web app
 *   Execute as: Me            Who has access: Anyone
 * Copy the Web app URL into the app's Settings (Price feed address), and put ACCESS_KEY into the Key field.
 * Re-deploy (Manage deployments -> edit -> New version) after any change to this file.
 */

var SHEET_ID = '1erIb5pS5gdMb8VdpCRmDH-GgLSQ_CrLkKIQfZxq2xRk'; // Materials Price List
var TAB_NAME = 'Materials';                                    // falls back to the first tab if not found
var ACCESS_KEY = 'pro-vd-7k2m9q';                              // change it here and in the app if it ever leaks

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (ACCESS_KEY && params.key !== ACCESS_KEY) {
      return out_({ ok: false, error: 'Key does not match' });
    }
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(TAB_NAME) || ss.getSheets()[0];
    var values = sh.getDataRange().getValues();

    // Header row: the first row containing both "SKU" and "Description".
    var hi = -1;
    for (var i = 0; i < Math.min(values.length, 20); i++) {
      var joined = values[i].join('|').toLowerCase();
      if (joined.indexOf('sku') >= 0 && joined.indexOf('desc') >= 0) { hi = i; break; }
    }
    if (hi < 0) return out_({ ok: false, error: 'Header row with SKU and Description not found on tab ' + sh.getName() });

    var header = values[hi].map(function (h) { return String(h).toLowerCase().trim(); });
    var col = function (re) { for (var c = 0; c < header.length; c++) if (re.test(header[c])) return c; return -1; };
    var ci = {
      sku: col(/^sku/), desc: col(/^desc/), unit: col(/^unit/), inv: col(/^invent/), price: col(/^price/),
      supplier: col(/last bought from/), bought: col(/^last bought$/), lowest: col(/^lowest/), cheapestAt: col(/^cheapest/),
      parts: col(/part number/)
    };

    // Everything priced, by default: the app prices cable and breakers automatically, and its equipment
    // picker searches the rest. Pass wire=1 for the old wire-and-breaker-only feed.
    var wireOnly = params.wire === '1';
    var wireRe = /NMD\s*-?90|NMWU|ACWU|TECK|\bAC\s*-?90\b|RW90|RWU90|\bT90\b|\bTWU\b|USEB|\bBX\b|LOOMEX|ROMEX/i;
    var rows = [];
    for (var r = hi + 1; r < values.length; r++) {
      var row = values[r];
      var sku = String(row[ci.sku] || '').trim();
      var desc = String(row[ci.desc] || '').trim();
      if (!sku || !desc) continue;
      var price = ci.price >= 0 ? num_(row[ci.price]) : null;
      if (price == null) continue;                       // nothing to price with
      if (wireOnly) {
        var groundRe = /ground|bond|acorn/i;
        if (!(/^(WIRE|BRK)/i.test(sku) || wireRe.test(desc) || /breaker/i.test(desc) || groundRe.test(desc))) continue;
      }
      rows.push({
        sku: sku,
        desc: desc,
        unit: ci.unit >= 0 ? String(row[ci.unit] || '') : '',
        inv: ci.inv >= 0 ? row[ci.inv] : null,
        price: price,
        supplier: ci.supplier >= 0 ? String(row[ci.supplier] || '') : '',
        bought: ci.bought >= 0 ? date_(row[ci.bought]) : '',
        lowest: ci.lowest >= 0 ? num_(row[ci.lowest]) : null,
        cheapestAt: ci.cheapestAt >= 0 ? String(row[ci.cheapestAt] || '') : '',
        parts: ci.parts >= 0 ? String(row[ci.parts] || '') : ''
      });
    }

    var updated = null;
    try { updated = DriveApp.getFileById(SHEET_ID).getLastUpdated().toISOString(); } catch (err) { updated = null; }
    if (!updated) {
      // Fall back to the newest purchase date on the rows returned.
      var newest = '';
      rows.forEach(function (x) { if (x.bought && x.bought > newest) newest = x.bought; });
      updated = newest || null;
    }
    return out_({ ok: true, sheet: ss.getName(), tab: sh.getName(), updated: updated, served: new Date().toISOString(), count: rows.length, rows: rows });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function num_(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function date_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run this once from the editor to check the sheet reads correctly (View -> Logs).
function testFeed() {
  var res = doGet({ parameter: { key: ACCESS_KEY } });
  var txt = res.getContent();
  Logger.log(txt.slice(0, 1500));
}
