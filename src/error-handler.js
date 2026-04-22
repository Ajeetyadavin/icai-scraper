const logger = require('./logger');

class ErrorHandler {
  constructor() {
    this.failed = [];
    this.errors = {
      network: 0,
      parsing: 0,
      session: 0,
      other: 0
    };
  }

  recordError(studentRegNo, error, errorType = 'other') {
    this.failed.push({
      studentRegNo,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    this.errors[errorType]++;
    logger.warn(`Error recorded for ${studentRegNo}: ${error.message} (type: ${errorType})`);
  }

  getReport() {
    return {
      totalFailed: this.failed.length,
      errorBreakdown: this.errors,
      failedRecords: this.failed
    };
  }

  exportFailedRecords(filePath) {
    const fs = require('fs');
    fs.writeFileSync(
      filePath,
      JSON.stringify(this.failed, null, 2)
    );
    logger.info(`Failed records exported to ${filePath}`);
  }
}

module.exports = ErrorHandler;
