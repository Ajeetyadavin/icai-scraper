const logger = require('./logger');
const PDFFetcher = require('./pdf-fetcher');
const PDFParser = require('./pdf-parser');

class BatchProcessor {
  constructor(sessionManager, csvExporter, errorHandler, urlBuilder) {
    this.sessionManager = sessionManager;
    this.csvExporter = csvExporter;
    this.errorHandler = errorHandler;
    this.urlBuilder = urlBuilder;
    this.concurrency = 5;
    this.processedCount = 0;
    this.startTime = null;
  }

  async processBatch(studentNumbers) {
    try {
      this.startTime = Date.now();
      logger.info(`Starting batch processing: ${studentNumbers.length} records`);

      const page = await this.sessionManager.authManager.getPage();
      const fetcher = new PDFFetcher(page);
      const parser = new PDFParser();

      // Process in chunks with concurrency limit
      for (let i = 0; i < studentNumbers.length; i += this.concurrency) {
        const chunk = studentNumbers.slice(i, i + this.concurrency);
        
        // Check session before processing chunk
        await this.sessionManager.checkAndRefreshSession();

        // Process chunk in parallel
        const results = await Promise.allSettled(
          chunk.map(regNo => this.processStudent(regNo, fetcher, parser))
        );

        // Collect results
        for (let j = 0; j < results.length; j++) {
          if (results[j].status === 'fulfilled') {
            const record = results[j].value;
            if (record) {
              await this.csvExporter.addRecord(record);
              this.processedCount++;
            }
          } else {
            const error = results[j].reason;
            const regNo = chunk[j];
            this.errorHandler.recordError(regNo, error);
          }
        }

        // Log progress
        this.logProgress(i + this.concurrency, studentNumbers.length);

        this.sessionManager.updateActivity();
      }

      // Finalize CSV export
      await this.csvExporter.finalize();
      logger.info(`Batch processing completed: ${this.processedCount} records processed`);

    } catch (error) {
      logger.error('Batch processing failed', error);
      throw error;
    }
  }

  async processStudent(studentRegNo, fetcher, parser) {
    try {
      // Generate URL (using dummy session ID for now)
      const url = this.urlBuilder.buildURL(studentRegNo, 'SESSION123');

      // Fetch PDF
      const pdfBuffer = await fetcher.fetchPDF(url, studentRegNo);

      // Parse PDF
      const text = await parser.extractText(pdfBuffer);
      const fields = parser.parseStudentCard(text);

      return fields;
    } catch (error) {
      logger.error(`Failed to process ${studentRegNo}`, error);
      throw error;
    }
  }

  logProgress(current, total) {
    const percentage = ((current / total) * 100).toFixed(2);
    const elapsed = Date.now() - this.startTime;
    const rate = this.processedCount / (elapsed / 1000);
    const remainingRecords = total - current;
    const eta = (remainingRecords / rate).toFixed(0);

    logger.info(
      `Progress: ${current}/${total} (${percentage}%) | Rate: ${rate.toFixed(2)} rec/sec | ETA: ${eta}s`
    );
  }

  getStats() {
    const elapsed = Date.now() - this.startTime;
    return {
      processed: this.processedCount,
      failed: this.errorHandler.failed.length,
      duration: elapsed,
      rate: (this.processedCount / (elapsed / 1000)).toFixed(2)
    };
  }
}

module.exports = BatchProcessor;
