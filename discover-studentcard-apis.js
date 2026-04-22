const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config();

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });

  const page = await context.newPage();
  const events = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('eservices.icai.org')) return;

    const rt = req.resourceType();
    if (rt === 'xhr' || rt === 'fetch' || url.includes('servlet') || url.includes('loginAction.do') || url.includes('/Login/')) {
      events.push({
        type: 'request',
        method: req.method(),
        url,
        resourceType: rt,
        postData: req.postData() || ''
      });
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('eservices.icai.org')) return;

    const req = res.request();
    const rt = req.resourceType();
    if (rt === 'xhr' || rt === 'fetch' || url.includes('servlet') || url.includes('loginAction.do') || url.includes('/Login/')) {
      const ct = res.headers()['content-type'] || '';
      let bodySample = '';
      if (ct.includes('json') || ct.includes('text') || ct.includes('html')) {
        try {
          bodySample = (await res.text()).slice(0, 1000);
        } catch (_) {}
      }
      events.push({
        type: 'response',
        status: res.status(),
        url,
        resourceType: rt,
        contentType: ct,
        bodySample
      });
    }
  });

  // Login
  await page.goto('https://eservices.icai.org/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.fill('#accountname', process.env.ICAI_USER_ID || '');
  await page.fill('#password', process.env.ICAI_PASSWORD || '');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => null),
    page.click('button:has-text("Sign In"), .loginBtn')
  ]);

  await page.waitForTimeout(3000);

  // Close modal if present
  const closeModal = page.locator('button:has-text("Close")').first();
  if (await closeModal.count()) {
    await closeModal.click().catch(() => {});
    await page.waitForTimeout(1200);
  }

  // Trigger Student Id Card listing tab directly using known dashboard hook
  await page.evaluate(() => {
    if (typeof window.fnGetChildDataForList === 'function') {
      window.fnGetChildDataForList('0SxfWvrVmnsmCnU4nv7ZoLLiqKfku9zVHDkQIlAUJ60%3D', '126', 'listGrid126', '547', 'refresh', '64447');
    }
  });
  await page.waitForTimeout(8000);

  // Click possible view/download controls to capture PDF API hit
  const selectors = ['i.fa-download', 'a[onclick*="fnGeneratePdf"]', 'a[title*="View"]', 'a[title*="Download"]'];
  for (const s of selectors) {
    const loc = page.locator(s);
    const cnt = await loc.count();
    if (cnt > 0) {
      await loc.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
    }
  }

  await page.waitForTimeout(5000);

  fs.writeFileSync('output/discovered_api_events.json', JSON.stringify(events, null, 2));

  const uniqueUrls = [...new Set(events.map((e) => e.url))].sort();
  fs.writeFileSync('output/discovered_api_urls.txt', uniqueUrls.join('\n'));

  await page.screenshot({ path: 'output/discovered_api_page.png', fullPage: true });
  await browser.close();
})();
