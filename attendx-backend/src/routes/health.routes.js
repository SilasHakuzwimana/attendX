const express = require("express");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const healthController = require("../controllers/health.controller");

const router = express.Router();

// Initialize health monitoring
healthController.initialize();

// ==================== PUBLIC HEALTH ENDPOINTS ====================

/**
 * @route   GET /api/v1/health
 * @desc    Comprehensive health check
 * @access  Public
 */
router.get("/", healthController.getHealth.bind(healthController));

/**
 * @route   GET /api/v1/health/live
 * @desc    Liveness probe for Kubernetes/container orchestration
 * @access  Public
 */
router.get("/live", healthController.livenessProbe.bind(healthController));

/**
 * @route   GET /api/v1/health/ready
 * @desc    Readiness probe for Kubernetes/container orchestration
 * @access  Public
 */
router.get("/ready", healthController.readinessProbe.bind(healthController));

/**
 * @route   GET /api/v1/health/dependencies
 * @desc    Get service dependencies status
 * @access  Public
 */
router.get(
  "/dependencies",
  healthController.getDependenciesStatus.bind(healthController),
);

// ==================== PROTECTED HEALTH ENDPOINTS ====================

// Routes below require authentication and admin role
router.use(authenticateToken);
router.use(requireRole("admin"));

/**
 * @route   GET /api/v1/health/metrics
 * @desc    Get detailed system metrics (Admin only)
 * @access  Private (Admin only)
 */
router.get("/metrics", healthController.getMetrics.bind(healthController));

/**
 * @route   GET /api/v1/health/history
 * @desc    Get health check history (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/history",
  healthController.getHealthHistory.bind(healthController),
);

module.exports = router;
