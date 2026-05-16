const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const morgan = require("morgan");
const path = require("path");
const config = require("./config");
const {
  generalLimiter,
  loginLimiter,
} = require("./middleware/rateLimit.middleware");
const { errorHandler } = require("./middleware/error.middleware");
const { versionMiddleware } = require("./middleware/version.middleware");
const { requestLogger } = require("./middleware/logging.middleware");
const logger = require("./utils/logger");
const { initRedis, getRedisHealth } = require("./config/redis");

// Import routes
let routes = require("./routes");

const app = express();

// ==================== SECURITY MIDDLEWARE ====================

// Helmet for security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  }),
);

// CORS configuration
const corsOptions = {
  origin: config.cors?.origins || "*",
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
  ],
  exposedHeaders: [
    "X-API-Version",
    "X-API-Deprecated",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
  ],
  maxAge: 86400, // 24 hours
};

app.use(cors(corsOptions));

// Cookie parser
app.use(cookieParser());

// Compression for response bodies
app.use(
  compression({
    level: 6,
    threshold: 1024, // Compress responses > 1KB
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) {
        return false;
      }
      return compression.filter(req, res);
    },
  }),
);

// ==================== LOGGING MIDDLEWARE ====================

// Request logging in development
if (config.env === "development") {
  app.use(morgan("dev"));
}

// Custom request logger for production
app.use(requestLogger);

// ==================== BODY PARSING ====================

// JSON parser with size limit
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      try {
        JSON.parse(buf);
      } catch (e) {
        res.status(400).json({
          success: false,
          error: { code: "INVALID_JSON", message: "Invalid JSON payload" },
        });
      }
    },
  }),
);

// URL encoded parser
app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
    parameterLimit: 10000,
  }),
);

// ==================== STATIC FILES ====================

// Serve static files from public directory
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ==================== RATE LIMITING ====================

// Global rate limiter for all API routes
app.use("/api", generalLimiter);

// Stricter rate limiter for auth routes
app.use("/api/v1/auth", loginLimiter);

// ==================== API VERSION HEADERS ====================

// Add API version headers to all responses
app.use((req, res, next) => {
  res.setHeader("X-API-Version", config.apiVersion || "1.0.0");
  res.setHeader("X-API-Latest-Version", config.apiVersion || "1.0.0");
  res.setHeader("X-API-Status", "stable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// ==================== VERSION MIDDLEWARE ====================
if (versionMiddleware && typeof versionMiddleware === "function") {
  app.use(versionMiddleware);
} else {
  logger.warn(
    "versionMiddleware is not available, using default version header middleware",
  );
}

// ==================== HEALTH CHECK ENDPOINTS ====================

// Basic health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.env,
    apiVersion: config.apiVersion,
    service: "AttendX API",
  });
});

// Health check endpoint
app.get("/health/redis", async (req, res) => {
  const health = await getRedisHealth();
  res.json(health);
});

// Detailed health check
app.get("/health/detailed", async (req, res) => {
  try {
    const { prisma, redisClient } = require("./config/index");

    let dbStatus = "disconnected";
    let redisStatus = "disconnected";

    // Check database
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = "connected";
    } catch (error) {
      dbStatus = "error";
    }

    // Check Redis
    try {
      if (redisClient && redisClient.isReady) {
        await redisClient.ping();
        redisStatus = "connected";
      }
    } catch (error) {
      redisStatus = "error";
    }

    res.json({
      status:
        dbStatus === "connected" && redisStatus === "connected"
          ? "healthy"
          : "degraded",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: dbStatus,
        redis: redisStatus,
        api: "operational",
        websocket: global.io ? "operational" : "disconnected",
      },
      metrics: {
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      },
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Readiness probe (for Kubernetes)
app.get("/ready", (req, res) => {
  const isReady = global.prisma && global.redisClient?.isReady;
  if (isReady) {
    res.json({ status: "ready", timestamp: new Date().toISOString() });
  } else {
    res
      .status(503)
      .json({ status: "not ready", timestamp: new Date().toISOString() });
  }
});

// Liveness probe (for Kubernetes)
app.get("/live", (req, res) => {
  res.json({ status: "alive", timestamp: new Date().toISOString() });
});

// ==================== API INFORMATION ENDPOINTS ====================

// API info
app.get("/api/info", (req, res) => {
  res.json({
    name: "AttendX API",
    version: config.apiVersion || "1.0.0",
    latestVersion: config.apiVersion || "1.0.0",
    description: "Smart Hybrid Attendance Management System",
    baseUrl: "/api/v1",
    documentation: "/api/v1/docs",
    endpoints: {
      auth: "/api/v1/auth",
      users: "/api/v1/users",
      students: "/api/v1/students",
      lecturers: "/api/v1/lecturer",
      sessions: "/api/v1/sessions",
      checkin: "/api/v1/checkin",
      attendance: "/api/v1/attendance",
      analytics: "/api/v1/analytics",
      admin: "/api/v1/admin",
      devices: "/api/v1/devices",
      classrooms: "/api/v1/classrooms",
      courses: "/api/v1/courses",
      enrollments: "/api/v1/enrollments",
      reports: "/api/v1/reports",
      alerts: "/api/v1/alerts",
      dashboard: "/api/v1/dashboard",
      config: "/api/v1/config",
      health: "/api/v1/health",
      audit: "/api/v1/audit",
      sms: "/api/v1/sms",
    },
    versioning: {
      current: "/api/v1",
      legacy: "/api",
      changelog: "/api/v1/changelog",
    },
    status: {
      api: "operational",
      websocket: global.io ? "operational" : "disconnected",
      timestamp: new Date().toISOString(),
    },
  });
});

// Changelog endpoint
app.get("/api/v1/changelog", (req, res) => {
  res.json({
    version: config.apiVersion || "1.0.0",
    releaseDate: "2024-01-15",
    changes: [
      "Complete API restructuring with versioning",
      "Added geofencing attendance check-in",
      "SMS fallback support for check-in",
      "Push notifications for real-time updates",
      "Real-time dashboard with WebSocket",
      "Advanced analytics and reporting",
      "Multi-role support (Student/Lecturer/Admin)",
      "Device management and trust scoring",
      "Bulk import/export capabilities",
      "Audit logging for compliance",
    ],
    breakingChanges: [],
    nextVersion: "1.1.0",
    nextVersionETA: "Q2 2024",
    upcomingFeatures: [
      "Biometric authentication",
      "Offline sync support",
      "Advanced predictive analytics",
      "Integration with LMS platforms",
    ],
  });
});

// ==================== MOUNT API ROUTES ====================

// Mount routes with version prefix
app.use("/api/v1", routes);

// ==================== 404 HANDLER ====================

// Catch all undefined routes
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Cannot ${req.method} ${req.originalUrl}`,
    },
    timestamp: new Date().toISOString(),
  });
});

// ==================== ERROR HANDLING MIDDLEWARE ====================

// Global error handler (must be last)
app.use(errorHandler);

module.exports = app;
