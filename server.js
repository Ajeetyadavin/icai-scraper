const path = require('path');
const fs = require('fs');
const readline = require('readline');
const express = require('express');
const multer = require('multer');
const { chromium } = require('playwright');
const pdfParse = require('pdf-parse');
const { Pool } = require('undici');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const sheetsDb = require('./src/sheets-db');

// Remove Node.js default socket limits
require('http').globalAgent.maxSockets = Infinity;
require('https').globalAgent.maxSockets = Infinity;

// Undici connection pool — fastest HTTP client for Node.js
const icaiPool = new Pool('https://eservices.icai.org', {
  connections: 2000,
  pipelining: 10,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 120000,
  headersTimeout: 8000,
  bodyTimeout: 8000,
  connect: {
    rejectUnauthorized: false
  }
});

// Debug: Check if env vars are loaded
console.log('[SERVER] ICAI_USER_ID loaded:', !!process.env.ICAI_USER_ID);
console.log('[SERVER] ICAI_PASSWORD loaded:', !!process.env.ICAI_PASSWORD);

const app = express();
const PORT = Number(process.env.PORT || 4173);
const DEFAULT_STUDENT_PREFIX = normalizeStudentPrefix(process.env.STUDENT_PREFIX) || 'WRO';
const DEFAULT_START_NUMBER = String(process.env.START_NUMBER || '873000').replace(/\D/g, '').padStart(7, '0').slice(-7);
const DEFAULT_START_SRN = `${DEFAULT_STUDENT_PREFIX}${DEFAULT_START_NUMBER}`;
const MAX_EXPORT_COUNT = Number(process.env.MAX_EXPORT_COUNT || 999999);
const DEFAULT_EXPORT_CONCURRENCY = Number(process.env.EXPORT_CONCURRENCY || 2000);
const MAX_EXPORT_CONCURRENCY = Number(process.env.MAX_EXPORT_CONCURRENCY || 5000);

const BASE_TEMPLATE_URL =
  process.env.STUDENT_CARD_TEMPLATE_URL ||
  'https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&argnum=2&formId=57499&1666=1666&appSeqNo=APP3908399&checksum=gygBwj9R%252F5aDFtG%252BwBcvBw%253D%253D&entityId=3908399&sessChk=1775935472848&callForOrg=ICAI&user_id=&requiredReport=StudentCard&PDFName=StudentCard&studentRegNo=WRO0873063';

let browser;
let authContext;
let authAt = 0;
let authInFlight;
let authCookieString = ''; // Cached cookies for direct HTTP

// Proxy pool for IP rotation
let proxyList = [];
let proxyContexts = []; // Array of { proxy, context, authAt }
let proxyRoundRobin = 0;
const PROXY_API_URL = 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&timeout=5000&ssl=all&anonymity=all';

async function fetchFreshProxies() {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(PROXY_API_URL, (res) => {
        let d = '';
        res.on('data', chunk => { d += chunk; });
        res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    const proxies = data.split(/\r?\n/).map(l => l.trim()).filter(l => l && /^\d/.test(l));
    if (proxies.length > 5) {
      proxyList = proxies.map(p => `http://${p}`);
      console.log(`[PROXY] Auto-fetched ${proxyList.length} fresh proxies`);
      fs.writeFileSync(path.join(__dirname, 'proxies.txt'), proxies.join('\n'), 'utf-8');
    }
  } catch (err) {
    console.log(`[PROXY] API fetch failed: ${err.message}. Using local file.`);
  }
}

function loadProxyList() {
  const proxyFile = path.join(__dirname, 'proxies.txt');
  if (fs.existsSync(proxyFile)) {
    const fileProxies = fs.readFileSync(proxyFile, 'utf-8')
      .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    proxyList = fileProxies.map(p => p.startsWith('http') ? p : `http://${p}`);
  }
  // From env comma-separated (override)
  const envList = process.env.PROXY_LIST || '';
  if (envList.trim()) {
    proxyList = envList.split(',').map(p => p.trim()).filter(Boolean);
  }
  if (proxyList.length > 0) {
    console.log(`[PROXY] Loaded ${proxyList.length} proxies for rotation`);
  } else {
    console.log(`[PROXY] No proxies loaded. Single-IP mode.`);
  }
}

loadProxyList();
// Proxy fetching disabled — no WAF rate limiting anymore

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

function getCourseRowByLevel(courseRows, level) {
  if (!Array.isArray(courseRows)) return null;
  return courseRows.find((row) => String(row.level || '').toUpperCase() === level) || null;
}

function formatCourseAvailability(row) {
  if (!row) return 'NO';
  const courseCode = String(row.course || '').trim();
  return courseCode ? `YES ${courseCode}` : 'YES';
}

function normalizeStudentPrefix(value) {
  const prefix = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(prefix) ? prefix : '';
}

function normalizeSevenDigitNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length ? digits.padStart(7, '0').slice(-7) : '';
}

function parseSrnRangeExpression(input, fallbackPrefix = DEFAULT_STUDENT_PREFIX) {
  const value = String(input || '').trim().toUpperCase();
  const match = value.match(/^(?:([A-Z]{3}))?(\d{7})\s*\+\s*(\d{1,5})$/);
  if (!match) {
    return null;
  }

  const prefix = normalizeStudentPrefix(match[1] || fallbackPrefix) || fallbackPrefix;
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

function parseRangeRequest(query) {
  const range = String(query.range || '').trim();
  if (range) {
    return parseSrnRangeExpression(range);
  }

  const prefix = normalizeStudentPrefix(query.prefix) || DEFAULT_STUDENT_PREFIX;
  const startNoText = normalizeSevenDigitNumber(query.start || query.startNo || query.srn);
  const count = Number(query.count);

  if (!prefix || !/^\d{7}$/.test(startNoText) || !Number.isFinite(count) || count < 1) {
    return null;
  }

  return {
    prefix,
    startNo: Number(startNoText),
    count,
    startSrn: `${prefix}${startNoText}`
  };
}

function resolveExportConcurrency(requested, count) {
  const requestedValue = Number(requested);
  const preferred = Number.isFinite(requestedValue) && requestedValue > 0 ? requestedValue : DEFAULT_EXPORT_CONCURRENCY;
  return Math.max(1, Math.min(preferred, MAX_EXPORT_CONCURRENCY, count));
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
  if (c.includes('NEWFND') || c.includes('NEWFIN') || c.includes('FND') || c.includes('FOUND')) return 'FOUNDATION';
  if (c.includes('NEWINT') || c.includes('INTER')) return 'INTERMEDIATE';
  if (c.includes('NEWFNL') || c.includes('FNL') || c.includes('FINAL')) return 'FINAL';
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
  if (!authContext) return false;
  const fresh = Date.now() - authAt < 15 * 60 * 1000;
  return fresh;
}

function shouldReauth(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  return msg.includes('context or browser has been closed') || msg.includes('target page') || msg.includes('session');
}

function isWafBlock(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  return msg.includes('access denied') || msg.includes('waf blocked');
}

async function closeAuthContext() {
  if (authContext) {
    await authContext.close().catch(() => {});
    authContext = null;
  }
}

async function ensureAuthenticatedContext(proxyUrl) {
  // If no proxy specified and no proxy pool, use default flow
  if (!proxyUrl) {
    if (isSessionFresh()) return authContext;
    if (authInFlight) return authInFlight;

    authInFlight = (async () => {
      await closeAuthContext();

      if (!browser || !browser.isConnected()) {
        browser = await chromium.launch({
          headless: true,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ]
        });
      }

      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        extraHTTPHeaders: {
          'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
          'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en', 'hi'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = { runtime: {} };
      });

      const page = await context.newPage();
      await page.waitForTimeout(Math.floor(Math.random() * 1500) + 500);
      await page.goto('https://eservices.icai.org/', { waitUntil: 'networkidle', timeout: 120000 });

      const userId = process.env.ICAI_USER_ID || '';
      const password = process.env.ICAI_PASSWORD || '';
      if (!userId || !password) {
        throw new Error('Missing ICAI_USER_ID or ICAI_PASSWORD in .env');
      }

      await page.waitForSelector('#accountname', { state: 'visible', timeout: 90000 });
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

  // Proxy-based context — reuse single authenticated context, just route via proxy for PDF fetch
  // Free proxies can't do login (HTTPS issues), so we use main auth context but fetch PDFs via proxy
  // This avoids opening multiple tabs/windows
  if (isSessionFresh()) return authContext;
  if (authInFlight) return authInFlight;

  // Fallback to normal auth if proxy requested but we just reuse main session
  authInFlight = (async () => {
    await closeAuthContext();

    if (!browser || !browser.isConnected()) {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-gpu'
        ]
      });
    }

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      }
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    await page.goto('https://eservices.icai.org/', { waitUntil: 'networkidle', timeout: 120000 });

    const userId = process.env.ICAI_USER_ID || '';
    const password = process.env.ICAI_PASSWORD || '';
    if (!userId || !password) throw new Error('Missing credentials');

    await page.waitForSelector('#accountname', { state: 'visible', timeout: 90000 });
    await page.fill('#accountname', userId);
    await page.fill('#password', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null),
      page.click('button:has-text("Sign In"), .loginBtn')
    ]);
    await page.waitForTimeout(1500);
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

// Get next proxy in round-robin (returns null if no proxies)
function getNextProxy() {
  if (proxyList.length === 0) return null;
  const proxy = proxyList[proxyRoundRobin % proxyList.length];
  proxyRoundRobin += 1;
  return proxy;
}

async function fetchStudentCardData(srn, _retried) {
  const url = new URL(BASE_TEMPLATE_URL);
  url.searchParams.set('studentRegNo', srn);
  const requestPath = url.pathname + url.search;

  // Ensure we have auth cookies
  if (!authCookieString || !isSessionFresh()) {
    const context = await ensureAuthenticatedContext();
    const cookies = await context.cookies();
    authCookieString = cookies
      .filter(c => c.domain.includes('icai.org'))
      .map(c => `${c.name}=${c.value}`).join('; ');
  }

  // Undici pool request — blazing fast
  const { statusCode, headers, body: responseBody } = await icaiPool.request({
    path: requestPath,
    method: 'GET',
    headers: {
      'Cookie': authCookieString,
      'Accept': 'application/pdf',
      'Referer': 'https://eservices.icai.org/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Connection': 'keep-alive'
    }
  });

  const chunks = [];
  for await (const chunk of responseBody) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const contentType = (headers['content-type'] || '').toLowerCase();

  if (statusCode >= 400 || contentType.includes('text/html') || !isPdfBuffer(body)) {
    const bodyText = body.toString('utf-8').slice(0, 500);
    if (!_retried && (statusCode === 403 || bodyText.includes('Sign In') || bodyText.includes('login') || bodyText.includes('session') || bodyText.includes('Access Denied'))) {
      // Session expired or blocked — reauth once
      authCookieString = '';
      await closeAuthContext();
      authAt = 0;
      const context = await ensureAuthenticatedContext();
      const cookies = await context.cookies();
      authCookieString = cookies
        .filter(c => c.domain.includes('icai.org'))
        .map(c => `${c.name}=${c.value}`).join('; ');
      return fetchStudentCardData(srn, true);
    }
    if (bodyText.includes('No Record') || bodyText.includes('Invalid')) {
      throw new Error('SRN not found');
    }
    throw new Error(`HTTP ${statusCode}`);
  }

  const pdf = await pdfParse(body);
  const parsed = parseStudentCardText(pdf.text || '', srn);
  if (!parsed.srn || !parsed.name) {
    throw new Error('PDF parse failed');
  }

  return parsed;
}

app.use(express.json({ limit: '500mb' }));
app.use(express.static(path.join(__dirname, 'web')));

// ─── BACKGROUND JOB SYSTEM ─────────────────────────────────────────────────
// Jobs run on the server independently of the client. Tab band karo, net band karo — job chalti rahegi.
const jobs = new Map(); // jobId -> { id, status, prefix, startNo, count, concurrency, completed, ok, failed, total, startedAt, completedAt, csvFile, error }

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJobsDir() {
  const dir = path.join(__dirname, 'output', 'jobs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runBackgroundJob(job) {
  try {
    const srns = buildSrnList(job.prefix, job.startNo, job.count);
    const total = srns.length;
    job.total = total;
    job.status = 'running';

    const results = new Array(total);
    let cursor = 0;
    let completed = 0;
    let okCount = 0;
    let failedCount = 0;

    const worker = async () => {
      while (true) {
        if (job.status === 'cancelled') break;
        const idx = cursor;
        cursor += 1;
        if (idx >= total) break;

        const srn = srns[idx];
        try {
          const data = await fetchStudentCardData(srn);
          results[idx] = { status: 'ok', srn, data, error: '' };
          okCount += 1;
        } catch (error) {
          results[idx] = { status: 'error', srn, data: null, error: error && error.message ? error.message : 'Error' };
          failedCount += 1;
        }

        completed += 1;
        job.completed = completed;
        job.ok = okCount;
        job.failed = failedCount;
      }
    };

    const workerCount = Math.max(1, Math.min(job.concurrency, total));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Build CSV
    const headers = [
      'Status', 'Error', 'SRN', 'Name', 'Sex', 'Date of Birth', 'Father', 'Mother',
      'Email', 'Mobile', 'Aadhar Category', 'Correspondence Address', 'Permanent Address', 'Pin',
      'CA Foundation', 'CA Foundation Registration Date', 'CA Inter', 'CA Inter Registration Date',
      'CA Final', 'CA Final Registration Date', 'Course & Exam Details'
    ];

    const csvLines = [buildCsvLine(headers)];
    for (const row of results) {
      if (!row) continue;
      const data = row.data || {};
      const foundationRow = getCourseRowByLevel(data.courseRows, 'FOUNDATION');
      const interRow = getCourseRowByLevel(data.courseRows, 'INTERMEDIATE');
      const finalRow = getCourseRowByLevel(data.courseRows, 'FINAL');
      csvLines.push(buildCsvLine([
        row.status, row.error, row.srn,
        data.name || '', data.sex || '', data.dob || '',
        data.father || '', data.mother || '', data.email || '', data.mobile || '',
        data.aadharCategory || '', data.correspondenceAddress || '', data.permanentAddress || '', data.pin || '',
        formatCourseAvailability(foundationRow), (foundationRow && foundationRow.registrationDate) || '',
        formatCourseAvailability(interRow), (interRow && interRow.registrationDate) || '',
        formatCourseAvailability(finalRow), (finalRow && finalRow.registrationDate) || '',
        normalizeCourseDetails(data.courseRows || [])
      ]));
    }

    const csvContent = csvLines.join('\n') + '\n';
    const fileName = `job_${job.prefix}${String(job.startNo).padStart(7, '0')}_plus${job.count}_${Date.now()}.csv`;
    const filePath = path.join(getJobsDir(), fileName);
    fs.writeFileSync(filePath, csvContent, 'utf-8');

    job.status = 'complete';
    job.completedAt = Date.now();
    job.csvFile = fileName;
    job.elapsedMs = job.completedAt - job.startedAt;
    console.log(`[JOB] ${job.id} complete: ${okCount} ok, ${failedCount} failed, ${job.elapsedMs}ms`);
  } catch (error) {
    job.status = 'failed';
    job.error = error && error.message ? error.message : 'Job failed';
    job.completedAt = Date.now();
    console.log(`[JOB] ${job.id} failed: ${job.error}`);
  }
}

// Start a background job
app.post('/api/jobs/start', (req, res) => {
  const prefix = normalizeStudentPrefix(req.body.prefix) || DEFAULT_STUDENT_PREFIX;
  const startNo = Number(String(req.body.start || req.body.startNo || '').replace(/\D/g, ''));
  const count = Number(req.body.count);
  const concurrency = Math.max(1, Math.min(Number(req.body.concurrency) || DEFAULT_EXPORT_CONCURRENCY, MAX_EXPORT_CONCURRENCY));

  if (!prefix || !Number.isFinite(startNo) || !Number.isFinite(count) || count < 1) {
    return res.status(400).json({ ok: false, error: 'Invalid parameters. Need prefix, start, count.' });
  }

  if (count > MAX_EXPORT_COUNT) {
    return res.status(400).json({ ok: false, error: `Max ${MAX_EXPORT_COUNT} per job.` });
  }

  const job = {
    id: generateJobId(),
    status: 'starting',
    prefix,
    startNo,
    count,
    concurrency,
    total: count,
    completed: 0,
    ok: 0,
    failed: 0,
    startedAt: Date.now(),
    completedAt: null,
    csvFile: null,
    error: null,
    elapsedMs: 0
  };

  jobs.set(job.id, job);

  // Fire and forget — runs in background
  runBackgroundJob(job);

  return res.json({ ok: true, jobId: job.id, message: 'Job started. Tab band karo, server pe chalti rahegi.' });
});

// Get job status
app.get('/api/jobs/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });

  const elapsed = job.completedAt ? job.elapsedMs : Date.now() - job.startedAt;
  const avgMs = job.completed > 0 ? elapsed / job.completed : 0;
  const etaMs = job.completed > 0 ? Math.round(avgMs * (job.total - job.completed)) : 0;

  return res.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      prefix: job.prefix,
      startSrn: `${job.prefix}${String(job.startNo).padStart(7, '0')}`,
      count: job.count,
      total: job.total,
      completed: job.completed,
      ok: job.ok,
      failed: job.failed,
      elapsedMs: elapsed,
      etaMs,
      csvFile: job.csvFile,
      error: job.error
    }
  });
});

// List all jobs
app.get('/api/jobs', (_req, res) => {
  const list = Array.from(jobs.values()).map(job => ({
    id: job.id,
    status: job.status,
    prefix: job.prefix,
    startSrn: `${job.prefix}${String(job.startNo).padStart(7, '0')}`,
    count: job.count,
    completed: job.completed,
    ok: job.ok,
    failed: job.failed,
    elapsedMs: job.completedAt ? job.elapsedMs : Date.now() - job.startedAt,
    csvFile: job.csvFile
  })).sort((a, b) => b.elapsedMs - a.elapsedMs);

  return res.json({ ok: true, jobs: list });
});

// Download completed job CSV
app.get('/api/jobs/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  if (job.status !== 'complete' || !job.csvFile) {
    return res.status(400).json({ ok: false, error: 'Job not complete yet' });
  }

  const filePath = path.join(getJobsDir(), job.csvFile);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'CSV file not found' });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${job.csvFile}"`);
  return res.sendFile(filePath);
});

// Cancel a running job
app.post('/api/jobs/cancel/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  if (job.status === 'complete' || job.status === 'failed') {
    return res.status(400).json({ ok: false, error: 'Job already finished' });
  }
  job.status = 'cancelled';
  job.completedAt = Date.now();
  job.elapsedMs = job.completedAt - job.startedAt;
  return res.json({ ok: true, message: 'Job cancelled' });
});

// ─── END BACKGROUND JOB SYSTEM ─────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ─── FIND LATEST REGISTRATION (with cache) ──────────────────────────────────
// Binary search to find the latest valid SRN for a prefix (WRO/CRO)
// Saves result to disk so next time it starts from saved point, not from scratch.

const LATEST_CACHE_FILE = path.join(__dirname, 'output', 'latest-cache.json');

function loadLatestCacheLocal() {
  try {
    if (fs.existsSync(LATEST_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(LATEST_CACHE_FILE, 'utf-8'));
    }
  } catch (e) {}
  return {};
}

function saveLatestCacheLocal(cache) {
  const dir = path.dirname(LATEST_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LATEST_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

async function loadLatestCache() {
  // Try Google Sheets first, fallback to local file
  if (sheetsDb.isConfigured()) {
    try {
      const sheetsCache = await sheetsDb.getCacheFromSheets();
      if (Object.keys(sheetsCache).length > 0) {
        saveLatestCacheLocal(sheetsCache); // sync to local
        return sheetsCache;
      }
    } catch (e) {
      console.log('[CACHE] Sheets read failed, using local:', e.message);
    }
  }
  return loadLatestCacheLocal();
}

async function getCachedLatest(prefix) {
  const cache = await loadLatestCache();
  return cache[prefix] || null;
}

async function setCachedLatest(prefix, number) {
  const srn = `${prefix}${String(number).padStart(7, '0')}`;
  const foundAt = new Date().toISOString();

  // Save locally
  const cache = loadLatestCacheLocal();
  cache[prefix] = { number, srn, foundAt };
  saveLatestCacheLocal(cache);

  // Save to Google Sheets (persistent)
  if (sheetsDb.isConfigured()) {
    sheetsDb.saveCacheToSheets(prefix, number, srn, foundAt).catch(e => {
      console.log('[CACHE] Sheets write failed:', e.message);
    });
  }

  return cache[prefix];
}

async function probesSrn(srn) {
  try {
    await fetchStudentCardData(srn);
    return true;
  } catch (e) {
    return false;
  }
}

async function binarySearchLatestSrn(prefix, low, high) {
  let lastFound = low;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const srn = `${prefix}${String(mid).padStart(7, '0')}`;
    
    console.log(`[FIND-LATEST] Binary search: testing ${srn} (low=${low}, high=${high})`);
    const exists = await probesSrn(srn);
    
    if (exists) {
      lastFound = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  
  return lastFound;
}

async function linearScanLatest(prefix, startFrom, maxProbes) {
  let latest = startFrom;
  let consecutive_misses = 0;
  const MAX_MISSES = 20;
  
  for (let i = startFrom + 1; i <= startFrom + maxProbes && consecutive_misses < MAX_MISSES; i++) {
    const srn = `${prefix}${String(i).padStart(7, '0')}`;
    const exists = await probesSrn(srn);
    
    if (exists) {
      latest = i;
      consecutive_misses = 0;
    } else {
      consecutive_misses += 1;
    }
  }
  
  return latest;
}

// Get cached latest info
app.get('/api/latest-cache', async (_req, res) => {
  const cache = await loadLatestCache();
  return res.json({ ok: true, cache, sheetsConnected: sheetsDb.isConfigured() });
});

app.get('/api/find-latest', async (req, res) => {
  const prefix = normalizeStudentPrefix(req.query.prefix);
  if (!prefix) {
    return res.status(400).json({ ok: false, error: 'Valid prefix chahiye (WRO/CRO/etc)' });
  }

  const cached = getCachedLatest(prefix);

  // Known approximate ranges for ICAI prefixes
  const knownRanges = {
    'WRO': { low: 800000, high: 1200000 },
    'CRO': { low: 800000, high: 1200000 },
    'ERO': { low: 800000, high: 1200000 },
    'SRO': { low: 800000, high: 1200000 },
    'NRO': { low: 800000, high: 1200000 },
  };

  const range = knownRanges[prefix] || { low: 500000, high: 1500000 };
  
  try {
    let searchLow;
    
    if (cached) {
      // Start from saved point — just scan forward from last known
      searchLow = cached.number;
      console.log(`[FIND-LATEST] Cache hit for ${prefix}: ${cached.srn} (found on ${cached.foundAt}). Scanning forward...`);
    } else {
      // No cache — full binary search
      console.log(`[FIND-LATEST] No cache for ${prefix}. Full binary search (${range.low}-${range.high})`);
      searchLow = await binarySearchLatestSrn(prefix, range.low, range.high);
      console.log(`[FIND-LATEST] Binary search found: ${prefix}${String(searchLow).padStart(7, '0')}`);
    }

    // Linear scan forward from known/approx point to find exact latest
    const exact = await linearScanLatest(prefix, searchLow, 500);
    const latestSrn = `${prefix}${String(exact).padStart(7, '0')}`;
    
    // Save to cache
    const savedEntry = setCachedLatest(prefix, exact);
    
    console.log(`[FIND-LATEST] Latest: ${latestSrn} (saved to cache)`);
    
    return res.json({
      ok: true,
      prefix,
      latestNumber: exact,
      latestSrn,
      cachedFrom: cached ? cached.srn : null,
      cachedDate: cached ? cached.foundAt : null,
      newRecordsSince: cached ? exact - cached.number : 0,
      message: cached 
        ? `Latest: ${latestSrn} (${exact - cached.number} new since ${(cached.foundAt || '').split('T')[0] || 'unknown'})`
        : `Latest: ${latestSrn} (first time — saved for next time)`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : 'Search failed'
    });
  }
});

// Extract recent registrations (latest N records, skipping gaps)
app.get('/api/extract-recent', async (req, res) => {
  const prefix = normalizeStudentPrefix(req.query.prefix);
  const count = Math.min(Number(req.query.count) || 100, 5000);
  const latestNo = Number(req.query.latest) || 0;

  if (!prefix) {
    return res.status(400).json({ ok: false, error: 'Valid prefix chahiye (WRO/CRO/etc)' });
  }

  if (!latestNo) {
    return res.status(400).json({ ok: false, error: 'Latest number chahiye. Pehle Find Latest use karo.' });
  }

  // Go backward from latest, extract 'count' valid records
  const startFrom = latestNo;
  const results = [];
  let cursor = startFrom;
  let attempts = 0;
  const maxAttempts = count * 3; // Allow for gaps

  console.log(`[EXTRACT-RECENT] Starting from ${prefix}${String(startFrom).padStart(7, '0')}, need ${count} records`);

  const concurrency = Math.min(Number(req.query.concurrency) || 30, 100);
  
  // Batch fetch going backward
  while (results.length < count && attempts < maxAttempts && cursor > 0) {
    const batchSize = Math.min(concurrency, count - results.length + 10);
    const batch = [];
    
    for (let i = 0; i < batchSize && cursor > 0; i++) {
      batch.push({ no: cursor, srn: `${prefix}${String(cursor).padStart(7, '0')}` });
      cursor -= 1;
      attempts += 1;
    }

    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          const data = await fetchStudentCardData(item.srn);
          return { status: 'ok', srn: item.srn, no: item.no, data };
        } catch (e) {
          return { status: 'error', srn: item.srn, no: item.no, data: null };
        }
      })
    );

    for (const r of batchResults) {
      if (r.status === 'ok' && results.length < count) {
        results.push(r);
      }
    }
  }

  // Sort results by SRN number descending (newest first)
  results.sort((a, b) => b.no - a.no);

  // Filter only records with recent registration dates (today's date check)
  // Build CSV
  const headers = [
    'SRN', 'Name', 'Sex', 'Date of Birth', 'Father', 'Mother',
    'Email', 'Mobile', 'Aadhar Category', 'Correspondence Address', 'Permanent Address', 'Pin',
    'CA Foundation', 'CA Foundation Reg Date', 'CA Inter', 'CA Inter Reg Date',
    'CA Final', 'CA Final Reg Date', 'Course & Exam Details'
  ];

  const csvLines = [buildCsvLine(headers)];
  for (const r of results) {
    const data = r.data || {};
    const foundationRow = getCourseRowByLevel(data.courseRows, 'FOUNDATION');
    const interRow = getCourseRowByLevel(data.courseRows, 'INTERMEDIATE');
    const finalRow = getCourseRowByLevel(data.courseRows, 'FINAL');
    csvLines.push(buildCsvLine([
      data.srn || r.srn,
      data.name || '', data.sex || '', data.dob || '',
      data.father || '', data.mother || '', data.email || '', data.mobile || '',
      data.aadharCategory || '', data.correspondenceAddress || '', data.permanentAddress || '', data.pin || '',
      formatCourseAvailability(foundationRow), (foundationRow && foundationRow.registrationDate) || '',
      formatCourseAvailability(interRow), (interRow && interRow.registrationDate) || '',
      formatCourseAvailability(finalRow), (finalRow && finalRow.registrationDate) || '',
      normalizeCourseDetails(data.courseRows || [])
    ]));
  }

  const csvContent = csvLines.join('\n') + '\n';

  // Save to Google Sheets in background
  if (sheetsDb.isConfigured()) {
    const validRecords = results.map(r => r.data).filter(Boolean);
    sheetsDb.saveRecordsToSheets(validRecords).catch(e => {
      console.log('[EXTRACT-RECENT] Sheets save failed:', e.message);
    });
  }

  return res.json({
    ok: true,
    prefix,
    latestSrn: `${prefix}${String(startFrom).padStart(7, '0')}`,
    totalFound: results.length,
    records: results.map(r => r.data),
    csv: Buffer.from(csvContent, 'utf-8').toString('base64'),
    savedToSheets: sheetsDb.isConfigured()
  });
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
      // Extract cookies immediately for direct HTTP fetches
      const cookies = await ctx.cookies();
      authCookieString = cookies
        .filter(c => c.domain.includes('icai.org'))
        .map(c => `${c.name}=${c.value}`).join('; ');
      console.log('[LOGIN] Cookies extracted:', cookies.length, 'total,', authCookieString.length, 'chars for icai.org');
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

app.get('/api/config', async (_req, res) => {
  return res.json({
    ok: true,
    studentPrefix: DEFAULT_STUDENT_PREFIX,
    defaultStartNumber: DEFAULT_START_NUMBER,
    defaultStartSrn: DEFAULT_START_SRN
  });
});

app.get('/api/search', async (req, res) => {
  const srn = String(req.query.srn || '').trim().toUpperCase();
  console.log('[SEARCH] SRN:', srn);
  if (!/^[A-Z]{3}\d{7}$/.test(srn)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid SRN format. Example: ${DEFAULT_START_SRN}`
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
  const parsed = parseRangeRequest(req.query);

  if (!parsed) {
    return res.status(400).json({
      ok: false,
      error: `Invalid range format. Use ${DEFAULT_START_SRN} +1000 or prefix=${DEFAULT_STUDENT_PREFIX}&start=${DEFAULT_START_NUMBER}&count=1000`
    });
  }

  if (parsed.count > MAX_EXPORT_COUNT) {
    return res.status(400).json({
      ok: false,
      error: `Range too large. Max allowed is +${MAX_EXPORT_COUNT} per request.`
    });
  }

  const srns = buildSrnList(parsed.prefix, parsed.startNo, parsed.count);
  const concurrency = resolveExportConcurrency(req.query.concurrency, parsed.count);
  const startedAt = Date.now();
  const rows = await fetchRangeRows(srns, concurrency);

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
    'CA Foundation',
    'CA Foundation Registration Date',
    'CA Inter',
    'CA Inter Registration Date',
    'Course & Exam Details'
  ];

  const csvLines = [buildCsvLine(headers)];
  for (const row of rows) {
    const data = row.data || {};
    const foundationRow = getCourseRowByLevel(data.courseRows, 'FOUNDATION');
    const interRow = getCourseRowByLevel(data.courseRows, 'INTERMEDIATE');
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
        formatCourseAvailability(foundationRow),
        (foundationRow && foundationRow.registrationDate) || '',
        formatCourseAvailability(interRow),
        (interRow && interRow.registrationDate) || '',
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
  res.setHeader('X-Export-Concurrency', String(concurrency));
  res.setHeader('X-Export-Duration-Ms', String(elapsedMs));
  return res.send(`${csvLines.join('\n')}\n`);
});

// SSE streaming export with real-time progress
app.get('/api/export-range-stream', async (req, res) => {
  const parsed = parseRangeRequest(req.query);

  if (!parsed) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ type: 'error', error: `Invalid range format. Use ${DEFAULT_START_SRN} +1000` })}\n\n`);
    return res.end();
  }

  if (parsed.count > MAX_EXPORT_COUNT) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ type: 'error', error: `Range too large. Max allowed is +${MAX_EXPORT_COUNT}` })}\n\n`);
    return res.end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const srns = buildSrnList(parsed.prefix, parsed.startNo, parsed.count);
  const concurrency = resolveExportConcurrency(req.query.concurrency, parsed.count);
  const total = srns.length;
  const startedAt = Date.now();

  // Send initial info
  res.write(`data: ${JSON.stringify({ type: 'start', total, concurrency, startSrn: parsed.startSrn })}\n\n`);

  const results = new Array(srns.length);
  let completed = 0;
  let okCount = 0;
  let failedCount = 0;
  let aborted = false;

  req.on('close', () => { aborted = true; });

  let cursor = 0;
  const worker = async () => {
    while (!aborted) {
      const idx = cursor;
      cursor += 1;
      if (idx >= srns.length) break;

      const srn = srns[idx];
      let data = null;
      let fetchError = '';

      try {
        data = await fetchStudentCardData(srn);
      } catch (error) {
        fetchError = error && error.message ? error.message : 'Unknown error';
      }

      if (aborted) break;

      if (data) {
        results[idx] = { status: 'ok', srn, data, error: '' };
        okCount += 1;
      } else {
        results[idx] = { status: 'error', srn, data: null, error: fetchError };
        failedCount += 1;
      }

      completed += 1;
      const elapsedMs = Date.now() - startedAt;
      const avgMs = elapsedMs / completed;
      const etaMs = Math.round(avgMs * (total - completed));

      // Send progress every 20 completions to reduce SSE overhead
      if (!aborted && (completed % 20 === 0 || completed === total)) {
        res.write(`data: ${JSON.stringify({
          type: 'progress',
          completed,
          total,
          ok: okCount,
          failed: failedCount,
          elapsedMs,
          etaMs,
          lastSrn: srn,
          lastStatus: data ? 'ok' : 'error',
          lastName: data ? data.name : ''
        })}\n\n`);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, srns.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (aborted) return;

  // Build CSV
  const headers = [
    'Status', 'Error', 'SRN', 'Name', 'Sex', 'Date of Birth', 'Father', 'Mother',
    'Email', 'Mobile', 'Aadhar Category', 'Correspondence Address', 'Permanent Address', 'Pin',
    'CA Foundation', 'CA Foundation Registration Date', 'CA Inter', 'CA Inter Registration Date',
    'Course & Exam Details'
  ];

  const csvLines = [buildCsvLine(headers)];
  for (const row of results) {
    if (!row) continue;
    const data = row.data || {};
    const foundationRow = getCourseRowByLevel(data.courseRows, 'FOUNDATION');
    const interRow = getCourseRowByLevel(data.courseRows, 'INTERMEDIATE');
    csvLines.push(buildCsvLine([
      row.status, row.error, row.srn,
      data.name || '', data.sex || '', data.dob || '',
      data.father || '', data.mother || '', data.email || '', data.mobile || '',
      data.aadharCategory || '', data.correspondenceAddress || '', data.permanentAddress || '', data.pin || '',
      formatCourseAvailability(foundationRow), (foundationRow && foundationRow.registrationDate) || '',
      formatCourseAvailability(interRow), (interRow && interRow.registrationDate) || '',
      normalizeCourseDetails(data.courseRows || [])
    ]));
  }

  const csvContent = `${csvLines.join('\n')}\n`;
  const elapsedMs = Date.now() - startedAt;
  const fileName = `students_${parsed.startSrn}_plus${parsed.count}_${Date.now()}.csv`;

  // Send complete event with CSV as base64
  res.write(`data: ${JSON.stringify({
    type: 'complete',
    total,
    ok: okCount,
    failed: failedCount,
    elapsedMs,
    fileName,
    csv: Buffer.from(csvContent, 'utf-8').toString('base64')
  })}\n\n`);

  res.end();
});

// Multer for handling file uploads (memory storage for merge)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// Upload-based merge: accepts uploaded CSV files from frontend
app.post('/api/merge-csv-upload', upload.array('files', 500), async (req, res) => {
  try {
    const files = req.files || [];
    const dedupeSrn = req.body && req.body.dedupeSrn !== 'false';

    if (files.length < 2) {
      return res.status(400).json({ ok: false, error: 'Kam se kam 2 CSV files upload karo.' });
    }

    let primaryHeaders = null;
    const outputLines = [];
    const seenSrns = new Set();
    let mergedCount = 0;
    let duplicateCount = 0;

    for (const file of files) {
      const text = file.buffer.toString('utf-8');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length === 0) continue;

      const sourceHeaders = parseCsvLine(lines[0]).map(h => h.trim());
      if (!primaryHeaders) {
        primaryHeaders = sourceHeaders;
        outputLines.push(buildCsvLine(primaryHeaders));
      }

      const srnIdx = primaryHeaders.indexOf('SRN');

      for (let i = 1; i < lines.length; i++) {
        const sourceValues = parseCsvLine(lines[i]);
        const mappedValues = primaryHeaders.map(header => {
          const idx = sourceHeaders.indexOf(header);
          return idx >= 0 ? sourceValues[idx] || '' : '';
        });

        if (dedupeSrn && srnIdx >= 0) {
          const key = String(mappedValues[srnIdx] || '').trim().toUpperCase();
          if (key) {
            if (seenSrns.has(key)) { duplicateCount++; continue; }
            seenSrns.add(key);
          }
        }

        outputLines.push(buildCsvLine(mappedValues));
        mergedCount++;
      }
    }

    if (!primaryHeaders) {
      return res.status(400).json({ ok: false, error: 'No valid CSV data found.' });
    }

    const csv = outputLines.join('\n') + '\n';
    const fileName = `merged_upload_${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Merge-Files', String(files.length));
    res.setHeader('X-Merge-Rows', String(mergedCount));
    res.setHeader('X-Merge-Duplicates', String(duplicateCount));
    return res.send(csv);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error && error.message ? error.message : 'Merge failed' });
  }
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

  if (files.length > 500) {
    return res.status(400).json({
      ok: false,
      error: 'Too many files selected. Max 500 files per merge request.'
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
