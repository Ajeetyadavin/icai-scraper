const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');
const pdfParse = require('pdf-parse');
require('dotenv').config();

const BASE_TEMPLATE_URL =
  process.env.STUDENT_CARD_TEMPLATE_URL ||
  'https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&argnum=2&formId=57499&1666=1666&appSeqNo=APP3908399&checksum=gygBwj9R%252F5aDFtG%252BwBcvBw%253D%253D&entityId=3908399&sessChk=1775935472848&callForOrg=ICAI&user_id=&requiredReport=StudentCard&PDFName=StudentCard&studentRegNo=WRO0873063';

const START_REG_NO = process.env.CSV_START_REGNO || 'WRO0873063';
const TOTAL_COUNT = Number(process.env.CSV_TOTAL_COUNT || 100000);
const OUTPUT_CSV = process.env.CSV_OUTPUT_FILE || './output/student_cards_ultra_100k.csv';
const CONCURRENCY = Number(process.env.CSV_CONCURRENCY || 50);
const RETRIES = Number(process.env.CSV_RETRIES || 2);
const REQUEST_TIMEOUT_MS = Number(process.env.CSV_REQUEST_TIMEOUT_MS || 60000);
const HEADLESS = String(process.env.CSV_HEADLESS || 'false').toLowerCase() === 'true';
const SESSION_STATE_FILE = process.env.CSV_SESSION_STATE_FILE || './output/downloaded-cards/session-state.json';

function buildRegNo(prefix, number) {
  return `${prefix}${String(number).padStart(7, '0')}`;
}

function buildUrl(baseTemplate, regNo) {
  const url = new URL(baseTemplate);
  url.searchParams.set('studentRegNo', regNo);
  return url.toString();
}

function isPdfBuffer(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function getAfter(lines, label) {
  const idx = lines.indexOf(label);
  return idx >= 0 ? (lines[idx + 1] || '') : '';
}

function getBetween(lines, startLabel, endLabel) {
  const startIdx = lines.indexOf(startLabel);
  if (startIdx === -1) return '';
  const endIdx = endLabel ? lines.indexOf(endLabel, startIdx + 1) : -1;
  const slice = endIdx === -1 ? lines.slice(startIdx + 1) : lines.slice(startIdx + 1, endIdx);
  return slice.join(' ').trim();
}

function isCourseCode(value) {
  return /^[A-Z]{3,}[A-Z0-9]*\d{2,}$/i.test(value || '');
}

function isDateValue(value) {
  return /^\d{2}\/[A-Za-z]{3}\/[0-9]{4}$/.test(value || '');
}

function isMonthValue(value) {
  return /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|JANUARY|FEBRUARY|MARCH|APRIL|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)$/i.test(value || '');
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
  const c = (course || '').toUpperCase();
  if (c.includes('NEWFND')) return 'FOUNDATION';
  if (c.includes('NEWINT')) return 'INTERMEDIATE';
  return '';
}

function parseCourseRows(lines) {
  const start = lines.indexOf('COURSE AND EXAM DETAILS:');
  if (start === -1) return [];

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
      examType: '',
      enrolmentDate: '',
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
    if (i < section.length && !isCourseCode(section[i])) row.examType = section[i++];
    if (i < section.length && isDateValue(section[i])) row.enrolmentDate = section[i++];
    if (i < section.length && isDateValue(section[i])) row.reRegistrationDate = section[i++];
    if (i < section.length && isMonthValue(section[i])) row.monthOfPassing = section[i++];
    if (i < section.length && isYearValue(section[i])) row.yearOfPassing = section[i++];
    if (i < section.length && /^[A-Z0-9]{4,}$/i.test(section[i]) && !isCourseCode(section[i])) row.rollNo = section[i++];
    if (i < section.length && isNumericValue(section[i])) row.mark = section[i++];
    if (i < section.length && isNumericValue(section[i])) row.maxMark = section[i++];
    if (i < section.length && isNumericValue(section[i])) row.percentage = section[i++];
    if (i < section.length && isResultStatus(section[i])) row.resultStatus = section[i++];

    rows.push(row);
  }

  return rows;
}

function parseStudentCard(text, regNo) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let aadharCategory = '';
  const aadharIdx = lines.findIndex((l) => l === 'Aadhar');
  if (aadharIdx >= 0 && lines[aadharIdx + 1] === 'Category') {
    aadharCategory = lines[aadharIdx + 2] || '';
  }

  const base = {
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
    status: 'success'
  };

  const courseRows = parseCourseRows(lines);
  if (!courseRows.length) {
    return [{
      ...base,
      level: '',
      course: '',
      examinationType: '',
      enrolmentDate: '',
      reRegistrationDate: '',
      monthOfPassing: '',
      yearOfPassing: '',
      rollNo: '',
      mark: '',
      maxMark: '',
      percentage: '',
      resultStatus: ''
    }];
  }

  return courseRows.map((c) => ({
    ...base,
    level: getCourseLevel(c.course),
    course: c.course || '',
    examinationType: c.examType || '',
    enrolmentDate: c.enrolmentDate || '',
    reRegistrationDate: c.reRegistrationDate || '',
    monthOfPassing: c.monthOfPassing || '',
    yearOfPassing: c.yearOfPassing || '',
    rollNo: c.rollNo || '',
    mark: c.mark || '',
    maxMark: c.maxMark || '',
    percentage: c.percentage || '',
    resultStatus: c.resultStatus || ''
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(context, regNo) {
  const url = buildUrl(BASE_TEMPLATE_URL, regNo);
  let lastErr;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await context.request.get(url, {
        headers: {
          Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8',
          Referer: 'https://eservices.icai.org/'
        },
        timeout: REQUEST_TIMEOUT_MS
      });

      const body = await res.body();
      const contentType = (res.headers()['content-type'] || '').toLowerCase();
      if (res.status() === 200 && (contentType.includes('application/pdf') || isPdfBuffer(body))) {
        const parsed = await pdfParse(body);
        return { ok: true, rows: parseStudentCard(parsed.text, regNo) };
      }

      lastErr = new Error(`HTTP ${res.status()} ${contentType}`);
    } catch (err) {
      lastErr = err;
    }

    if (attempt < RETRIES) {
      await sleep(250 * (attempt + 1));
    }
  }

  return {
    ok: false,
    rows: [{
      srn: regNo,
      name: '',
      sex: '',
      dob: '',
      father: '',
      mother: '',
      email: '',
      mobile: '',
      aadharCategory: '',
      correspondenceAddress: '',
      permanentAddress: '',
      pin: '',
      level: '',
      course: '',
      examinationType: '',
      enrolmentDate: '',
      reRegistrationDate: '',
      monthOfPassing: '',
      yearOfPassing: '',
      rollNo: '',
      mark: '',
      maxMark: '',
      percentage: '',
      resultStatus: '',
      status: `failed_${lastErr ? lastErr.message : 'unknown'}`
    }]
  };
}

async function main() {
  const m = START_REG_NO.match(/^([A-Z]+)(\d{7})$/i);
  if (!m) throw new Error(`Invalid CSV_START_REGNO: ${START_REG_NO}`);

  const prefix = m[1].toUpperCase();
  const startNum = Number(m[2]);

  const headers = [
    { id: 'srn', title: 'SRN' },
    { id: 'name', title: 'Name' },
    { id: 'sex', title: 'Sex' },
    { id: 'dob', title: 'Date of Birth' },
    { id: 'father', title: 'Father' },
    { id: 'mother', title: 'Mother' },
    { id: 'email', title: 'Email' },
    { id: 'mobile', title: 'Mobile' },
    { id: 'aadharCategory', title: 'Aadhar Category' },
    { id: 'correspondenceAddress', title: 'Correspondence Address' },
    { id: 'permanentAddress', title: 'Permanent Address' },
    { id: 'pin', title: 'Pin' },
    { id: 'level', title: 'Level' },
    { id: 'course', title: 'COURSE' },
    { id: 'examinationType', title: 'EXAMINATION TYPE' },
    { id: 'enrolmentDate', title: 'ENROLMENT DATE' },
    { id: 'reRegistrationDate', title: 'RE-REGISTRATION DATE' },
    { id: 'monthOfPassing', title: 'MONTH OF PASSING' },
    { id: 'yearOfPassing', title: 'YEAR OF PASSING' },
    { id: 'rollNo', title: 'ROLLNO' },
    { id: 'mark', title: 'MARK' },
    { id: 'maxMark', title: 'MAXMARK' },
    { id: 'percentage', title: 'PERCENTAGE' },
    { id: 'resultStatus', title: 'RESULT STATUS' },
    { id: 'status', title: 'Status' }
  ];

  const outCsvAbs = path.resolve(OUTPUT_CSV);
  console.log(`Output: ${outCsvAbs}`);
  console.log(`Start: ${START_REG_NO}, total: ${TOTAL_COUNT}, concurrency: ${CONCURRENCY}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  };

  if (require('fs').existsSync(SESSION_STATE_FILE)) {
    contextOptions.storageState = SESSION_STATE_FILE;
    console.log(`Using existing session state: ${SESSION_STATE_FILE}`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Verify session with a real test download. If invalid, perform login.
  const testRegNo = buildRegNo(prefix, startNum);
  let needLogin = true;
  try {
    const testRes = await context.request.get(buildUrl(BASE_TEMPLATE_URL, testRegNo), {
      headers: {
        Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8',
        Referer: 'https://eservices.icai.org/'
      },
      timeout: REQUEST_TIMEOUT_MS
    });
    const testBody = await testRes.body();
    const testCt = (testRes.headers()['content-type'] || '').toLowerCase();
    if (testRes.status() === 200 && (testCt.includes('application/pdf') || isPdfBuffer(testBody))) {
      needLogin = false;
    }
  } catch (e) {
    needLogin = true;
  }

  if (needLogin) {
    console.log('Logging in...');
    await page.goto('https://eservices.icai.org/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.fill('#accountname', process.env.ICAI_USER_ID || '');
    await page.fill('#password', process.env.ICAI_PASSWORD || '');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null),
      page.click('button:has-text("Sign In"), .loginBtn')
    ]);
    await page.waitForTimeout(2000);
    const closeModal = page.locator('button:has-text("Close")').first();
    if (await closeModal.count()) await closeModal.click().catch(() => {});
    await context.storageState({ path: SESSION_STATE_FILE });
  } else {
    console.log('Session already active; skipping login.');
  }

  const WRITE_BATCH_SIZE = Number(process.env.CSV_WRITE_BATCH_SIZE || 5000);
  let wroteHeader = false;
  let flushPromise = Promise.resolve();
  let flushing = false;
  const pendingRows = [];

  const doFlush = async (force = false) => {
    if (flushing) return;
    if (!force && pendingRows.length < WRITE_BATCH_SIZE) return;
    if (pendingRows.length === 0) return;

    flushing = true;
    try {
      const chunk = pendingRows.splice(0, WRITE_BATCH_SIZE);
      const writer = createObjectCsvWriter({
        path: outCsvAbs,
        header: headers,
        append: wroteHeader
      });
      await writer.writeRecords(chunk);
      wroteHeader = true;
    } finally {
      flushing = false;
    }

    if (pendingRows.length >= WRITE_BATCH_SIZE) {
      await doFlush(true);
    }
  };

  const enqueueRows = (rows) => {
    pendingRows.push(...rows);
    flushPromise = flushPromise.then(() => doFlush(false));
  };

  let nextIndex = 0;
  let processed = 0;
  let success = 0;
  let failed = 0;
  const started = Date.now();

  async function worker() {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= TOTAL_COUNT) return;

      const regNo = buildRegNo(prefix, startNum + idx);
      const result = await fetchWithRetry(context, regNo);

      processed += 1;
      if (result.ok) success += 1;
      else failed += 1;

      enqueueRows(result.rows);

      if (processed % 100 === 0 || processed === TOTAL_COUNT) {
        const elapsedSec = (Date.now() - started) / 1000;
        const rate = processed / Math.max(elapsedSec, 1);
        const etaSec = (TOTAL_COUNT - processed) / Math.max(rate, 0.001);
        console.log(`progress=${processed}/${TOTAL_COUNT} ok=${success} fail=${failed} queuedRows=${pendingRows.length} rate=${rate.toFixed(2)}/s eta=${Math.ceil(etaSec)}s`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  flushPromise = flushPromise.then(() => doFlush(true));
  await flushPromise;

  const elapsedSec = (Date.now() - started) / 1000;
  console.log('Done');
  console.log(`processed=${processed} success=${success} failed=${failed} elapsed=${elapsedSec.toFixed(1)}s avgRate=${(processed / Math.max(elapsedSec, 1)).toFixed(2)}/s`);

  await browser.close();
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
