const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { authenticateToken } = require("../middleware/auth.middleware");
const deviceController = require("../controllers/device.controller");

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// =====================================================
// DEVICE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/devices
 * @desc    List user's devices with detailed information
 * @access  Private
 */
router.get("/", deviceController.listDevices.bind(deviceController));

/**
 * @route   POST /api/v1/devices
 * @desc    Register or update device
 * @access  Private
 */
router.post(
  "/",
  body("deviceFingerprint")
    .notEmpty()
    .withMessage("Device fingerprint is required")
    .isString(),
  body("platform")
    .optional()
    .isIn(["android", "ios", "web"])
    .withMessage("Valid platform is required"),
  body("fcmToken").optional().isString(),
  body("deviceName").optional().isString().trim(),
  body("deviceModel").optional().isString(),
  body("osVersion").optional().isString(),
  body("appVersion").optional().isString(),
  validate,
  deviceController.registerDevice.bind(deviceController),
);

/**
 * @route   GET /api/v1/devices/:deviceId
 * @desc    Get device details by ID
 * @access  Private
 */
router.get(
  "/:deviceId",
  param("deviceId").isUUID().withMessage("Invalid device ID format"),
  validate,
  deviceController.getDevice.bind(deviceController),
);

/**
 * @route   PATCH /api/v1/devices/:deviceId/trust
 * @desc    Update device trust status
 * @access  Private
 */
router.patch(
  "/:deviceId/trust",
  param("deviceId").isUUID().withMessage("Invalid device ID format"),
  body("isTrusted").isBoolean().withMessage("isTrusted must be a boolean"),
  validate,
  deviceController.updateDeviceTrust.bind(deviceController),
);

/**
 * @route   PUT /api/v1/devices/:deviceId/fcm-token
 * @desc    Update FCM token for device
 * @access  Private
 */
router.put(
  "/:deviceId/fcm-token",
  param("deviceId").isUUID().withMessage("Invalid device ID format"),
  body("fcmToken").notEmpty().withMessage("FCM token is required"),
  validate,
  deviceController.updateFCMToken.bind(deviceController),
);

/**
 * @route   DELETE /api/v1/devices/:deviceId
 * @desc    Deregister/Revoke device
 * @access  Private
 */
router.delete(
  "/:deviceId",
  param("deviceId").isUUID().withMessage("Invalid device ID format"),
  validate,
  deviceController.deregisterDevice.bind(deviceController),
);

// =====================================================
// BULK DEVICE OPERATIONS
// =====================================================

/**
 * @route   POST /api/v1/devices/revoke-all
 * @desc    Revoke all other devices (logout from all other devices)
 * @access  Private
 */
router.post(
  "/revoke-all",
  body("deviceFingerprint").optional().isString(),
  body("deactivateDevices").optional().isBoolean(),
  validate,
  deviceController.revokeAllOtherDevices.bind(deviceController),
);

/**
 * @route   POST /api/v1/devices/unregister-all
 * @desc    Unregister all devices for current user
 * @access  Private
 */
router.post("/unregister-all", async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get all devices
    const devices = await prisma.device.findMany({
      where: { userId, isActive: true },
      select: { deviceFingerprint: true },
    });

    // Revoke all refresh tokens
    for (const device of devices) {
      await prisma.refreshToken.updateMany({
        where: {
          userId,
          deviceFingerprint: device.deviceFingerprint,
          revoked: false,
        },
        data: { revoked: true },
      });

      // Clear Redis sessions
      if (redisClient && redisClient.isReady) {
        const keys = await redisClient.keys(
          `refresh:${userId}:${device.deviceFingerprint}`,
        );
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
      }
    }

    // Deactivate all devices
    await prisma.device.updateMany({
      where: { userId },
      data: { isActive: false },
    });

    // Invalidate cache
    if (redisClient && redisClient.isReady) {
      await redisClient.del(`user:devices:${userId}`);
    }

    // Create audit log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "UNREGISTER_ALL_DEVICES",
        entity: "Device",
        newValues: { devicesCount: devices.length },
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      },
    });

    logger.info(
      `All devices unregistered for user ${userId}: ${devices.length} devices`,
    );

    res.json({
      success: true,
      data: {
        message: `All devices unregistered successfully. ${devices.length} devices affected.`,
        devicesCount: devices.length,
      },
    });
  } catch (error) {
    logger.error("Unregister all devices error:", error);
    next(error);
  }
});

// =====================================================
// DEVICE VERIFICATION & VALIDATION
// =====================================================

/**
 * @route   POST /api/v1/devices/verify
 * @desc    Verify device fingerprint
 * @access  Private
 */
router.post(
  "/verify",
  body("deviceFingerprint")
    .notEmpty()
    .withMessage("Device fingerprint is required"),
  validate,
  async (req, res, next) => {
    try {
      const { deviceFingerprint } = req.body;
      const userId = req.user.id;

      const device = await prisma.device.findFirst({
        where: {
          deviceFingerprint,
          userId,
          isActive: true,
        },
        select: {
          id: true,
          deviceName: true,
          isTrusted: true,
          lastSeenAt: true,
        },
      });

      const isValid = !!device;

      if (isValid) {
        // Update last seen
        await prisma.device.update({
          where: { id: device.id },
          data: { lastSeenAt: new Date() },
        });
      }

      res.json({
        success: true,
        data: {
          isValid,
          deviceId: device?.id,
          deviceName: device?.deviceName,
          isTrusted: device?.isTrusted,
          message: isValid
            ? "Device verified successfully"
            : "Device not recognized",
        },
      });
    } catch (error) {
      logger.error("Verify device error:", error);
      next(error);
    }
  },
);

/**
 * @route   GET /api/v1/devices/active-sessions
 * @desc    Get active sessions for current device/user
 * @access  Private
 */
router.get(
  "/active-sessions",
  query("deviceFingerprint").optional().isString(),
  validate,
  deviceController.getActiveSessions.bind(deviceController),
);

/**
 * @route   GET /api/v1/devices/generate-fingerprint
 * @desc    Generate device fingerprint helper (for client use)
 * @access  Private
 */
router.get(
  "/generate-fingerprint",
  deviceController.generateFingerprint.bind(deviceController),
);

// =====================================================
// DEVICE STATISTICS
// =====================================================

/**
 * @route   GET /api/v1/devices/statistics
 * @desc    Get device statistics for current user
 * @access  Private
 */
router.get("/statistics", async (req, res, next) => {
  try {
    const userId = req.user.id;

    const [totalDevices, activeDevices, trustedDevices, totalSessions] =
      await Promise.all([
        prisma.device.count({ where: { userId } }),
        prisma.device.count({ where: { userId, isActive: true } }),
        prisma.device.count({
          where: { userId, isActive: true, isTrusted: true },
        }),
        prisma.refreshToken.count({
          where: {
            userId,
            revoked: false,
            expiresAt: { gt: new Date() },
          },
        }),
      ]);

    // Get last used device
    const lastUsedDevice = await prisma.device.findFirst({
      where: { userId, isActive: true },
      orderBy: { lastSeenAt: "desc" },
      select: {
        deviceName: true,
        platform: true,
        lastSeenAt: true,
      },
    });

    res.json({
      success: true,
      data: {
        totalDevices,
        activeDevices,
        trustedDevices,
        activeSessions: totalSessions,
        lastUsedDevice,
        deviceLimit: 5,
      },
    });
  } catch (error) {
    logger.error("Get device statistics error:", error);
    next(error);
  }
});

// =====================================================
// DEVICE WEBHOOK (for push notification status)
// =====================================================

/**
 * @route   POST /api/v1/devices/webhook/fcm-status
 * @desc    Receive FCM token status updates
 * @access  Private
 */
router.post(
  "/webhook/fcm-status",
  body("deviceId").isUUID().withMessage("Invalid device ID"),
  body("status").isIn(["active", "expired", "invalid"]),
  body("error").optional().isString(),
  validate,
  async (req, res, next) => {
    try {
      const { deviceId, status, error } = req.body;

      if (status === "invalid" || status === "expired") {
        // Clear invalid FCM token
        await prisma.device.update({
          where: { id: deviceId, userId: req.user.id },
          data: { fcmToken: null },
        });

        logger.warn(
          `FCM token invalidated for device ${deviceId}: ${error || status}`,
        );
      }

      res.json({
        success: true,
        data: { message: "FCM status updated" },
      });
    } catch (error) {
      logger.error("FCM webhook error:", error);
      next(error);
    }
  },
);

module.exports = router;
