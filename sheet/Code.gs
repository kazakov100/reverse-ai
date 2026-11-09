/**
 * reverse.ai reports: adds one row per report to the "Reports" tab of the "reverse.ai reports" sheet.
 * It only adds rows, never reads them, and only opens that one spreadsheet.
 * Reports arrive from https://reverseai.vercel.app/api/report (see api/report.mjs), which checks them first.
 * (A standalone project: the sheet's own script editor fails when several Google accounts are signed in.)
 */

const SHEET_ID = '1KyCmbMZ6v84Gp0MuBZdYv-m0GM8PIR13me76yp_h6vI';

const COLUMNS = ['Date & time', 'Report', 'What happened', 'Typed', 'Typed on keyboard', 'Changed to', 'Result', 'Why',
  'App', 'Version', 'System', 'Settings', 'Note', 'Status'];
// the fields Vercel sends, in column order (after the date; "Status" is left for you)
const FIELDS = ['report', 'happened', 'typed', 'from', 'to', 'result', 'why', 'app', 'version', 'system', 'settings', 'note'];
const DAILY_CAP = 300;

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply('bad'); }
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('SECRET');
  if (!secret || !body || body.secret !== secret || typeof body.row !== 'object') return reply('no');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const today = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
    const count = props.getProperty('day') === today ? Number(props.getProperty('count')) : 0;
    if (count >= DAILY_CAP) return reply('full');
    props.setProperties({ day: today, count: String(count + 1) });
    addRow(body.row);
  } finally {
    lock.releaseLock();
  }
  return reply('ok');
}

function addRow(row) {
  reports().appendRow([new Date()].concat(FIELDS.map(f => asText(row[f])), ['']));
}

/** A leading ' keeps every value plain text: never a formula (=IMPORTXML could leak the sheet), a date or a number. */
function asText(value) {
  const s = String(value == null ? '' : value).slice(0, 1000);
  return s === '' ? '' : "'" + s;
}

function reply(text) { return ContentService.createTextOutput(text); }

function reports() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('Reports');
  if (!sheet) { sheet = ss.getSheets()[0]; sheet.setName('Reports'); }
  return sheet;
}

/** Run once: headers, Israel time, and a random secret for Vercel. */
function setup() {
  SpreadsheetApp.openById(SHEET_ID).setSpreadsheetTimeZone('Asia/Jerusalem');
  const sheet = reports();
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm');
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  // not printed, so it never sits in the execution logs: copy it from Project Settings → Script properties
  console.log('Done. The secret for Vercel (REPORT_SECRET) is under Project Settings → Script properties → SECRET.');
}

/** Adds a sample row, including a formula-looking one that must show as plain text. Delete the rows afterwards. */
function testRow() {
  addRow({ report: 'Wrong suggestion', happened: 'Suggested in the bubble', typed: 'test from the script editor',
    from: 'English', to: 'Hebrew', result: '=1+1', why: 'Word lists, less sure', app: 'Script editor',
    version: '0.1.4', system: 'test', settings: '', note: '' });
}
