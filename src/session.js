const logger = require('./logger');

class SessionManager {
  constructor(authManager) {
    this.authManager = authManager;
    this.sessionStartTime = null;
  }

  async initialize() {
    try {
      await this.authManager.initialize();
      await this.authManager.login();
      this.sessionStartTime = Date.now();
      logger.info('Mock session initialized');
    } catch (error) {
      logger.error('Session initialization failed', error);
      throw error;
    }
  }

  async checkAndRefreshSession() {
    // No-op for mock
  }

  updateActivity() {
    // No-op for mock
  }

  getSessionDuration() {
    return Date.now() - this.sessionStartTime;
  }

  async close() {
    await this.authManager.close();
  }
}

module.exports = SessionManager;
