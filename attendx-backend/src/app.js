const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const config = require("./config");
const { generalLimiter } = require("./middleware/rateLimit.middleware");
const { errorHandler } = require("./middleware/error.middleware");
const { versionMiddleware } = require("./middleware/version.middleware");

// Import routes
const routes = require("./routes");

const app = express();

// Middleware
app.use(helmet());
app.use(cookieParser());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: config.cors.origins, credentials: true }));

// Rate limiting
app.use("/api/", generalLimiter);

// Version middleware - adds version info to response
app.use((req, res, next) => {
  res.setHeader("X-API-Version", "1.0");
  res.setHeader("X-API-Latest-Version", "1.0");
  next();
});

// Routes
app.use("/api", routes);
// Routes
app.use("/api/v1", routes);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    apiVersion: "1.0",
  });
});

app.get("/api/info", (req, res) => {
  res.json({
    name: "AttendX API",
    version: "1.0.0",
    latestVersion: "1.0.0",
    description: "Smart Hybrid Attendance Management System",
    baseUrl: "/api/v1",
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
    versioning: {
      current: "/api/v1",
      legacy: "/api",
      changelog: "/api/v1/changelog",
    },
  });
});

// Version changelog endpoint
app.get("/api/v1/changelog", (req, res) => {
  res.json({
    version: "1.0.0",
    releaseDate: "2024-01-01",
    changes: [
      "Initial release",
      "Geofencing attendance",
      "SMS fallback support",
      "Push notifications",
      "Real-time dashboard",
    ],
    breakingChanges: [],
    nextVersion: "1.1.0",
    nextVersionETA: "Q3 2024",
  });
});

// Version middleware
app.use(versionMiddleware);

// Error handling
app.use(errorHandler);

module.exports = app;
