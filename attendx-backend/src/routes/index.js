const express = require("express");
const authRoutes = require("./auth.routes");
const userRoutes = require("./user.routes");
const studentRoutes = require("./student.routes");
const sessionRoutes = require("./session.routes");
const attendanceRoutes = require("./attendance.routes");
const analyticsRoutes = require("./analytics.routes");
const adminRoutes = require("./admin.routes");
const deviceRoutes = require("./device.routes");
const smsRoutes = require("./sms.routes");
const router = express.Router();

// Add version middleware to all routes
router.use((req, res, next) => {
  // Detect version from URL path
  const version = req.baseUrl.includes("/v1") ? "1.0" : "1.0";
  res.setHeader("X-API-Version", version);
  res.setHeader("X-API-Deprecated", "false");
  next();
});

// Route version info
router.get("/version", (req, res) => {
  res.json({
    version: "1.0.0",
    status: "stable",
    basePath: "/api/v1",
    documentation: "/api/info",
    changelog: "/api/v1/changelog",
  });
});

// API version info
router.get("/info", (req, res) => {
  res.json({
    name: "AttendX API",
    version: "1.0.0",
    description: "Smart Hybrid Attendance Management System",
    endpoints: {
      auth: "/api/v1/auth",
      users: "/api/v1/users",
      students: "/api/v1/students",
      sessions: "/api/v1/sessions",
      attendance: "/api/v1/attendance",
      analytics: "/api/v1/analytics",
      admin: "/api/v1/admin",
      devices: "/api/v1/devices",
      sms: "/api/v1/sms",
    },
  });
});

// Mount routes
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/students", studentRoutes);
router.use("/sessions", sessionRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/admin", adminRoutes);
router.use("/devices", deviceRoutes);
router.use("/sms", smsRoutes);

// Health check route (no authentication)
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    api: {
      version: "1.0",
      basePath: req.baseUrl,
    },
    environment: process.env.NODE_ENV,
  });
});

module.exports = router;
