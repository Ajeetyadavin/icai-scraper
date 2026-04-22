const path = require('path');
const fs = require('fs');
const readline = require('readline');
const express = require('express');
const { chromium } = require('playwright');
const pdfParse = require('pdf-parse');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Debug: Check if env vars are loaded
console.log('[SERVER] ICAI_USER_ID loaded:', !!process.env.ICAI_USER_ID);
console.log('[SERVER] ICAI_PASSWORD loaded:', !!process.env.ICAI_PASSWORD);

const app = express();
const PORT = Number(process.env.PORT || 4173);

const BASE_TEMPLATE_URL =
  process.env.STUDENT_CARD_TEMPLATE_URL ||
  'https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&argnum=2&formId=57499&1666=1666&appSeqNo=APP3908399&checksum=gygBwj9R%252F5aDFtG%252BwBcvBw%253D%253D&entityId=3908399&sessChk=1775935472848&callForOrg=ICAI&user_id=&requiredReport=StudentCard&PDFName=StudentCard&studentRegNo=WRO0873063';

let browser;
let authContext;
let authAt = 0;
let authInFlight;

function isPdfBuffer(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function buildUrl(baseTemplate, regNo) {
  const url = new URL(baseTemplate);
  url.searchParams.set('studentRegNo', regNo);
  return url.toString();
}

function getAfter(lines, label) {
  const idx = lines.indexOf(label);
  return idx >= 0 ? lines[idx + 1] || '' : '';
}

function getBetween(lines, startLabel, endLabel) {
  const startIdx = lines.indexOf(startLabel);
  if (startIdx === -1) return '';

  const endIdx = endLabel ? lines.indexOf(endLabel, startIdx + 1) : -1;
  const slice = endIdx === -1 ? lines.slice(startIdx + 1) : lines.slice(startIdx + 1, endIdx);
  return slice.join(' ').trim();
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsvLine(values) {
  return values.map((v) => csvEscape(v)).join(',');
}

function normalizeCourseDetails(courseRows) {
  if (!Array.isArray(courseRows) || courseRows.length === 0) {
    return '';
  }

  return courseRows
    .map((row) => {
      const level = row.level || '';
      const course = row.course || '';
      const examType = row.examType || '';
      const regDate = row.registrationDate || '';
      const reRegDate = row.reRegistrationDate || '';
      const month = row.monthOfPassing || '';
      const year = row.yearOfPassing || '';
      const roll = row.rollNo || '';
      const mark = row.mark || '';
      const maxMark = row.maxMark || '';
      const pct = row.percentage || '';
      const result = row.resultStatus || '';
      return [level, course, examType, regDate, reRegDate, month, year, roll, mark, maxMark, pct, result]
        .join(' ')
        .trim();
    })
    .join(' || ');
}

function parseSrnRangeExpression(input) {
  const value = String(input || '').trim().toUpperCase();
  const match = value.match(/^([A-Z]{3})(\d{7})\s*\+\s*(\d{1,5})$/);
  if (!match) {
    return null;
  }

  const prefix = match[1];
  const startNo = Number(match[2]);
  const count = Number(match[3]);
  if (!Number.isFinite(startNo) || !Number.isFinite(count) || count < 1) {
    return null;
  }

  return {
    prefix,
    startNo,
    count,
    startSrn: `${prefix}${String(startNo).padStart(7, '0')}`
  };
}

function buildSrnList(prefix, startNo, count) {
  const srns = [];
  for (let i = 0; i < count; i += 1) {
    srns.push(`${prefix}${String(startNo + i).padStart(7, '0')}`);
  }
  return srns;
}

async function fetchRangeRows(srns, concurrency = 5) {
  const results = new Array(srns.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= srns.length) {
        break;
      }

      const srn = srns[idx];
      try {
        const data = await fetchStudentCardData(srn);
        results[idx] = {
          status: 'ok',
          srn,
          data,
          error: ''
        };
      } catch (error) {
        results[idx] = {
          status: 'error',
          srn,
          data: null,
          error: error && error.message ? error.message : 'Unknown fetch error'
        };
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, srns.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function parseCsvLine(line) {
  const row = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (ch === ',' && !quoted) {
      row.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  row.push(current);
  return row;
}

function mapCsvStudentRecord(headers, values) {
  const get = (name) => values[headers.indexOf(name)] || '';

  return {
    srn: normalizeText(get('SRN')),
    name: normalizeText(get('Name')),
    sex: normalizeText(get('Sex')),
    dob: normalizeText(get('Date of Birth')),
    father: normalizeText(get('Father')),
    mother: normalizeText(get('Mother')),
    email: normalizeText(get('Email')),
    mobile: normalizeText(get('Mobile')),
    aadharCategory: normalizeText(get('Aadhar Category')),
    correspondenceAddress: normalizeText(get('Correspondence Address')),
    permanentAddress: normalizeText(get('Permanent Address')),
    pin: normalizeText(get('Pin')),
    courseRows: []
  };
}

async function findStudentByMobileInOutput(mobile) {
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    return null;
  }

  const entries = await fs.promises.readdir(outputDir, { withFileTypes: true });
  const csvFiles = entries
    .filter((entry) => entry.isFile() && /^students_batch_\d+_\d+\.csv$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  for (const fileName of csvFiles) {
    const filePath = path.join(outputDir, fileName);
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let headers = null;
    let foundRecord = null;

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      if (!headers) {
        headers = parseCsvLine(line).map((h) => h.trim());
        continue;
      }

      const values = parseCsvLine(line);
      const mobileIdx = headers.indexOf('Mobile');
      if (mobileIdx < 0) {
        break;
      }

      const rowMobile = normalizeMobile(values[mobileIdx]);
      if (rowMobile === mobile) {
        foundRecord = mapCsvStudentRecord(headers, values);
        break;
      }
    }

    rl.close();
    stream.destroy();

    if (foundRecord) {
      return {
        data: foundRecord,
        sourceFile: fileName
      };
    }
  }

  return null;
}

function getOutputDir() {
  return path.join(__dirname, 'output');
}

async function listOutputCsvFiles() {
  const outputDir = getOutputDir();
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  const entries = await fs.promises.readdir(outputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

function resolveCsvFileFromOutput(name) {
  const safeName = path.basename(String(name || ''));
  if (!safeName || safeName !== String(name || '') || !safeName.toLowerCase().endsWith('.csv')) {
    throw new Error(`Invalid file name: ${name}`);
  }
  return path.join(getOutputDir(), safeName);
}

function remapCsvValues(targetHeaders, sourceHeaders, sourceValues) {
  return targetHeaders.map((header) => {
    const idx = sourceHeaders.indexOf(header);
    return idx >= 0 ? sourceValues[idx] || '' : '';
  });
}

async function mergeCsvFiles(fileNames, dedupeSrn) {
  let primaryHeaders = null;
  let mergedCount = 0;
  let duplicateCount = 0;
  const seenSrns = new Set();
  const outputLines = [];

  for (const fileName of fileNames) {
    const filePath = resolveCsvFileFromOutput(fileName);
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let currentHeaders = null;
    let srnSourceIdx = -1;
    let srnPrimaryIdx = -1;

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      if (!currentHeaders) {
        currentHeaders = parseCsvLine(line).map((h) => h.trim());
        srnSourceIdx = currentHeaders.indexOf('SRN');

        if (!primaryHeaders) {
          primaryHeaders = currentHeaders;
          srnPrimaryIdx = primaryHeaders.indexOf('SRN');
          outputLines.push(buildCsvLine(primaryHeaders));
        } else {
          srnPrimaryIdx = primaryHeaders.indexOf('SRN');
        }
        continue;
      }

      const sourceValues = parseCsvLine(line);
      const mappedValues = remapCsvValues(primaryHeaders, currentHeaders, sourceValues);

      if (dedupeSrn && srnPrimaryIdx >= 0) {
        let srnValue = mappedValues[srnPrimaryIdx] || '';
        if (!srnValue && srnSourceIdx >= 0) {
          srnValue = sourceValues[srnSourceIdx] || '';
        }

        const key = normalizeText(srnValue).toUpperCase();
        if (key) {
          if (seenSrns.has(key)) {
            duplicateCount += 1;
            continue;
          }
          seenSrns.add(key);
        }
      }

      outputLines.push(buildCsvLine(mappedValues));
      mergedCount += 1;
    }

    rl.close();
    stream.destroy();
  }

  if (!primaryHeaders) {
    throw new Error('No valid CSV data found in selected files');
  }

  return {
    csv: `${outputLines.join('\n')}\n`,
    mergedCount,
    duplicateCount
  };
}

function isCourseCode(value) {
  return /^[A-Z]{3,}[A-Z0-9]*\d{2,}$/i.test(value || '');
}

function isDateValue(value) {
  return /^\d{2}\/[A-Za-z]{3}\/[0-9]{4}$/.test(value || '');
}

function isMonthValue(value) {
  return /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)$/i.test(
    value || ''
  );
}

function isYearValue(value) {
  return /^(19|20)\d{2}$/.test(value || '');
}

function isNumericValue(value) {
  return /^\d+(\.\d+)?$/.test(value || '');
}

function isResultStatus(value) {
  return /^(PASSED|FAILED|ABSENT|WITHHELD|PENDING)$/i.test(value || '');
}

function getCourseLevel(course) {
  const c = String(course || '').toUpperCase();
  if (c.includes('NEWFND') || c.includes('FOUND')) return 'FOUNDATION';
  if (c.includes('NEWINT') || c.includes('INTER')) return 'INTERMEDIATE';
  return 'OTHER';
}

function parseCourseRows(lines) {
  const start = lines.indexOf('COURSE AND EXAM DETAILS:');
  if (start === -1) {
    return [];
  }

  const section = lines.slice(start + 1).filter((line) => line !== 'Phone');
  const rows = [];
  let i = 0;

  while (i < section.length) {
    const token = section[i];
    if (!isCourseCode(token)) {
      i += 1;
      continue;
    }

    const row = {
      course: token,
      level: getCourseLevel(token),
      examType: '',
      registrationDate: '',
      reRegistrationDate: '',
      monthOfPassing: '',
      yearOfPassing: '',
      rollNo: '',
      mark: '',
      maxMark: '',
      percentage: '',
      resultStatus: ''
    };

    i += 1;

    if (i < section.length && !isCourseCode(section[i])) {
      row.examType = section[i];
      i += 1;
    }

    if (i < section.length && isDateValue(section[i])) {
      row.registrationDate = section[i];
      i += 1;
    }

    if (i < section.length && isDateValue(section[i])) {
      row.reRegistrationDate = section[i];
      i += 1;
    }

    if (i < section.length && isMonthValue(section[i])) {
      row.monthOfPassing = section[i];
      i += 1;
    }

    if (i < section.length && isYearValue(section[i])) {
      row.yearOfPassing = section[i];
      i += 1;
    }

    if (i < section.length && /^[A-Z0-9]{4,}$/i.test(section[i]) && !isCourseCode(section[i])) {
      row.rollNo = section[i];
      i += 1;
    }

    if (i < section.length && isNumericValue(section[i])) {
      row.mark = section[i];
      i += 1;
    }

    if (i < section.length && isNumericValue(section[i])) {
      row.maxMark = section[i];
      i += 1;
    }

    if (i < section.length && isNumericValue(section[i])) {
      row.percentage = section[i];
      i += 1;
    }

    if (i < section.length && isResultStatus(section[i])) {
      row.resultStatus = section[i];
      i += 1;
    }

    rows.push(row);
  }

  return rows;
}

function parseStudentCardText(text, regNo) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let aadharCategory = '';
  const aadharIdx = lines.findIndex((line) => line === 'Aadhar');
  if (aadharIdx >= 0 && lines[aadharIdx + 1] === 'Category') {
    aadharCategory = lines[aadharIdx + 2] || '';
  }

  const courseRows = parseCourseRows(lines);

  return {
    srn: getAfter(lines, 'SRN') || regNo,
    name: normalizeText(getAfter(lines, 'Name')),
    sex: normalizeText(getAfter(lines, 'Sex')),
    dob: normalizeText(getAfter(lines, 'Date of Birth')),
    father: normalizeText(getAfter(lines, 'Father')),
    mother: normalizeText(getAfter(lines, 'Mother')),
    email: normalizeText(getAfter(lines, 'Email')),
    mobile: normalizeText(getAfter(lines, 'Mobile')),
    aadharCategory: normalizeText(aadharCategory),
    correspondenceAddress: normalizeText(getBetween(lines, 'Correspondence Address', 'Permanent Address')),
    permanentAddress: normalizeText(getBetween(lines, 'Permanent Address', 'Pin')),
    pin: normalizeText(getAfter(lines, 'Pin')),
    courseRows
  };
}

function isSessionFresh() {
  const fresh = authContext && Date.now() - authAt < 15 * 60 * 1000;
  console.log('[isSessionFresh] authContext:', !!authContext, 'fresh:', fresh, 'authAt:', new Date(authAt).toISOString());
  return fresh;
}

function shouldReauth(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  return msg.includes('context or browser has been closed') || msg.includes('target page') || msg.includes('session');
}

async function closeAuthContext() {
  if (authContext) {
    await authContext.close().catch(() => {});
    authContext = null;
  }
}

async function ensureAuthenticatedContext() {
  if (isSessionFresh()) return authContext;
  if (authInFlight) return authInFlight;

  authInFlight = (async () => {
    await closeAuthContext();

    if (!browser || !browser.isConnected()) {
      browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled']
      });
    }

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 }
    });

    const page = await context.newPage();
    await page.goto('https://eservices.icai.org/', { waitUntil: 'domcontentloaded', timeout: 90000 });

    const userId = process.env.ICAI_USER_ID || '';
    const password = process.env.ICAI_PASSWORD || '';
    console.log('[ensureAuthenticatedContext] Checking env - userId:', !!userId, 'password:', !!password);
    if (!userId || !password) {
      console.log('[ensureAuthenticatedContext] Credentials missing!');
      throw new Error('Missing ICAI_USER_ID or ICAI_PASSWORD in .env');
    }

    await page.fill('#accountname', userId);
    await page.fill('#password', password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null),
      page.click('button:has-text("Sign In"), .loginBtn')
    ]);

    await page.waitForTimeout(1800);
    const closeModal = page.locator('button:has-text("Close")').first();
    if (await closeModal.count()) {
      await closeModal.click().catch(() => {});
    }

    authContext = context;
    authAt = Date.now();
    return authContext;
  })();

  try {
    return await authInFlight;
  } finally {
    authInFlight = null;
  }
}

async function fetchStudentCardData(srn) {
  const secureUrl = buildUrl(BASE_TEMPLATE_URL, srn);

  const attemptFetch = async () => {
    const context = await ensureAuthenticatedContext();
    const response = await context.request.get(secureUrl, {
      headers: {
        Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8',
        Referer: 'https://eservices.icai.org/'
      },
      timeout: 90000
    });

    const body = await response.body();
    const contentType = (response.headers()['content-type'] || '').toLowerCase();

    if (!response.ok()) {
      throw new Error(`ICAI request failed: HTTP ${response.status()}`);
    }

    if (contentType.includes('text/html') || !isPdfBuffer(body)) {
      throw new Error('ICAI returned non-PDF response (likely blocked or SRN not found)');
    }

    const pdf = await pdfParse(body);
    const parsed = parseStudentCardText(pdf.text || '', srn);
    if (!parsed.srn || !parsed.name) {
      throw new Error('Unable to parse PDF content for SRN');
    }

    return parsed;
  };

  try {
    return await attemptFetch();
  } catch (error) {
    if (!shouldReauth(error)) {
      throw error;
    }

    await closeAuthContext();
    authAt = 0;
    return await attemptFetch();
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post('/api/login', async (_req, res) => {
  try {
    console.log('[LOGIN] Endpoint called');
    const userId = process.env.ICAI_USER_ID || '';
    const password = process.env.ICAI_PASSWORD || '';
    console.log('[LOGIN] Env check - userId:', !!userId, 'password:', !!password);
    if (!userId || !password) {
      console.log('[LOGIN] Credentials missing in .env');
      return res.status(400).json({
        ok: false,
        error: 'Missing ICAI_USER_ID or ICAI_PASSWORD in .env'
      });
    }
    
    // Test authentication by ensuring context
    console.log('[LOGIN] Calling ensureAuthenticatedContext...');
    const ctx = await ensureAuthenticatedContext();
    console.log('[LOGIN] Auth context created:', !!ctx);
    if (ctx) {
      return res.json({ ok: true, message: 'Authenticated' });
    }
    return res.status(401).json({ ok: false, error: 'Authentication failed' });
  } catch (error) {
    console.log('[LOGIN] Error:', error && error.message);
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : 'Login failed'
    });
  }
});

app.get('/api/csv-files', async (_req, res) => {
  try {
    const files = await listOutputCsvFiles();
    return res.json({ ok: true, files });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : 'Unable to list CSV files'
    });
  }
});

app.get('/api/search', async (req, res) => {
  const srn = String(req.query.srn || '').trim().toUpperCase();
  console.log('[SEARCH] SRN:', srn);
  if (!/^[A-Z]{3}\d{7}$/.test(srn)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid SRN format. Example: WRO0873000'
    });
  }

  const startedAt = Date.now();
  try {
    console.log('[SEARCH] Calling fetchStudentCardData for:', srn);
    const data = await fetchStudentCardData(srn);
    const durationMs = Date.now() - startedAt;

    return res.json({
      ok: true,
      durationMs,
      data
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Unknown backend error';
    return res.status(502).json({
      ok: false,
      error: message
    });
  }
});

app.get('/api/search-by-mobile', async (req, res) => {
  const rawMobile = String(req.query.mobile || '').trim();
  const mobile = normalizeMobile(rawMobile);

  if (!/^\d{10}$/.test(mobile)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid mobile format. Example: 9876543210'
    });
  }

  const startedAt = Date.now();
  try {
    const record = await findStudentByMobileInOutput(mobile);
    if (!record) {
      return res.status(404).json({
        ok: false,
        error: 'No student found for this mobile number in local output CSV files.'
      });
    }

    return res.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      source: 'local-csv',
      sourceFile: record.sourceFile,
      data: record.data
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Unable to search by mobile';
    return res.status(502).json({
      ok: false,
      error: message
    });
  }
});

app.get('/api/export-range', async (req, res) => {
  const expr = String(req.query.range || '').trim();
  const parsed = parseSrnRangeExpression(expr);

  if (!parsed) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid range format. Example: WRO0942133 +1000'
    });
  }

  if (parsed.count > 2000) {
    return res.status(400).json({
      ok: false,
      error: 'Range too large. Max allowed is +2000 per request.'
    });
  }

  const srns = buildSrnList(parsed.prefix, parsed.startNo, parsed.count);
  const startedAt = Date.now();
  const rows = await fetchRangeRows(srns, 6);

  const headers = [
    'Status',
    'Error',
    'SRN',
    'Name',
    'Sex',
    'Date of Birth',
    'Father',
    'Mother',
    'Email',
    'Mobile',
    'Aadhar Category',
    'Correspondence Address',
    'Permanent Address',
    'Pin',
    'Course & Exam Details'
  ];

  const csvLines = [buildCsvLine(headers)];
  for (const row of rows) {
    const data = row.data || {};
    csvLines.push(
      buildCsvLine([
        row.status,
        row.error,
        row.srn,
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
        normalizeCourseDetails(data.courseRows || [])
      ])
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const okCount = rows.filter((r) => r.status === 'ok').length;
  const failedCount = rows.length - okCount;
  const fileName = `students_${parsed.startSrn}_plus${parsed.count}_${Date.now()}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('X-Export-Total', String(rows.length));
  res.setHeader('X-Export-Ok', String(okCount));
  res.setHeader('X-Export-Failed', String(failedCount));
  res.setHeader('X-Export-Duration-Ms', String(elapsedMs));
  return res.send(`${csvLines.join('\n')}\n`);
});

app.post('/api/merge-csv', async (req, res) => {
  const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
  const dedupeSrn = req.body && req.body.dedupeSrn !== false;

  if (files.length < 2) {
    return res.status(400).json({
      ok: false,
      error: 'Select at least 2 CSV files to merge.'
    });
  }

  if (files.length > 100) {
    return res.status(400).json({
      ok: false,
      error: 'Too many files selected. Max 100 files per merge request.'
    });
  }

  const normalized = files.map((f) => path.basename(String(f || '')));
  const uniqueFiles = [...new Set(normalized)];

  try {
    const available = new Set(await listOutputCsvFiles());
    for (const name of uniqueFiles) {
      if (!available.has(name)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid or missing CSV file: ${name}`
        });
      }
    }

    const startedAt = Date.now();
    const merged = await mergeCsvFiles(uniqueFiles, dedupeSrn);
    const durationMs = Date.now() - startedAt;
    const fileName = `merged_${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Merge-Files', String(uniqueFiles.length));
    res.setHeader('X-Merge-Rows', String(merged.mergedCount));
    res.setHeader('X-Merge-Duplicates', String(merged.duplicateCount));
    res.setHeader('X-Merge-Duration-Ms', String(durationMs));
    return res.send(merged.csv);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : 'CSV merge failed'
    });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

process.on('SIGINT', async () => {
  await closeAuthContext();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeAuthContext();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`ICAI Search Web app running: http://localhost:${PORT}`);
  });
}

module.exports = app;
