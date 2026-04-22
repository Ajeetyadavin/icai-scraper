#!/usr/bin/env node

const path = require('path');
const logger = require('./src/logger');
const AuthManager = require('./src/auth');
const SessionManager = require('./src/session');
const URLBuilder = require('./src/url-builder');
const BatchProcessor = require('./src/batch-processor');
const CSVExporter = require('./src/csv-exporter');
const ErrorHandler = require('./src/error-handler');

const credentialsL = {
  userId: 'WRO0873063@icai.org',
  password: 'Ajju007@@'
};

const STUDENT_PREFIX = 'WRO';
const START_NUMBER = 873000;
const RECORD_COUNT = 100000;
const OUTPUT_DIR = path.join(__dirname, 'output');

async function main() {
  const startTime = Date.now();
  logger.info('========== ICAI SCRAPER STARTED ==========');
  logger.info(`Prefix: ${STUDENT_PREFIX}, Start: ${START_NUMBER}, Count: ${RECORD_COUNT}`);

  let sessionManager = null;

  try {
    // Initialize components
    const authManager = new AuthManager(credentialsL);
    sessionManager = new SessionManager(authManager);
    const urlBuilder = new URLBuilder(STUDENT_PREFIX, START_NUMBER, RECORD_COUNT);
    const csvExporter = new CSVExporter(OUTPUT_DIR);
    const errorHandler = new ErrorHandler();

    // Initialize session
    logger.info('Initializing session...');
    await sessionManager.initialize();

    // Generate student numbers
    const studentNumbers = urlBuilder.generateStudentNumbers();
    logger.info(`Generated ${studentNumbers.length} student registration numbers`);

    // Process batch
    const batchProcessor = new BatchProcessor(sessionManager, csvExporter, errorHandler, urlBuilder);
    await batchProcessor.processBatch(studentNumbers);

    // Generate report
    const stats = batchProcessor.getStats();
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);

    logger.info('========== FINAL REPORT ==========');
    logger.info(`Total Records: ${studentNumbers.length}`);
    logger.info(`Successfully Processed: ${stats.processed}`);
    logger.info(`Failed: ${stats.failed}`);
    logger.info(`Success Rate: ${((stats.processed / studentNumbers.length) * 100).toFixed(2)}%`);
    logger.info(`Processing Rate: ${stats.rate} records/second`);
    logger.info(`Total Duration: ${totalTime} seconds`);
    logger.info(`CSV Batches Created: ${csvExporter.getBatchCount()}`);

    if (stats.failed > 0) {
      const failedPath = path.join(OUTPUT_DIR, 'failed_records.json');
      errorHandler.exportFailedRecords(failedPath);
      logger.info(`Failed records saved to: ${failedPath}`);
    }

    logger.info('========== SCRAPER COMPLETED SUCCESSFULLY ==========');

  } catch (error) {
    logger.error('FATAL ERROR', error);
    process.exit(1);
  } finally {
    if (sessionManager) {
      await sessionManager.close();
    }
  }
}

main();
