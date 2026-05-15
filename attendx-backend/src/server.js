const { PrismaClient } = require("@prisma/client");
const { createServer } = require("http");
const { initRedis } = require("./config/redis");
const { initSocket } = require("./sockets");
const { startBackgroundJobs } = require("./jobs");
const app = require("./app");
const config = require("./config");
const logger = require("./utils/logger");

// Initialize Prisma Client with logging
const prisma = new PrismaClient({
  log: config.env === "development" ? ["query", "error", "warn"] : ["error"],
  errorFormat: "pretty",
});

// Make prisma available globally
global.prisma = prisma;

// Server instance
let server = null;
let redisClient = null;

/**
 * Graceful shutdown handler
 */
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    logger.error("Forced shutdown due to timeout");
    process.exit(1);
  }, 30000); // 30 seconds timeout

  try {
    // Stop accepting new connections
    if (server) {
      server.close(async () => {
        logger.info("HTTP server closed");
      });
    }

    // Close WebSocket connections
    if (global.io) {
      await global.io.close();
      logger.info("WebSocket server closed");
    }

    // Close Redis connection
    if (redisClient) {
      await redisClient.quit();
      logger.info("Redis connection closed");
    }

    // Close Prisma database connection
    await prisma.$disconnect();
    logger.info("Database connection closed");

    // Stop background jobs
    const { stopBackgroundJobs } = require("./jobs");
    await stopBackgroundJobs();
    logger.info("Background jobs stopped");

    clearTimeout(shutdownTimeout);
    logger.info("Graceful shutdown completed");
    process.exit(0);
  } catch (error) {
    logger.error("Error during graceful shutdown:", error);
    process.exit(1);
  }
};

/**
 * Start the server
 */
const startServer = async () => {
  try {
    // ==================== DATABASE CONNECTION ====================
    await prisma.$connect();
    logger.info("✅ Database connected successfully");

    // Test database connection
    const dbVersion = await prisma.$queryRaw`SELECT version()`;
    logger.info(`📀 PostgreSQL version: ${dbVersion[0].version.split(",")[0]}`);

    // ==================== REDIS CONNECTION ====================
    redisClient = await initRedis();
    global.redisClient = redisClient;
    logger.info("✅ Redis connected successfully");

    // ==================== HTTP SERVER ====================
    server = createServer(app);

    // ==================== SOCKET.IO INITIALIZATION ====================
    const io = initSocket(server);
    global.io = io;
    logger.info("✅ WebSocket server initialized");

    // ==================== BACKGROUND JOBS ====================
    await startBackgroundJobs();
    logger.info("✅ Background jobs started");

    // ==================== START LISTENING ====================
    server.listen(config.port, config.host || "0.0.0.0", () => {
      const startupMessage = `
        ╔══════════════════════════════════════════════════════════════╗
        ║                                                              ║
        ║                    🚀 AttendX API Server                     ║
        ║                                                              ║
        ║   Status:     ✅ Online                                      ║
        ║   Port:       ${String(config.port).padEnd(38)}║
        ║   Environment: ${(config.env || "development").padEnd(38)}║
        ║   Version:    ${(config.apiVersion || "1.0.0").padEnd(38)}║
        ║                                                              ║
        ║   📚 API Documentation: http://localhost:${config.port}/api/v1/docs║
        ║   💚 Health Check:      http://localhost:${config.port}/health║
        ║   🔌 WebSocket:         ws://localhost:${config.port}        ║
        ║                                                              ║
        ╚══════════════════════════════════════════════════════════════╝
      `;
      logger.info(startupMessage);
    });

    // ==================== ERROR HANDLING ====================
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        logger.error(`Port ${config.port} is already in use`);
        process.exit(1);
      } else {
        logger.error("Server error:", error);
      }
    });

    // ==================== PROCESS EVENT HANDLERS ====================

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      logger.error("Uncaught Exception:", error);
      gracefulShutdown("UNCAUGHT_EXCEPTION");
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", (reason, promise) => {
      logger.error("Unhandled Rejection at:", promise, "reason:", reason);
      gracefulShutdown("UNHANDLED_REJECTION");
    });

    // Graceful shutdown signals
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    // Handle exit
    process.on("exit", (code) => {
      logger.info(`Process exiting with code: ${code}`);
    });
  } catch (error) {
    logger.error("Failed to start server:", error);

    // Cleanup on startup failure
    try {
      await prisma.$disconnect();
    } catch (dbError) {
      logger.error("Error disconnecting database:", dbError);
    }

    try {
      if (redisClient) await redisClient.quit();
    } catch (redisError) {
      logger.error("Error disconnecting Redis:", redisError);
    }

    process.exit(1);
  }
};

// ==================== HELPER FUNCTIONS ====================

/**
 * Get server status
 */
const getServerStatus = () => {
  return {
    status: server
      ? server.listening
        ? "running"
        : "stopped"
      : "not initialized",
    port: config.port,
    environment: config.env,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: {
      database: global.prisma ? "connected" : "disconnected",
      redis: global.redisClient?.isReady ? "connected" : "disconnected",
      websocket: global.io ? "running" : "stopped",
    },
  };
};

/**
 * Get server metrics
 */
const getServerMetrics = async () => {
  const metrics = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    eventLoopLag: 0,
    activeHandles: process._getActiveHandles().length,
    activeRequests: process._getActiveRequests().length,
  };

  // Calculate event loop lag
  const start = process.hrtime();
  await new Promise((resolve) => setImmediate(resolve));
  const diff = process.hrtime(start);
  metrics.eventLoopLag = diff[0] * 1000 + diff[1] / 1000000;

  return metrics;
};

// Export for monitoring
module.exports = {
  startServer,
  getServerStatus,
  getServerMetrics,
  gracefulShutdown,
};

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}
