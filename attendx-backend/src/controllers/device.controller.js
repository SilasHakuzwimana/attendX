const { validationResult } = require("express-validator");
const logger = require("../utils/logger");

class DeviceController {
  /**
   * List user's devices
   * GET /api/devices
   */
  async listDevices(req, res, next) {
    try {
      const devices = await global.prisma.device.findMany({
        where: { userId: req.user.id },
        orderBy: { registeredAt: "desc" },
      });

      res.json({ success: true, data: devices });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Register or update device
   * POST /api/devices
   */
  async registerDevice(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid input",
            fields: errors.array(),
          },
        });
      }

      const { deviceFingerprint, fcmToken, platform } = req.body;

      // Check if device belongs to another user
      const existingDevice = await global.prisma.device.findUnique({
        where: { deviceFingerprint },
      });

      if (existingDevice && existingDevice.userId !== req.user.id) {
        return res.status(409).json({
          success: false,
          error: {
            code: "DEVICE_CONFLICT",
            message: "This device is already registered to another account",
          },
        });
      }

      const device = await global.prisma.device.upsert({
        where: { deviceFingerprint },
        update: {
          fcmToken: fcmToken || existingDevice?.fcmToken,
          lastSeenAt: new Date(),
          isActive: true,
          platform: platform || existingDevice?.platform,
        },
        create: {
          deviceFingerprint,
          fcmToken,
          platform,
          userId: req.user.id,
        },
      });

      logger.info(
        `Device registered for user ${req.user.id}: ${deviceFingerprint}`,
      );

      res.json({
        success: true,
        data: {
          id: device.id,
          message: "Device registered successfully",
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Deregister device
   * DELETE /api/devices/:deviceId
   */
  async deregisterDevice(req, res, next) {
    try {
      const { deviceId } = req.params;

      const device = await global.prisma.device.findUnique({
        where: { id: deviceId },
      });

      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Device not found" },
        });
      }

      if (device.userId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "You do not own this device" },
        });
      }

      await global.prisma.device.delete({
        where: { id: deviceId },
      });

      logger.info(
        `Device deregistered for user ${req.user.id}: ${device.deviceFingerprint}`,
      );

      res.json({
        success: true,
        data: { message: "Device deregistered successfully" },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update FCM token
   * PATCH /api/devices/:deviceId/token
   */
  async updateFCMToken(req, res, next) {
    try {
      const { deviceId } = req.params;
      const { fcmToken } = req.body;

      const device = await global.prisma.device.findUnique({
        where: { id: deviceId },
      });

      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Device not found" },
        });
      }

      if (device.userId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "You do not own this device" },
        });
      }

      const updated = await global.prisma.device.update({
        where: { id: deviceId },
        data: { fcmToken, lastSeenAt: new Date() },
      });

      logger.info(`FCM token updated for device ${deviceId}`);

      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new DeviceController();
