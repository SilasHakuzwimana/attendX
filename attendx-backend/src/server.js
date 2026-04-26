const { PrismaClient } = require("@prisma/client");
const { initRedis } = require("./config/redis");
const { createServer } = require("http");
const { initSocket } = require("./sockets");
const { startBackgroundJobs } = require("./jobs");
const app = require("./app");
const config = require("./config");
const logger = require("./utils/logger");

const prisma = new PrismaClient();
const server = createServer(app);

// Make prisma and redis available globally
global.prisma = prisma;

const startServer = async () => {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info("✅ Database connected successfully");

    // Initialize Redis
    const redis = await initRedis();
    global.redis = redis;

    // Initialize Socket.IO
    const io = initSocket(server);
    global.io = io;

    // Start background jobs
    startBackgroundJobs();

    // Start server
    server.listen(config.port, () => {
      logger.info(`
        ################################################
        🚀 Server listening on port: ${config.port}
        🌍 Environment: ${config.env}
        
        📚 API Endpoints:
           Main API: http://localhost:${config.port}/api
           Versioned: http://localhost:${config.port}/api/v1
           
        🔗 Available Routes:
           Auth: http://localhost:${config.port}/api/v1/auth
           Users: http://localhost:${config.port}/api/v1/users
           Sessions: http://localhost:${config.port}/api/v1/sessions
           
        🏥 Health: http://localhost:${config.port}/health
        ################################################
      `);
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info("Shutting down gracefully...");
      await prisma.$disconnect();
      await redis.quit();
      server.close(() => {
        logger.info("Server closed");
        process.exit(0);
      });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
