/**
 * Google Sheets as Database
 * 
 * Sheet structure:
 * - Sheet "cache": prefix | latestNumber | latestSrn | foundAt
 * - Sheet "records": SRN | Name | Sex | DOB | Father | Mother | Email | Mobile | ... 
 * 
 * Setup:
 * 1. Google Cloud Console → Enable Sheets API
 * 2. Create Service Account → Download JSON key
 * 3. Create Google Sheet → Share with service account email (Editor)
 * 4. Set env vars: GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 */

const { google } = require('googleapis');

let sheetsClient = null;
let sheetsReady = false;

const SHEET_ID = process.env.GOOGLE_SHEETS_ID || '';
const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function isConfigured() {
  return !!(SHEET_ID && SERVICE_EMAIL && PRIVATE_KEY);
}

async function getSheets() {
  if (sheetsClient) return sheetsClient;

  if (!isConfigured()) {
    throw new Error('Google Sheets not configured. Set GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY in .env');
  }

  const auth = new google.auth.JWT(
    SERVICE_EMAIL,
    null,
    PRIVATE_KEY,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  sheetsClient = google.sheets({ version: 'v4', auth });
  sheetsReady = true;
  return sheetsClient;
}

// ─── CACHE OPERATIONS ───────────────────────────────────────────────────────

async function getCacheFromSheets() {
  if (!isConfigured()) return {};
  
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'cache!A:D'
    });

    const rows = res.data.values || [];
    const cache = {};

    // Skip header row
    for (let i = 1; i < rows.length; i++) {
      const [prefix, number, srn, foundAt] = rows[i];
      if (prefix) {
        cache[prefix] = {
          number: Number(number),
          srn: srn || '',
          foundAt: foundAt || ''
        };
      }
    }

    return cache;
  } catch (e) {
    console.log('[SHEETS-DB] getCacheFromSheets error:', e.message);
    return {};
  }
}

async function saveCacheToSheets(prefix, number, srn, foundAt) {
  if (!isConfigured()) return;

  try {
    const sheets = await getSheets();

    // Read existing cache
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'cache!A:D'
    });

    const rows = res.data.values || [];
    let found = false;

    // Find existing row for this prefix
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === prefix) {
        // Update existing row
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `cache!A${i + 1}:D${i + 1}`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [[prefix, String(number), srn, foundAt]]
          }
        });
        found = true;
        break;
      }
    }

    if (!found) {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'cache!A:D',
        valueInputOption: 'RAW',
        requestBody: {
          values: [[prefix, String(number), srn, foundAt]]
        }
      });
    }

    console.log(`[SHEETS-DB] Cache saved: ${prefix} = ${srn} (${foundAt})`);
  } catch (e) {
    console.log('[SHEETS-DB] saveCacheToSheets error:', e.message);
  }
}

// ─── RECORDS OPERATIONS ─────────────────────────────────────────────────────

const RECORD_HEADERS = [
  'SRN', 'Name', 'Sex', 'Date of Birth', 'Father', 'Mother',
  'Email', 'Mobile', 'Aadhar Category', 'Correspondence Address',
  'Permanent Address', 'Pin', 'CA Foundation', 'CA Foundation Reg Date',
  'CA Inter', 'CA Inter Reg Date', 'CA Final', 'CA Final Reg Date',
  'Extracted At'
];

async function ensureRecordsHeader() {
  if (!isConfigured()) return;

  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'records!A1:S1'
    });

    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'records!A1:S1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [RECORD_HEADERS]
        }
      });
    }
  } catch (e) {
    console.log('[SHEETS-DB] ensureRecordsHeader error:', e.message);
  }
}

async function saveRecordsToSheets(records) {
  if (!isConfigured() || !records || records.length === 0) return;

  try {
    await ensureRecordsHeader();
    const sheets = await getSheets();

    const rows = records.map(data => [
      data.srn || '',
      data.name || '',
      data.sex || '',
      data.dob || '',
      data.father || '',
      data.mother || '',
      data.email || '',
      data.mobile || '',
      data.aadharCategory || '',
      data.correspondenceAddress || '',
      data.permanentAddress || '',
      data.pin || '',
      data.courseRows ? (data.courseRows.find(r => r.level === 'FOUNDATION') ? 'YES' : 'NO') : '',
      data.courseRows ? ((data.courseRows.find(r => r.level === 'FOUNDATION') || {}).registrationDate || '') : '',
      data.courseRows ? (data.courseRows.find(r => r.level === 'INTERMEDIATE') ? 'YES' : 'NO') : '',
      data.courseRows ? ((data.courseRows.find(r => r.level === 'INTERMEDIATE') || {}).registrationDate || '') : '',
      data.courseRows ? (data.courseRows.find(r => r.level === 'FINAL') ? 'YES' : 'NO') : '',
      data.courseRows ? ((data.courseRows.find(r => r.level === 'FINAL') || {}).registrationDate || '') : '',
      new Date().toISOString()
    ]);

    // Append in batches of 500
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'records!A:S',
        valueInputOption: 'RAW',
        requestBody: {
          values: batch
        }
      });
    }

    console.log(`[SHEETS-DB] Saved ${records.length} records to Google Sheets`);
  } catch (e) {
    console.log('[SHEETS-DB] saveRecordsToSheets error:', e.message);
  }
}

async function getRecordCount() {
  if (!isConfigured()) return 0;

  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'records!A:A'
    });
    return Math.max(0, (res.data.values || []).length - 1); // minus header
  } catch (e) {
    return 0;
  }
}

module.exports = {
  isConfigured,
  getCacheFromSheets,
  saveCacheToSheets,
  saveRecordsToSheets,
  getRecordCount
};
