const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');
const logger = require('./logger');

class CSVExporter {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.batchSize = 1000;
    this.currentBatch = [];
    this.batchCount = 0;
  }

  addRecord(record) {
    this.currentBatch.push(record);
    
    if (this.currentBatch.length >= this.batchSize) {
      return this.flushBatch();
    }
    return null;
  }

  async flushBatch() {

    if (this.currentBatch.length === 0) {
      logger.info('No records to flush');
      return null;
    }

    try {
      this.batchCount++;
      const fileName = `students_batch_${String(this.batchCount).padStart(5, '0')}_${Date.now()}.csv`;
      const filePath = path.join(this.outputDir, fileName);

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
        { id: 'courseExamDetails', title: 'Course & Exam Details' }
      ];

      const csvWriter = createObjectCsvWriter({
        path: filePath,
        header: headers
      });

      const recordCount = this.currentBatch.length;
      logger.info(`Flushing ${recordCount} records to ${fileName}...`);
      await csvWriter.writeRecords(this.currentBatch);

      logger.info(`Batch ${this.batchCount} exported: ${recordCount} records to ${fileName}`);

      this.currentBatch = [];
      return { fileName, recordCount };
    } catch (error) {
      logger.error('CSV export failed:', error.message);
      throw error;
    }
  }

  async finalize() {
    logger.info(`Finalizing: ${this.currentBatch.length} records in buffer`);
    return this.flushBatch();
  }

  getBatchCount() {
    return this.batchCount;
  }
}

module.exports = CSVExporter;
