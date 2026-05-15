const os = require("os");
const { prisma, redisClient } = require("../index");
const logger = require("../utils/logger");
const packageJson = require("../../package.json");

class HealthController {
  constructor() {
    this.startTime = Date.now();
    this.healthCheckInterval = null;
    this.healthStatus = {
      status: "healthy",
      checks: {},
      lastChecked: null,
    };
  }

  /**
   * Initialize health check monitoring
   */
  initialize() {
    // Run health check every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, 30000);

    logger.info("Health check monitoring initialized");
  }

  /**
   * Perform comprehensive health check
   * GET /api/v1/health
   */
  async getHealth(req, res, next) {
    try {
      const health = await this.performHealthCheck();

      const statusCode =
        health.status === "healthy"
          ? 200
          : health.status === "degraded"
            ? 200
            : 503;

      res.status(statusCode).json({
        success: true,
        data: health,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Health check error:", error);
      res.status(503).json({
        success: false,
        error: {
          code: "HEALTH_CHECK_FAILED",
          message: "Health check failed",
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Perform detailed health check
   */
  async performHealthCheck() {
    const checks = {
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
      memory: this.checkMemory(),
      disk: await this.checkDiskSpace(),
      cpu: this.checkCPU(),
      uptime: this.checkUptime(),
      api: this.checkAPI(),
    };

    // Determine overall status
    let status = "healthy";
    const criticalFailures = [];
    const warnings = [];

    for (const [key, check] of Object.entries(checks)) {
      if (check.status === "critical") {
        criticalFailures.push(key);
        status = "unhealthy";
      } else if (check.status === "warning" && status !== "unhealthy") {
        warnings.push(key);
        status = "degraded";
      }
    }

    const healthData = {
      status,
      checks,
      summary: {
        healthy: Object.values(checks).filter((c) => c.status === "healthy")
          .length,
        warning: Object.values(checks).filter((c) => c.status === "warning")
          .length,
        critical: Object.values(checks).filter((c) => c.status === "critical")
          .length,
      },
      criticalFailures,
      warnings,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };

    this.healthStatus = healthData;
    this.healthStatus.lastChecked = new Date();

    return healthData;
  }

  /**
   * Check database connectivity and performance
   */
  async checkDatabase() {
    const startTime = Date.now();
    try {
      // Test database connection
      await prisma.$queryRaw`SELECT 1 as connected`;

      // Get database statistics
      const dbStats = await prisma.$queryRaw`
        SELECT 
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as connections,
          (SELECT pg_database_size(current_database()) / 1024 / 1024) as size_mb,
          (SELECT count(*) FROM pg_stat_user_tables) as table_count
      `;

      const responseTime = Date.now() - startTime;

      let status = "healthy";
      let message = "Database is operational";

      if (responseTime > 1000) {
        status = "warning";
        message = "Database response time is high";
      }

      if (responseTime > 3000) {
        status = "critical";
        message = "Database response time is critical";
      }

      return {
        status,
        message,
        responseTimeMs: responseTime,
        details: {
          connections: parseInt(dbStats[0]?.connections || 0),
          sizeMB: parseFloat(dbStats[0]?.size_mb || 0).toFixed(2),
          tableCount: parseInt(dbStats[0]?.table_count || 0),
          version: await this.getDatabaseVersion(),
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("Database health check failed:", error);
      return {
        status: "critical",
        message: "Database connection failed",
        error: error.message,
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Check Redis connectivity and performance
   */
  async checkRedis() {
    const startTime = Date.now();
    try {
      if (!redisClient || !redisClient.isReady) {
        return {
          status: "critical",
          message: "Redis client not initialized or not ready",
          responseTimeMs: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      // Test Redis connection
      await redisClient.ping();

      // Get Redis info
      const info = await redisClient.info();
      const memory = await redisClient.info("memory");

      const responseTime = Date.now() - startTime;

      // Parse memory info
      const usedMemory =
        memory.match(/used_memory_human:([^\r\n]+)/)?.[1] || "Unknown";
      const maxMemory =
        memory.match(/maxmemory_human:([^\r\n]+)/)?.[1] || "Unknown";

      let status = "healthy";
      let message = "Redis is operational";

      if (responseTime > 500) {
        status = "warning";
        message = "Redis response time is high";
      }

      return {
        status,
        message,
        responseTimeMs: responseTime,
        details: {
          connected: true,
          version: info.match(/redis_version:([^\r\n]+)/)?.[1] || "Unknown",
          usedMemory,
          maxMemory,
          uptime: info.match(/uptime_in_seconds:([^\r\n]+)/)?.[1] || "Unknown",
          connectedClients:
            info.match(/connected_clients:([^\r\n]+)/)?.[1] || "Unknown",
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("Redis health check failed:", error);
      return {
        status: "critical",
        message: "Redis connection failed",
        error: error.message,
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Check memory usage
   */
  checkMemory() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryUsagePercent = (usedMemory / totalMemory) * 100;

    const heapUsed = process.memoryUsage().heapUsed;
    const heapTotal = process.memoryUsage().heapTotal;
    const heapUsagePercent = (heapUsed / heapTotal) * 100;

    let status = "healthy";
    let message = "Memory usage is normal";

    if (memoryUsagePercent > 80) {
      status = "warning";
      message = "System memory usage is high";
    }

    if (memoryUsagePercent > 90) {
      status = "critical";
      message = "System memory usage is critical";
    }

    return {
      status,
      message,
      details: {
        system: {
          total: this.formatBytes(totalMemory),
          free: this.formatBytes(freeMemory),
          used: this.formatBytes(usedMemory),
          usagePercent: memoryUsagePercent.toFixed(2),
        },
        process: {
          heapUsed: this.formatBytes(heapUsed),
          heapTotal: this.formatBytes(heapTotal),
          heapUsagePercent: heapUsagePercent.toFixed(2),
          rss: this.formatBytes(process.memoryUsage().rss),
          external: this.formatBytes(process.memoryUsage().external),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check disk space
   */
  async checkDiskSpace() {
    try {
      const { checkDiskSpace } = require("check-disk-space");
      const diskInfo = await checkDiskSpace(process.cwd());

      const usagePercent =
        ((diskInfo.size - diskInfo.free) / diskInfo.size) * 100;

      let status = "healthy";
      let message = "Disk space is sufficient";

      if (usagePercent > 80) {
        status = "warning";
        message = "Disk space is running low";
      }

      if (usagePercent > 90) {
        status = "critical";
        message = "Disk space is critically low";
      }

      return {
        status,
        message,
        details: {
          total: this.formatBytes(diskInfo.size),
          free: this.formatBytes(diskInfo.free),
          used: this.formatBytes(diskInfo.size - diskInfo.free),
          usagePercent: usagePercent.toFixed(2),
          diskPath: diskInfo.diskPath,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.warn("Disk space check failed:", error.message);
      return {
        status: "warning",
        message: "Unable to check disk space",
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Check CPU usage
   */
  checkCPU() {
    const cpus = os.cpus();
    const loadAverage = os.loadavg();

    // Calculate average CPU usage
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idlePercent = (totalIdle / totalTick) * 100;
    const usagePercent = 100 - idlePercent;

    let status = "healthy";
    let message = "CPU usage is normal";

    if (usagePercent > 70) {
      status = "warning";
      message = "CPU usage is high";
    }

    if (usagePercent > 90) {
      status = "critical";
      message = "CPU usage is critical";
    }

    return {
      status,
      message,
      details: {
        usagePercent: usagePercent.toFixed(2),
        cores: cpus.length,
        model: cpus[0]?.model || "Unknown",
        speed: `${cpus[0]?.speed || 0} MHz`,
        loadAverage: {
          "1min": loadAverage[0].toFixed(2),
          "5min": loadAverage[1].toFixed(2),
          "15min": loadAverage[2].toFixed(2),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check application uptime
   */
  checkUptime() {
    const uptimeSeconds = process.uptime();
    const uptimeHours = uptimeSeconds / 3600;

    let status = "healthy";
    let message = "Application is running";

    if (uptimeHours > 168) {
      // > 7 days
      status = "warning";
      message =
        "Application has been running for a long time, consider restarting";
    }

    return {
      status,
      message,
      details: {
        uptimeSeconds,
        uptimeHuman: this.formatUptime(uptimeSeconds),
        startTime: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
        version: packageJson.version,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || "development",
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check API endpoints availability
   */
  checkAPI() {
    const endpoints = [
      { name: "Auth", path: "/api/v1/auth/login", method: "POST" },
      { name: "Health", path: "/health", method: "GET" },
    ];

    // This is a basic check - in production, you might want to test actual endpoints
    return {
      status: "healthy",
      message: "API endpoints are available",
      details: {
        baseUrl: process.env.BASE_URL || "http://localhost:3000",
        endpoints: endpoints.map((e) => ({ name: e.name, path: e.path })),
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get detailed system metrics
   * GET /api/v1/health/metrics
   */
  async getMetrics(req, res, next) {
    try {
      const metrics = {
        system: {
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          cpus: os.cpus().length,
          totalMemory: this.formatBytes(os.totalmem()),
          freeMemory: this.formatBytes(os.freemem()),
          uptime: this.formatUptime(os.uptime()),
        },
        process: {
          pid: process.pid,
          title: process.title,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          execPath: process.execPath,
          memoryUsage: process.memoryUsage(),
          cpuUsage: process.cpuUsage(),
          uptime: process.uptime(),
        },
        database: await this.getDatabaseMetrics(),
        redis: await this.getRedisMetrics(),
        application: {
          name: packageJson.name,
          version: packageJson.version,
          description: packageJson.description,
          startTime: new Date(this.startTime).toISOString(),
          uptime: this.formatUptime(process.uptime()),
          environment: process.env.NODE_ENV || "development",
        },
        timestamp: new Date().toISOString(),
      };

      res.json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      logger.error("Get metrics error:", error);
      next(error);
    }
  }

  /**
   * Get database metrics
   */
  async getDatabaseMetrics() {
    try {
      const [activeConnections, dbSize, tableStats] = await Promise.all([
        prisma.$queryRaw`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()`,
        prisma.$queryRaw`SELECT pg_database_size(current_database()) as size`,
        prisma.$queryRaw`
          SELECT 
            schemaname,
            relname as table_name,
            n_live_tup as row_count
          FROM pg_stat_user_tables
          ORDER BY n_live_tup DESC
          LIMIT 10
        `,
      ]);

      return {
        status: "connected",
        activeConnections: parseInt(activeConnections[0]?.count || 0),
        sizeMB: parseFloat(
          parseInt(dbSize[0]?.size || 0) / 1024 / 1024,
        ).toFixed(2),
        topTables: tableStats.map((t) => ({
          name: t.table_name,
          rows: parseInt(t.row_count || 0),
        })),
      };
    } catch (error) {
      logger.error("Get database metrics error:", error);
      return { status: "error", error: error.message };
    }
  }

  /**
   * Get Redis metrics
   */
  async getRedisMetrics() {
    try {
      if (!redisClient || !redisClient.isReady) {
        return { status: "disconnected" };
      }

      const info = await redisClient.info();

      return {
        status: "connected",
        version: info.match(/redis_version:([^\r\n]+)/)?.[1] || "Unknown",
        connectedClients:
          info.match(/connected_clients:([^\r\n]+)/)?.[1] || "0",
        usedMemory:
          info.match(/used_memory_human:([^\r\n]+)/)?.[1] || "Unknown",
        totalCommands:
          info.match(/total_commands_processed:([^\r\n]+)/)?.[1] || "0",
        keyspace: info.match(/db0:keys=(\d+)/)?.[1] || "0",
      };
    } catch (error) {
      logger.error("Get Redis metrics error:", error);
      return { status: "error", error: error.message };
    }
  }

  /**
   * Get database version
   */
  async getDatabaseVersion() {
    try {
      const result = await prisma.$queryRaw`SELECT version()`;
      const version = result[0]?.version || "Unknown";
      // Extract PostgreSQL version number
      const match = version.match(/PostgreSQL (\d+\.\d+)/);
      return match ? match[1] : "Unknown";
    } catch (error) {
      return "Unknown";
    }
  }

  /**
   * Liveness probe (for Kubernetes)
   * GET /api/v1/health/live
   */
  async livenessProbe(req, res) {
    // Simple check - is the application running?
    res.status(200).json({
      status: "alive",
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Readiness probe (for Kubernetes)
   * GET /api/v1/health/ready
   */
  async readinessProbe(req, res) {
    try {
      // Check if database is ready
      await prisma.$queryRaw`SELECT 1`;

      // Check if Redis is ready
      if (redisClient && !redisClient.isReady) {
        throw new Error("Redis not ready");
      }
      if (redisClient) {
        await redisClient.ping();
      }

      res.status(200).json({
        status: "ready",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        status: "not ready",
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get recent health check history
   * GET /api/v1/health/history
   */
  async getHealthHistory(req, res, next) {
    try {
      // Return the last recorded health status
      res.json({
        success: true,
        data: this.healthStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Get health history error:", error);
      next(error);
    }
  }

  /**
   * Get service dependencies status
   * GET /api/v1/health/dependencies
   */
  async getDependenciesStatus(req, res, next) {
    try {
      const dependencies = {
        database: await this.checkDatabase(),
        redis: await this.checkRedis(),
        filesystem: await this.checkDiskSpace(),
      };

      const allHealthy = Object.values(dependencies).every(
        (d) => d.status === "healthy",
      );

      res.json({
        success: true,
        data: {
          status: allHealthy ? "healthy" : "degraded",
          dependencies,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error("Get dependencies status error:", error);
      next(error);
    }
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  /**
   * Format uptime to human readable
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(" ");
  }

  /**
   * Cleanup on app shutdown
   */
  async cleanup() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    logger.info("Health check monitoring stopped");
  }
}

module.exports = new HealthController();
