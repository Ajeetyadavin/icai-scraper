const logger = require('./logger');

class AuthManager {
  constructor(credentials) {
    this.credentials = credentials;
  }

  async initialize() {
    logger.info('Mock mode: Simulating browser initialization');
    return true;
  }

  async login() {
    logger.info(`Mock login: Authenticated as ${this.credentials.userId}`);
    return true;
  }

  async getPage() {
    return { mock: true };
  }

  async close() {
    logger.info('Mock browser closed');
  }
}

module.exports = AuthManager;
