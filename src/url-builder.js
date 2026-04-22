const logger = require('./logger');

class URLBuilder {
  constructor(prefix, startNumber, count) {
    this.prefix = prefix;
    this.startNumber = startNumber;
    this.count = count;
    this.baseUrl = 'https://eservices.icai.org/EForms/cdmsmiscservlet?actionId=downloadSecurePDFForBrowser&argnum=2&formId=57499&1666=1666&appSeqNo=APP3908399&checksum=gygBwj9R%252F5aDFtG%252BwBcvBw%253D%253D&entityId=3908399&sessChk=SESSID&callForOrg=ICAI&user_id=&requiredReport=StudentCard&PDFName=StudentCard&studentRegNo=';
  }

  generateStudentNumbers() {
    const numbers = [];
    for (let i = 0; i < this.count; i++) {
      const num = this.startNumber + i;
      const studentRegNo = `${this.prefix}${String(num).padStart(7, '0')}`;
      numbers.push(studentRegNo);
    }
    logger.info(`Generated ${numbers.length} student registration numbers`);
    return numbers;
  }

  buildURL(studentRegNo, sessionId) {
    const url = this.baseUrl.replace('SESSID', sessionId) + studentRegNo;
    return url;
  }

  validateStudentNumber(regNo) {
    const regex = new RegExp(`^${this.prefix}\\d{7}$`);
    return regex.test(regNo);
  }
}

module.exports = URLBuilder;
