const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const auditController = require("../controllers/audit.controller");

const router = express.Router();

// All audit routes require authentication and admin role
router.use(authenticateToken);
router.use(requireRole("admin"));

/**
 * @route   GET /api/v1/audit/actions
 * @desc    Get list of audit action types
 * @access  Private (Admin only)
 */
router.get("/actions", auditController.getAuditActions.bind(auditController));

/**
 * @route   GET /api/v1/audit/logs
 * @desc    Get audit logs with filters
 * @access  Private (Admin only)
 */
router.get(
  "/logs",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("userId").optional().isUUID(),
  query("action").optional().isString(),
  query("entity").optional().isString(),
  query("entityId").optional().isString(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("search").optional().isString(),
  query("sortBy").optional().isString(),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  auditController.getAuditLogs.bind(auditController),
);

/**
 * @route   GET /api/v1/audit/logs/:logId
 * @desc    Get audit log by ID
 * @access  Private (Admin only)
 */
router.get(
  "/logs/:logId",
  param("logId").isUUID().withMessage("Invalid log ID format"),
  validate,
  auditController.getAuditLogById.bind(auditController),
);

/**
 * @route   GET /api/v1/audit/statistics
 * @desc    Get audit statistics
 * @access  Private (Admin only)
 */
router.get(
  "/statistics",
  query("days").optional().isInt({ min: 1, max: 365 }).toInt(),
  validate,
  auditController.getAuditStatistics.bind(auditController),
);

/**
 * @route   GET /api/v1/audit/users/:userId/timeline
 * @desc    Get user activity timeline
 * @access  Private (Admin only)
 */
router.get(
  "/users/:userId/timeline",
  param("userId").isUUID().withMessage("Invalid user ID format"),
  query("days").optional().isInt({ min: 1, max: 365 }).toInt(),
  validate,
  auditController.getUserActivityTimeline.bind(auditController),
);

/**
 * @route   GET /api/v1/audit/entity/:entityType/:entityId
 * @desc    Get entity audit trail
 * @access  Private (Admin only)
 */
router.get(
  "/entity/:entityType/:entityId",
  param("entityType").isString().notEmpty(),
  param("entityId").isString().notEmpty(),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  validate,
  auditController.getEntityAuditTrail.bind(auditController),
);

/**
 * @route   GET /api/v1/audit/export
 * @desc    Export audit logs
 * @access  Private (Admin only)
 */
router.get(
  "/export",
  query("format").optional().isIn(["csv", "json"]),
  query("userId").optional().isUUID(),
  query("action").optional().isString(),
  query("entity").optional().isString(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  validate,
  auditController.exportAuditLogs.bind(auditController),
);

/**
 * @route   GET /api/v1/audit/alerts
 * @desc    Get recent security alerts
 * @access  Private (Admin only)
 */
router.get(
  "/alerts",
  query("limit").optional().isInt({ min: 1, max: 500 }).toInt(),
  validate,
  auditController.getRecentAlerts.bind(auditController),
);

/**
 * @route   DELETE /api/v1/audit/cleanup
 * @desc    Clean up old audit logs
 * @access  Private (Admin only)
 */
router.delete(
  "/cleanup",
  body("days").optional().isInt({ min: 30, max: 365 }).toInt(),
  body("confirm").notEmpty().withMessage("Confirmation required"),
  validate,
  auditController.cleanupOldLogs.bind(auditController),
);

/**
 * @route   GET /api/v1/audit/stream
 * @desc    Get WebSocket stream info
 * @access  Private (Admin only)
 */
router.get("/stream", auditController.getAuditStream.bind(auditController));

module.exports = router;
