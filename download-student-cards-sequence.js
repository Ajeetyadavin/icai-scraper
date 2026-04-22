const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

function buildUrl(baseTemplate, regNo) {
  const url = new URL(baseTemplate);
  url.searchParams.set('studentRegNo', regNo);
  return url.toString();
}

function buildRegNo(prefix, number) {
  return `${prefix}${String(number).padStart(7, '0')}`;
}

function isPdfBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
}

(async () => {
  const baseTemplate = process.env.STUDENT_CARD_TEMPLATE_URL ||
    'https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&argnum=2&formId=57499&1666=1666&appSeqNo=APP3908399&checksum=gygBwj9R%252F5aDFtG%252BwBcvBw%253D%253D&entityId=3908399&sessChk=1775935472848&callForOrg=ICAI&user_id=&requiredReport=StudentCard&PDFName=StudentCard&studentRegNo=WRO0873063';

  const startRegNo = process.env.DOWNLOAD_START_REGNO || 'WRO0873063';
  const count = Number(process.env.DOWNLOAD_COUNT || 2);
  const outDir = path.resolve(process.env.DOWNLOAD_OUTPUT_DIR || './output/downloaded-cards');

  const m = startRegNo.match(/^([A-Z]+)(\d{7})$/i);
  if (!m) {
    throw new Error(`Invalid DOWNLOAD_START_REGNO: ${startRegNo}. Expected like WRO0873063`);
  }

  const prefix = m[1].toUpperCase();
  const startNum = Number(m[2]);

  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });

  const page = await context.newPage();

  console.log('Logging in to ICAI...');
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
    await page.waitForTimeout(1000);
  }

  console.log(`Logged in. Starting download sequence from ${startRegNo}, count=${count}`);

  const results = [];

  for (let i = 0; i < count; i++) {
    const regNo = buildRegNo(prefix, startNum + i);
    const url = buildUrl(baseTemplate, regNo);

    try {
      const resp = await context.request.get(url, {
        headers: {
          'Accept': 'application/pdf,text/html;q=0.9,*/*;q=0.8',
          'Referer': 'https://eservices.icai.org/'
        },
        timeout: 90000
      });

      const status = resp.status();
      const contentType = (resp.headers()['content-type'] || '').toLowerCase();
      const body = await resp.body();

      if (status === 200 && (contentType.includes('application/pdf') || isPdfBuffer(body))) {
        const outPdf = path.join(outDir, `${regNo}.pdf`);
        fs.writeFileSync(outPdf, body);
        console.log(`OK ${regNo} -> ${outPdf}`);
        results.push({ regNo, status, ok: true, contentType, file: outPdf });
      } else {
        const outHtml = path.join(outDir, `${regNo}.html`);
        fs.writeFileSync(outHtml, body);
        console.log(`FAIL ${regNo} status=${status} contentType=${contentType} (saved html)`);
        results.push({ regNo, status, ok: false, contentType, file: outHtml });
      }
    } catch (e) {
      console.log(`ERROR ${regNo}: ${e.message}`);
      results.push({ regNo, ok: false, error: e.message });
    }
  }

  const reportPath = path.join(outDir, 'download-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Report: ${reportPath}`);

  await context.storageState({ path: path.join(outDir, 'session-state.json') });
  await browser.close();
})();
