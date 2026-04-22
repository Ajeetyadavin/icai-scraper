const { chromium } = require('playwright');
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');
const pdfParse = require('pdf-parse');
require('dotenv').config();

const BASE_TEMPLATE_URL =
  process.env.STUDENT_CARD_TEMPLATE_URL ||
  'https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&argnum=2&formId=57499&1666=1666&appSeqNo=APP3908399&checksum=gygBwj9R%252F5aDFtG%252BwBcvBw%253D%253D&entityId=3908399&sessChk=1775935472848&callForOrg=ICAI&user_id=&requiredReport=StudentCard&PDFName=StudentCard&studentRegNo=WRO0873063';

const START_REG_NO = process.env.CSV_START_REGNO || 'WRO0873063';
const OFFSET_PLUS = Number(process.env.CSV_PLUS_COUNT || 5); // +5 means total 6 records
const OUTPUT_CSV =
  process.env.CSV_OUTPUT_FILE ||
  './output/student_cards_WRO0873063_to_plus5_clean.csv';

function isPdfBuffer(buf) {
  return buf && buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function buildRegNo(prefix, number) {
  return `${prefix}${String(number).padStart(7, '0')}`;
}

function buildUrl(baseTemplate, regNo) {
  const url = new URL(baseTemplate);
  url.searchParams.set('studentRegNo', regNo);
  return url.toString();
}

function getBetween(lines, startLabel, endLabel) {
  const startIdx = lines.indexOf(startLabel);
  if (startIdx === -1) return '';

  const endIdx = endLabel ? lines.indexOf(endLabel, startIdx + 1) : -1;
  const slice = endIdx === -1 ? lines.slice(startIdx + 1) : lines.slice(startIdx + 1, endIdx);
  return slice.join(' ').trim();
}

function getAfter(lines, label) {
  const idx = lines.indexOf(label);
  return idx >= 0 ? (lines[idx + 1] || '') : '';
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

    if (i < section.length && !isCourseCode(section[i])) {
      row.examType = section[i];
      i += 1;
    }

    if (i < section.length && isDateValue(section[i])) {
      row.enrolmentDate = section[i];
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

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function getCourseLevel(course) {
  const c = (course || '').toUpperCase();
  if (c.includes('NEWFND')) return 'FOUNDATION';
  if (c.includes('NEWINT')) return 'INTERMEDIATE';
  return '';
}

function parseStudentCardText(text, regNo) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let aadharCategory = '';
  const aadharIdx = lines.findIndex((l) => l === 'Aadhar');
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
    aadharCategory,
    correspondenceAddress: normalizeText(getBetween(lines, 'Correspondence Address', 'Permanent Address')),
    permanentAddress: normalizeText(getBetween(lines, 'Permanent Address', 'Pin')),
    pin: normalizeText(getAfter(lines, 'Pin')),
    courseRows,
    status: 'success'
  };
}

(async () => {
  const m = START_REG_NO.match(/^([A-Z]+)(\d{7})$/i);
  if (!m) {
    throw new Error(`Invalid CSV_START_REGNO: ${START_REG_NO}. Expected like WRO0873063`);
  }

  const prefix = m[1].toUpperCase();
  const startNum = Number(m[2]);
  const endNum = startNum + OFFSET_PLUS;

  const outCsvAbs = path.resolve(OUTPUT_CSV);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });

  const page = await context.newPage();

  console.log('Logging in...');
  await page.goto('https://eservices.icai.org/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.fill('#accountname', process.env.ICAI_USER_ID || '');
  await page.fill('#password', process.env.ICAI_PASSWORD || '');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null),
    page.click('button:has-text("Sign In"), .loginBtn')
  ]);

  await page.waitForTimeout(3000);

  const closeModal = page.locator('button:has-text("Close")').first();
  if (await closeModal.count()) {
    await closeModal.click().catch(() => {});
  }

  const studentRecords = [];

  for (let num = startNum; num <= endNum; num++) {
    const regNo = buildRegNo(prefix, num);
    const url = buildUrl(BASE_TEMPLATE_URL, regNo);

    try {
      const res = await context.request.get(url, {
        headers: {
          Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8',
          Referer: 'https://eservices.icai.org/'
        },
        timeout: 90000
      });

      const body = await res.body();
      const contentType = (res.headers()['content-type'] || '').toLowerCase();

      if (res.status() === 200 && (contentType.includes('application/pdf') || isPdfBuffer(body))) {
        const parsed = await pdfParse(body);
        studentRecords.push(parseStudentCardText(parsed.text, regNo));
        console.log(`OK ${regNo}`);
      } else {
        studentRecords.push({ srn: regNo, status: `failed_http_${res.status()}`, courseRows: [] });
        console.log(`FAIL ${regNo} status=${res.status()} contentType=${contentType}`);
      }
    } catch (err) {
      studentRecords.push({ srn: regNo, status: `error_${err.message}`, courseRows: [] });
      console.log(`ERROR ${regNo}: ${err.message}`);
    }
  }

  // Clean tabular output: one row per course line (like screenshot table).
  const records = [];
  for (const s of studentRecords) {
    const base = {
      srn: s.srn || '',
      name: s.name || '',
      sex: s.sex || '',
      dob: s.dob || '',
      father: s.father || '',
      mother: s.mother || '',
      email: s.email || '',
      mobile: s.mobile || '',
      aadharCategory: s.aadharCategory || '',
      correspondenceAddress: s.correspondenceAddress || '',
      permanentAddress: s.permanentAddress || '',
      pin: s.pin || '',
      status: s.status || ''
    };

    if (!s.courseRows || s.courseRows.length === 0) {
      records.push({
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
      });
      continue;
    }

    for (const c of s.courseRows) {
      records.push({
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
      });
    }
  }

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

  const csvWriter = createObjectCsvWriter({
    path: outCsvAbs,
    header: headers
  });

  await csvWriter.writeRecords(records);
  console.log(`CSV saved: ${outCsvAbs}`);

  await browser.close();
})();
