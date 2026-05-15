const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const crypto = require("crypto");

class DeviceController {
  /**
   * List user's devices with detailed information
   * GET /api/v1/devices
   */
  async listDevices(req, res, next) {
    try {
      const userId = req.user.id;
      const cacheKey = `user:devices:${userId}`;

      // Check cache
      let cachedData = null;
      if (redisClient && redisClient.isReady) {
        cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json({
            success: true,
            data: JSON.parse(cachedData),
            meta: { cached: true },
          });
        }
      }

      const devices = await prisma.device.findMany({
        where: { userId, isActive: true },
        orderBy: { lastSeenAt: "desc" },
        select: {
          id: true,
          deviceName: true,
          deviceFingerprint: true,
          platform: true,
          deviceModel: true,
          osVersion: true,
          appVersion: true,
          isActive: true,
          isTrusted: true,
          lastSeenAt: true,
          registeredAt: true,
          fcmToken: true,
        },
      });

      // Get active session count for each device
      const devicesWithSessions = await Promise.all(
        devices.map(async (device) => {
          const activeSessions = await prisma.refreshToken.count({
            where: {
              userId,
              deviceFingerprint: device.deviceFingerprint,
              revoked: false,
              expiresAt: { gt: new Date() },
            },
          });

          return {
            ...device,
            activeSessions,
            hasFCM: !!device.fcmToken,
          };
        }),
      );

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(
          cacheKey,
          120,
          JSON.stringify(devicesWithSessions),
        );
      }

      res.json({
        success: true,
        data: devicesWithSessions,
        meta: {
          total: devicesWithSessions.length,
          message:
            devicesWithSessions.length === 0 ? "No devices registered" : null,
        },
      });
    } catch (error) {
      logger.error("List devices error:", error);
      next(error);
    }
  }

  /**
   * Register or update device
   * POST /api/v1/devices
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
            details: errors.array(),
          },
        });
      }

      const {
        deviceFingerprint,
        fcmToken,
        platform,
        deviceName,
        deviceModel,
        osVersion,
        appVersion,
      } = req.body;

      const userId = req.user.id;

      // Validate device fingerprint
      if (!deviceFingerprint) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Device fingerprint is required",
          },
        });
      }

      // Check if device belongs to another user
      const existingDevice = await prisma.device.findUnique({
        where: { deviceFingerprint },
      });

      if (existingDevice && existingDevice.userId !== userId) {
        // Log security incident
        logger.warn(
          `Device fingerprint collision attempt: ${deviceFingerprint} for user ${userId}`,
        );

        return res.status(409).json({
          success: false,
          error: {
            code: "DEVICE_CONFLICT",
            message: "This device is already registered to another account",
          },
        });
      }

      // Check device limit per user
      const deviceCount = await prisma.device.count({
        where: { userId, isActive: true },
      });

      const maxDevices = 5; // Should be from system config
      if (!existingDevice && deviceCount >= maxDevices) {
        return res.status(400).json({
          success: false,
          error: {
            code: "DEVICE_LIMIT_EXCEEDED",
            message: `Maximum ${maxDevices} devices allowed. Please remove an existing device first.`,
          },
        });
      }

      // Register or update device
      const device = await prisma.device.upsert({
        where: { deviceFingerprint },
        update: {
          fcmToken: fcmToken || existingDevice?.fcmToken,
          lastSeenAt: new Date(),
          isActive: true,
          platform: platform || existingDevice?.platform,
          deviceName: deviceName || existingDevice?.deviceName,
          deviceModel: deviceModel || existingDevice?.deviceModel,
          osVersion: osVersion || existingDevice?.osVersion,
          appVersion: appVersion || existingDevice?.appVersion,
        },
        create: {
          deviceFingerprint,
          fcmToken,
          platform: platform || "web",
          userId,
          deviceName: deviceName || "Unknown Device",
          deviceModel,
          osVersion,
          appVersion,
          isActive: true,
          isTrusted: true,
        },
      });

      // Invalidate device cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:devices:${userId}`);
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "REGISTER_DEVICE",
          entity: "Device",
          entityId: device.id,
          newValues: {
            deviceName: device.deviceName,
            platform: device.platform,
            fingerprint: device.deviceFingerprint.substring(0, 10) + "...",
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Device registered for user ${req.user.id}: ${deviceName || deviceFingerprint}`,
      );

      res.json({
        success: true,
        data: {
          id: device.id,
          deviceName: device.deviceName,
          platform: device.platform,
          message: "Device registered successfully",
        },
      });
    } catch (error) {
      logger.error("Register device error:", error);
      next(error);
    }
  }

  /**
   * Get device details by ID
   * GET /api/v1/devices/:deviceId
   */
  async getDevice(req, res, next) {
    try {
      const { deviceId } = req.params;
      const userId = req.user.id;

      const device = await prisma.device.findFirst({
        where: {
          id: deviceId,
          userId,
        },
        select: {
          id: true,
          deviceName: true,
          deviceFingerprint: true,
          platform: true,
          deviceModel: true,
          osVersion: true,
          appVersion: true,
          isActive: true,
          isTrusted: true,
          lastSeenAt: true,
          registeredAt: true,
          fcmToken: true,
        },
      });

      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Device not found" },
        });
      }

      // Get session information for this device
      const activeSessions = await prisma.refreshToken.findMany({
        where: {
          userId,
          deviceFingerprint: device.deviceFingerprint,
          revoked: false,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          expiresAt: true,
          createdAt: true,
        },
      });

      const deviceWithSessions = {
        ...device,
        activeSessions: activeSessions.length,
        sessions: activeSessions.map((s) => ({
          expiresAt: s.expiresAt,
          createdAt: s.createdAt,
        })),
      };

      res.json({ success: true, data: deviceWithSessions });
    } catch (error) {
      logger.error("Get device error:", error);
      next(error);
    }
  }

  /**
   * Update device trust status
   * PATCH /api/v1/devices/:deviceId/trust
   */
  async updateDeviceTrust(req, res, next) {
    try {
      const { deviceId } = req.params;
      const { isTrusted } = req.body;
      const userId = req.user.id;

      const device = await prisma.device.findFirst({
        where: { id: deviceId, userId },
      });

      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Device not found" },
        });
      }

      const updated = await prisma.device.update({
        where: { id: deviceId },
        data: {
          isTrusted: isTrusted !== undefined ? isTrusted : device.isTrusted,
        },
        select: {
          id: true,
          deviceName: true,
          isTrusted: true,
          platform: true,
        },
      });

      // If device is marked as untrusted, revoke all its sessions
      if (isTrusted === false) {
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

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:devices:${userId}`);
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_DEVICE_TRUST",
          entity: "Device",
          entityId: deviceId,
          oldValues: { isTrusted: device.isTrusted },
          newValues: { isTrusted },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Device trust updated for user ${userId}: ${device.deviceName} -> isTrusted=${isTrusted}`,
      );

      res.json({
        success: true,
        data: updated,
        message: isTrusted
          ? "Device marked as trusted"
          : "Device marked as untrusted and all sessions revoked",
      });
    } catch (error) {
      logger.error("Update device trust error:", error);
      next(error);
    }
  }

  /**
   * Update FCM token for device
   * PUT /api/v1/devices/:deviceId/fcm-token
   */
  async updateFCMToken(req, res, next) {
    try {
      const { deviceId } = req.params;
      const { fcmToken } = req.body;

      if (!fcmToken) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "FCM token is required" },
        });
      }

      const device = await prisma.device.findFirst({
        where: { id: deviceId, userId: req.user.id },
        select: { id: true, deviceName: true, deviceFingerprint: true },
      });

      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Device not found" },
        });
      }

      const updated = await prisma.device.update({
        where: { id: deviceId },
        data: {
          fcmToken,
          lastSeenAt: new Date(),
          isActive: true,
        },
        select: {
          id: true,
          deviceName: true,
          platform: true,
          fcmToken: true,
          lastSeenAt: true,
        },
      });

      // Invalidate device cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:devices:${req.user.id}`);
      }

      logger.info(`FCM token updated for device ${device.deviceName}`);

      res.json({
        success: true,
        data: updated,
        message: "FCM token updated successfully",
      });
    } catch (error) {
      logger.error("Update FCM token error:", error);
      next(error);
    }
  }

  /**
   * Deregister/Revoke device
   * DELETE /api/v1/devices/:deviceId
   */
  async deregisterDevice(req, res, next) {
    try {
      const { deviceId } = req.params;
      const userId = req.user.id;

      const device = await prisma.device.findFirst({
        where: { id: deviceId, userId },
        select: {
          id: true,
          deviceName: true,
          deviceFingerprint: true,
          isActive: true,
        },
      });

      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Device not found" },
        });
      }

      // Soft delete - deactivate device
      await prisma.device.update({
        where: { id: deviceId },
        data: { isActive: false },
      });

      // Revoke all refresh tokens for this device
      await prisma.refreshToken.updateMany({
        where: {
          userId,
          deviceFingerprint: device.deviceFingerprint,
          revoked: false,
        },
        data: { revoked: true },
      });

      // Clear Redis sessions for this device
      if (redisClient && redisClient.isReady) {
        const keys = await redisClient.keys(
          `refresh:${userId}:${device.deviceFingerprint}`,
        );
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
        await redisClient.del(`user:devices:${userId}`);
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "DEREGISTER_DEVICE",
          entity: "Device",
          entityId: deviceId,
          oldValues: {
            deviceName: device.deviceName,
            fingerprint: device.deviceFingerprint.substring(0, 10) + "...",
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Device deregistered for user ${userId}: ${device.deviceName}`,
      );

      res.json({
        success: true,
        data: {
          message:
            "Device deregistered successfully. You will be logged out from this device.",
          deviceId: device.id,
          deviceName: device.deviceName,
        },
      });
    } catch (error) {
      logger.error("Deregister device error:", error);
      next(error);
    }
  }

  /**
   * Revoke all other devices (logout from all other devices)
   * POST /api/v1/devices/revoke-all
   */
  async revokeAllOtherDevices(req, res, next) {
    try {
      const userId = req.user.id;
      const currentDeviceFingerprint =
        req.body.deviceFingerprint || req.deviceFingerprint;

      if (!currentDeviceFingerprint) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Current device fingerprint required",
          },
        });
      }

      // Get all devices except current
      const devices = await prisma.device.findMany({
        where: {
          userId,
          isActive: true,
          deviceFingerprint: { not: currentDeviceFingerprint },
        },
        select: { deviceFingerprint: true, deviceName: true },
      });

      // Revoke all tokens for other devices
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

      // Optionally deactivate other devices
      const deactivateDevices = req.body.deactivateDevices === true;
      if (deactivateDevices) {
        await prisma.device.updateMany({
          where: {
            userId,
            deviceFingerprint: { not: currentDeviceFingerprint },
            isActive: true,
          },
          data: { isActive: false },
        });
      }

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:devices:${userId}`);
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "REVOKE_ALL_DEVICES",
          entity: "Device",
          newValues: {
            devicesRevoked: devices.length,
            devicesDeactivated: deactivateDevices ? devices.length : 0,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Revoked all other devices for user ${userId}: ${devices.length} devices affected`,
      );

      res.json({
        success: true,
        data: {
          message: deactivateDevices
            ? `Logged out from ${devices.length} other device(s). They have been deactivated.`
            : `Logged out from ${devices.length} other device(s).`,
          devicesRevoked: devices.length,
          devicesDeactivated: deactivateDevices ? devices.length : 0,
        },
      });
    } catch (error) {
      logger.error("Revoke all devices error:", error);
      next(error);
    }
  }

  /**
   * Get active sessions for current device
   * GET /api/v1/devices/active-sessions
   */
  async getActiveSessions(req, res, next) {
    try {
      const userId = req.user.id;
      const deviceFingerprint =
        req.deviceFingerprint || req.query.deviceFingerprint;

      const where = { userId, revoked: false, expiresAt: { gt: new Date() } };
      if (deviceFingerprint) {
        where.deviceFingerprint = deviceFingerprint;
      }

      const sessions = await prisma.refreshToken.findMany({
        where,
        select: {
          id: true,
          deviceFingerprint: true,
          expiresAt: true,
          createdAt: true,
          device: {
            select: {
              deviceName: true,
              platform: true,
              deviceModel: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json({
        success: true,
        data: sessions,
        meta: {
          total: sessions.length,
          message: sessions.length === 0 ? "No active sessions found" : null,
        },
      });
    } catch (error) {
      logger.error("Get active sessions error:", error);
      next(error);
    }
  }

  /**
   * Generate device fingerprint helper (for client use)
   * GET /api/v1/devices/generate-fingerprint
   */
  async generateFingerprint(req, res, next) {
    try {
      // This endpoint provides a method to generate a unique device fingerprint
      // The client should combine: platform + userAgent + screenResolution + timezone + language
      const fingerprint = crypto.randomBytes(32).toString("hex");

      res.json({
        success: true,
        data: {
          fingerprint,
          method: "SHA-256",
          message: "Use this fingerprint for device registration",
        },
      });
    } catch (error) {
      logger.error("Generate fingerprint error:", error);
      next(error);
    }
  }
}

module.exports = new DeviceController();
