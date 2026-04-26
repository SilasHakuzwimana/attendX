const express = require("express");
const { body, param } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { authenticateToken } = require("../middleware/auth.middleware");
const deviceController = require("../controllers/device.controller");

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * @route   GET /api/devices
 * @desc    List user's devices
 * @access  Private
 */
router.get("/", deviceController.listDevices);

/**
 * @route   POST /api/devices
 * @desc    Register or update device
 * @access  Private
 */
router.post(
  "/",
  body("deviceFingerprint")
    .notEmpty()
    .withMessage("Device fingerprint is required"),
  body("platform")
    .isIn(["android", "ios", "web"])
    .withMessage("Valid platform is required"),
  body("fcmToken").optional().isString(),
  validate,
  deviceController.registerDevice,
);

/**
 * @route   DELETE /api/devices/:deviceId
 * @desc    Deregister device
 * @access  Private
 */
router.delete(
  "/:deviceId",
  param("deviceId").isUUID(),
  validate,
  deviceController.deregisterDevice,
);

/**
 * @route   PATCH /api/devices/:deviceId/token
 * @desc    Update FCM token
 * @access  Private
 */
router.patch(
  "/:deviceId/token",
  param("deviceId").isUUID(),
  body("fcmToken").notEmpty().withMessage("FCM token is required"),
  validate,
  deviceController.updateFCMToken,
);

/**
 * @route   POST /api/devices/verify
 * @desc    Verify device fingerprint
 * @access  Private
 */
router.post(
  "/verify",
  body("deviceFingerprint").notEmpty(),
  validate,
  async (req, res, next) => {
    try {
      const { deviceFingerprint } = req.body;

      const device = await global.prisma.device.findUnique({
        where: { deviceFingerprint },
      });

      const isValid =
        device && device.userId === req.user.id && device.isActive;

      res.json({
        success: true,
        data: {
          isValid,
          deviceId: device?.id,
          message: isValid ? "Device verified" : "Device not recognized",
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   POST /api/devices/unregister-all
 * @desc    Unregister all devices for current user
 * @access  Private
 */
router.post("/unregister-all", async (req, res, next) => {
  try {
    await global.prisma.device.updateMany({
      where: { userId: req.user.id },
      data: { isActive: false },
    });

    res.json({
      success: true,
      data: { message: "All devices unregistered successfully" },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
