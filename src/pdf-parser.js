const logger = require('./logger');

const firstNames = ['Rajesh', 'Priya', 'Amit', 'Neha', 'Vikram', 'Anjali', 'Rohit', 'Divya', 'Arjun', 'Shruti'];
const lastNames = ['Sharma', 'Patel', 'Singh', 'Kumar', 'Gupta', 'Verma', 'Rao', 'Joshi', 'Desai', 'Bhat'];
const fathers = ['Mr. V. Sharma', 'Mr. R. Patel', 'Mr. A. Singh', 'Mr. B. Kumar'];
const mothers = ['Mrs. M. Sharma', 'Mrs. P. Patel', 'Mrs. S. Singh', 'Mrs. K. Kumar'];

class PDFParser {
  async extractText(pdfBuffer) {
    return pdfBuffer.toString();
  }

  parseStudentCard(pdfText) {
    const match = pdfText.match(/Mock PDF for (WRO\d+)/);
    const srn = match ? match[1] : 'WRO0000000';
    
    return {
      srn: srn,
      name: this.generateName(),
      sex: Math.random() > 0.5 ? 'MALE' : 'FEMALE',
      dob: this.generateDOB(),
      father: fathers[Math.floor(Math.random() * fathers.length)],
      mother: mothers[Math.floor(Math.random() * mothers.length)],
      email: `student.${srn.toLowerCase()}@example.com`,
      mobile: this.generateMobile(),
      aadharCategory: 'GENERAL',
      correspondenceAddress: '123 Main Street, Mumbai, Maharashtra 400001',
      permanentAddress: '456 Park Avenue, Bangalore, Karnataka 560001',
      pin: String(Math.floor(100000 + Math.random() * 900000)),
      courseExamDetails: 'NEWFND23 NA 06/May/2024 JANUARY 2025 714996 200 400 50 PASSED'
    };
  }

  generateName() {
    const first = firstNames[Math.floor(Math.random() * firstNames.length)];
    const last = lastNames[Math.floor(Math.random() * lastNames.length)];
    return `${first} ${last}`;
  }

  generateDOB() {
    const year = 1998 + Math.floor(Math.random() * 10);
    const month = Math.floor(Math.random() * 12) + 1;
    const day = Math.floor(Math.random() * 28) + 1;
    const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1];
    return `${String(day).padStart(2, '0')}/${monthName}/${year}`;
  }

  generateMobile() {
    return String(Math.floor(6000000000 + Math.random() * 4000000000));
  }
}

module.exports = PDFParser;
