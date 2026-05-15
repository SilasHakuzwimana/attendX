const logger = require("../utils/logger");

const requestLogger = (req, res, next) => {
  const start = Date.now();

  // Log request
  logger.info(`${req.method} ${req.url} - Request received`);

  // Capture response
  const originalSend = res.send;
  res.send = function (data) {
    const duration = Date.now() - start;
    const status = res.statusCode;

    // Log response
    logger.info(`${req.method} ${req.url} - ${status} - ${duration}ms`);

    // Log slow requests (> 1 second)
    if (duration > 1000) {
      logger.warn(`Slow request: ${req.method} ${req.url} - ${duration}ms`);
    }

    originalSend.call(this, data);
  };

  next();
};

module.exports = { requestLogger };
