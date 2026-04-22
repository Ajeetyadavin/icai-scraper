const logger = require('./logger');

class PDFFetcher {
  constructor(page) {
    this.page = page;
  }

  async fetchPDF(url, studentRegNo) {
    // Mock: simulate PDF fetch
    logger.debug(`Mock fetch: Retrieved PDF for ${studentRegNo}`);
    return Buffer.from(`Mock PDF for ${studentRegNo}`);
  }
}

module.exports = PDFFetcher;
