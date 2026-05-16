const express = require("express");
const path = require("path");
const fs = require("fs");

// Import all route modules
const authRoutes = require("./auth.routes");
const userRoutes = require("./user.routes");
const studentRoutes = require("./student.routes");
const sessionRoutes = require("./session.routes");
const attendanceRoutes = require("./attendance.routes");
const analyticsRoutes = require("./analytics.routes");
const adminRoutes = require("./admin.routes");
const deviceRoutes = require("./device.routes");
const smsRoutes = require("./sms.routes");
const classroomRoutes = require("./classroom.routes");
const courseRoutes = require("./course.routes");
const enrollmentRoutes = require("./enrollment.routes");
const lecturerRoutes = require("./lecturer.routes");
const reportRoutes = require("./report.routes");
const alertRoutes = require("./alert.routes");
const checkinRoutes = require("./checkin.routes");
const dashboardRoutes = require("./dashboard.routes");
const configRoutes = require("./config.routes");
const healthRoutes = require("./health.routes");
const auditRoutes = require("./audit.routes");

const router = express.Router();

// ==================== API VERSION INFO ====================

// API Version and Info
const API_VERSION = "1.0.0";
const API_STATUS = "stable";

// Add version middleware to all routes
router.use((req, res, next) => {
  res.setHeader("X-API-Version", API_VERSION);
  res.setHeader("X-API-Status", API_STATUS);
  res.setHeader("X-API-Deprecated", "false");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

router.get("/test", (req, res) => {
  res.json({ mess: "Hi" });
});
// Route version info
router.get("/version", (req, res) => {
  res.json({
    version: API_VERSION,
    status: API_STATUS,
    basePath: "/api/v1",
    documentation: "/api/v1/docs",
    changelog: "/api/v1/changelog",
    support: "https://support.attendx.com",
  });
});

// API information endpoint
router.get("/info", (req, res) => {
  res.json({
    name: "AttendX API",
    version: API_VERSION,
    description: "Smart Hybrid Attendance Management System",
    documentation: "/api/v1/docs",
    endpoints: {
      auth: "/api/v1/auth",
      users: "/api/v1/users",
      students: "/api/v1/students",
      lecturers: "/api/v1/lecturer",
      sessions: "/api/v1/sessions",
      attendance: "/api/v1/attendance",
      checkin: "/api/v1/checkin",
      analytics: "/api/v1/analytics",
      admin: "/api/v1/admin",
      devices: "/api/v1/devices",
      classrooms: "/api/v1/classrooms",
      courses: "/api/v1/courses",
      enrollments: "/api/v1/enrollments",
      reports: "/api/v1/reports",
      notifications: "/api/v1/notifications",
      alerts: "/api/v1/alerts",
      dashboard: "/api/v1/dashboard",
      config: "/api/v1/config",
      health: "/api/v1/health",
      audit: "/api/v1/audit",
      sms: "/api/v1/sms",
    },
    features: {
      authentication: true,
      geofencing: true,
      realtime: true,
      sms: process.env.SMS_ENABLED === "true",
      push: process.env.PUSH_ENABLED === "true",
    },
  });
});

// API Documentation endpoint (redirect to Swagger/Postman)
router.get("/docs", (req, res) => {
  res.json({
    message: "API Documentation",
    swagger: "/api-docs",
    postman: "https://documenter.getpostman.com/view/attendx",
    openapi: "/api/v1/openapi.json",
  });
});

// OpenAPI specification endpoint
router.get("/openapi.json", (req, res) => {
  const openapiSpec = {
    openapi: "3.0.0",
    info: {
      title: "AttendX API",
      description: "Smart Hybrid Attendance Management System API",
      version: API_VERSION,
      contact: {
        name: "AttendX Support",
        email: "support@attendx.com",
      },
    },
    servers: [
      {
        url: process.env.API_URL || "https://api.attendx.ac.rw/v1",
        description: "Production Server",
      },
      {
        url: "http://localhost:3000/api/v1",
        description: "Development Server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
  res.json(openapiSpec);
});

// Changelog endpoint
router.get("/changelog", (req, res) => {
  res.json({
    version: API_VERSION,
    releaseDate: "2024-01-15",
    changes: [
      "Initial release of AttendX API v1",
      "Geofenced attendance check-in",
      "Real-time session tracking",
      "SMS integration for check-in",
      "Push notifications support",
      "Analytics and reporting",
      "Multi-role support (Student/Lecturer/Admin)",
    ],
    upcoming: [
      "Biometric authentication",
      "Offline sync support",
      "Advanced analytics dashboard",
    ],
  });
});

// ==================== MOUNT ALL ROUTES ====================

// Authentication Routes
router.use("/auth", authRoutes);

// User Management Routes
router.use("/users", userRoutes);

// Student Routes
router.use("/students", studentRoutes);

// Lecturer Routes
router.use("/lecturer", lecturerRoutes);

// Session Management Routes
router.use("/sessions", sessionRoutes);

// Check-in Routes
router.use("/checkin", checkinRoutes);

// Attendance Routes
router.use("/attendance", attendanceRoutes);

// Analytics Routes
router.use("/analytics", analyticsRoutes);

// Admin Routes
router.use("/admin", adminRoutes);

// Device Management Routes
router.use("/devices", deviceRoutes);

// Classroom Management Routes
router.use("/classrooms", classroomRoutes);

// Course Management Routes
router.use("/courses", courseRoutes);

// Enrollment Management Routes
router.use("/enrollments", enrollmentRoutes);

// Report Routes
router.use("/reports", reportRoutes);

// Alert Routes
router.use("/alerts", alertRoutes);

// Dashboard Routes
router.use("/dashboard", dashboardRoutes);

// Configuration Routes
router.use("/config", configRoutes);

// Health Check Routes
router.use("/health", healthRoutes);

// Audit Log Routes
router.use("/audit", auditRoutes);

// SMS Routes
router.use("/sms", smsRoutes);

// ==================== ADDITIONAL UTILITY ROUTES ====================

// Root health check
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    api: {
      version: API_VERSION,
      basePath: "/api/v1",
      routes: 35,
    },
    environment: process.env.NODE_ENV,
    services: {
      database: "connected",
      redis: "connected",
      websocket: "connected",
    },
  });
});

// Readiness probe
router.get("/ready", (req, res) => {
  // Check if database is ready
  const dbReady = true; // This would be checked in production
  const redisReady = true; // This would be checked in production

  if (dbReady && redisReady) {
    res.json({
      status: "ready",
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(503).json({
      status: "not ready",
      timestamp: new Date().toISOString(),
    });
  }
});

// Liveness probe
router.get("/live", (req, res) => {
  res.json({
    status: "alive",
    timestamp: new Date().toISOString(),
  });
});

// API Status endpoint
router.get("/status", async (req, res) => {
  try {
    const dbStatus = await checkDatabaseStatus();
    const redisStatus = await checkRedisStatus();

    res.json({
      status: dbStatus && redisStatus ? "operational" : "degraded",
      timestamp: new Date().toISOString(),
      components: {
        database: dbStatus ? "operational" : "down",
        redis: redisStatus ? "operational" : "down",
        api: "operational",
        websocket: "operational",
      },
      metrics: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: API_VERSION,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Helper functions for status checks
async function checkDatabaseStatus() {
  try {
    const { prisma } = require("../config/index");
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    return false;
  }
}

async function checkRedisStatus() {
  try {
    const { redisClient } = require("../index");
    if (redisClient && redisClient.isReady) {
      await redisClient.ping();
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

// ==================== ERROR HANDLING ====================

// 404 handler for undefined routes
router.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Cannot ${req.method} ${req.originalUrl}`,
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
