const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const configController = require("../controllers/config.controller");

const router = express.Router();

// ==================== PUBLIC ROUTES (No Auth Required) ====================

/**
 * @route   GET /api/v1/config/public
 * @desc    Get public configuration (non-sensitive)
 * @access  Public
 */
router.get("/public", configController.getPublicConfig.bind(configController));

/**
 * @route   GET /api/v1/config/features
 * @desc    Get feature flags
 * @access  Public
 */
router.get(
  "/features",
  configController.getFeatureFlags.bind(configController),
);

// ==================== PROTECTED ROUTES (Admin Only) ====================

// All routes below require authentication and admin role
router.use(authenticateToken);
router.use(requireRole("admin"));

/**
 * @route   GET /api/v1/config
 * @desc    Get full system configuration
 * @access  Private (Admin only)
 */
router.get("/", configController.getConfig.bind(configController));

/**
 * @route   PUT /api/v1/config
 * @desc    Update system configuration
 * @access  Private (Admin only)
 */
router.put(
  "/",
  body("defaultGeofenceRadiusM").optional().isInt({ min: 10, max: 500 }),
  body("sessionCodeTtlMinutes").optional().isInt({ min: 15, max: 240 }),
  body("consecutiveAbsenceWarningThreshold")
    .optional()
    .isInt({ min: 1, max: 10 }),
  body("smsEnabled").optional().isBoolean(),
  body("emailNotificationsEnabled").optional().isBoolean(),
  body("pushNotificationsEnabled").optional().isBoolean(),
  body("maxDevicesPerUser").optional().isInt({ min: 1, max: 20 }),
  body("sessionGracePeriodMinutes").optional().isInt({ min: 0, max: 60 }),
  body("sessionReminderMinutes").optional().isArray(),
  body("sessionReminderMinutes.*").optional().isInt(),
  body("maxLoginAttempts").optional().isInt({ min: 3, max: 10 }),
  body("passwordExpiryDays").optional().isInt({ min: 30, max: 365 }),
  body("mfaRequired").optional().isBoolean(),
  body("allowSelfRegistration").optional().isBoolean(),
  body("requireEmailVerification").optional().isBoolean(),
  body("maintenanceMode").optional().isBoolean(),
  body("maintenanceMessage").optional().isString(),
  body("systemName").optional().isString(),
  body("systemEmail").optional().isEmail(),
  body("systemPhone").optional().isString(),
  body("timezone").optional().isString(),
  validate,
  configController.updateConfig.bind(configController),
);

/**
 * @route   POST /api/v1/config/reset
 * @desc    Reset configuration to defaults
 * @access  Private (Admin only)
 */
router.post(
  "/reset",
  body("confirm").notEmpty().withMessage("Confirmation required"),
  validate,
  configController.resetConfig.bind(configController),
);

/**
 * @route   POST /api/v1/config/maintenance
 * @desc    Toggle maintenance mode
 * @access  Private (Admin only)
 */
router.post(
  "/maintenance",
  body("enabled").optional().isBoolean(),
  body("message").optional().isString(),
  validate,
  configController.toggleMaintenanceMode.bind(configController),
);

/**
 * @route   GET /api/v1/config/history
 * @desc    Get configuration change history
 * @access  Private (Admin only)
 */
router.get(
  "/history",
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  validate,
  configController.getConfigHistory.bind(configController),
);

/**
 * @route   POST /api/v1/config/validate
 * @desc    Validate configuration before applying
 * @access  Private (Admin only)
 */
router.post(
  "/validate",
  configController.validateConfig.bind(configController),
);

module.exports = router;
