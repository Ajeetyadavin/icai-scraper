const fs = require('fs');
const path = require('path');

const htmlPath = path.resolve('./output/after_transaction_click.html');
const outputPath = path.resolve('./output/studentcard_api_recipe.json');

if (!fs.existsSync(htmlPath)) {
  console.error('Missing file:', htmlPath);
  process.exit(1);
}

function parseAttributes(tag) {
  const attrs = {};
  const attrRegex = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(tag)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

const html = fs.readFileSync(htmlPath, 'utf8');
const studentTabTagMatch = html.match(/<PDFTAB[^>]*tabDesc="Student Id Card"[^>]*>/i);
const studentTabAttrs = studentTabTagMatch ? parseAttributes(studentTabTagMatch[0]) : null;

const refreshHookRegex = /fnGetChildDataForList\('([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'refresh'\s*,\s*'([^']+)'\)/g;
const refreshHooks = [];
let hookMatch;
while ((hookMatch = refreshHookRegex.exec(html)) !== null) {
  refreshHooks.push({
    tabListFormId: hookMatch[1],
    fragmentId: hookMatch[2],
    listGridId: hookMatch[3],
    tabId: hookMatch[4],
    listFormId: hookMatch[5]
  });
}

let matchedRefreshHook = null;
if (studentTabAttrs) {
  matchedRefreshHook = refreshHooks.find(
    (h) =>
      h.tabId === (studentTabAttrs.tabId || '') &&
      h.listFormId === (studentTabAttrs.listFormId || '')
  );
}

const recipe = {
  extractedAt: new Date().toISOString(),
  sourceHtml: htmlPath,
  apiChain: {
    login: {
      method: 'POST',
      url: 'https://eservices.icai.org/Login/Login'
    },
    dashboard: {
      method: 'GET',
      url: 'https://eservices.icai.org/EForms/loginAction.do?subAction=ViewLoginPage&formId=57499&orgId=1666'
    },
    listing: {
      method: 'POST',
      url: 'https://eservices.icai.org/EForms/FormListServlet',
      triggerJs: 'fnGetChildDataForList(tabListFormId, fragmentId, listGridId, tabId, refresh, listFormId)',
      discoveredArgs: matchedRefreshHook || null
    },
    studentCardPdf: {
      method: 'GET',
      urlTemplate:
        'https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&argnum=2&formId=57499&1666=1666&appSeqNo=APP3908399&checksum=gygBwj9R%252F5aDFtG%252BwBcvBw%253D%253D&entityId=3908399&sessChk=1775935472848&callForOrg=ICAI&user_id=&requiredReport=StudentCard&PDFName=StudentCard&studentRegNo={SRN}'
    }
  },
  studentIdCardTab: studentTabAttrs,
  refreshHooksFound: refreshHooks.length
};

fs.writeFileSync(outputPath, JSON.stringify(recipe, null, 2));

console.log('=== Student Id Card tab metadata ===');
if (studentTabAttrs) {
  console.log('listFormId:', studentTabAttrs.listFormId || '');
  console.log('tabId:', studentTabAttrs.tabId || '');
  console.log('tabListFormId:', studentTabAttrs.tabListFormId || '');
} else {
  console.log('tab metadata not found');
}

console.log('\n=== Refresh hook (best match) ===');
if (matchedRefreshHook) {
  console.log(
    `fnGetChildDataForList('${matchedRefreshHook.tabListFormId}','${matchedRefreshHook.fragmentId}','${matchedRefreshHook.listGridId}','${matchedRefreshHook.tabId}','refresh','${matchedRefreshHook.listFormId}')`
  );
} else {
  console.log('No exact refresh hook match found; check refreshHooksFound in JSON output.');
}

console.log('\n=== API chain ===');
console.log('1) Login POST: https://eservices.icai.org/Login/Login');
console.log(
  '2) Dashboard/App: https://eservices.icai.org/EForms/loginAction.do?subAction=ViewLoginPage&formId=57499&orgId=1666'
);
console.log('3) Listing JSON: https://eservices.icai.org/EForms/FormListServlet');
console.log('4) PDF download: https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&...');
console.log('\nWrote:', outputPath);
