const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../config/index");
const bcrypt = require("bcryptjs");

class UserController {
  /**
   * Get own profile with detailed information
   * GET /api/v1/users/me
   */
  async getProfile(req, res, next) {
    try {
      const userId = req.user.id;
      const cacheKey = `user:profile:${userId}`;

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

      const user = await prisma.user.findUnique({
        where: { id: userId, isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          staffNumber: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          notificationPref: true,
          devices: {
            where: { isActive: true },
            select: {
              id: true,
              deviceName: true,
              platform: true,
              lastSeenAt: true,
              isTrusted: true,
            },
            take: 5,
          },
          _count: {
            select: {
              enrollments: {
                where: { isActive: true },
              },
              taughtCourses: {
                where: { isActive: true },
              },
              attendanceRecords: true,
            },
          },
        },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      // Calculate additional stats based on role
      let roleSpecificData = {};

      if (user.role === "student") {
        const attendanceStats = await prisma.attendanceRecord.aggregate({
          where: { studentId: userId },
          _count: true,
          _sum: { distanceM: true },
        });

        const presentCount = await prisma.attendanceRecord.count({
          where: {
            studentId: userId,
            status: { in: ["present", "late"] },
          },
        });

        roleSpecificData = {
          totalAttendance: attendanceStats._count,
          presentCount,
          attendanceRate:
            attendanceStats._count > 0
              ? parseFloat(
                  ((presentCount / attendanceStats._count) * 100).toFixed(1),
                )
              : 0,
          enrolledCoursesCount: user._count.enrollments,
        };
      } else if (user.role === "lecturer") {
        const sessionsCount = await prisma.session.count({
          where: { lecturerId: userId },
        });

        roleSpecificData = {
          totalSessions: sessionsCount,
          taughtCoursesCount: user._count.taughtCourses,
          totalStudents: await prisma.enrollment.count({
            where: {
              course: { lecturerId: userId },
              isActive: true,
            },
          }),
        };
      }

      const profileData = {
        ...user,
        roleSpecificData,
        devices: user.devices,
        stats: user._count,
      };

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(profileData));
      }

      res.json({ success: true, data: profileData });
    } catch (error) {
      logger.error("Get profile error:", error);
      next(error);
    }
  }

  /**
   * Update own profile
   * PATCH /api/v1/users/me
   */
  async updateProfile(req, res, next) {
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

      const { fullName, phone } = req.body;
      const userId = req.user.id;

      // Check if phone is already used by another user
      if (phone) {
        const existingUser = await prisma.user.findFirst({
          where: {
            phone,
            id: { not: userId },
          },
        });

        if (existingUser) {
          return res.status(409).json({
            success: false,
            error: {
              code: "CONFLICT",
              message: "Phone number already in use by another account",
            },
          });
        }
      }

      // Get old values for audit
      const oldUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, phone: true },
      });

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          ...(fullName && { fullName }),
          ...(phone && { phone }),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          staffNumber: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:profile:${userId}`);
        await redisClient.del(`student:dashboard:${userId}`);
        await redisClient.del(`student:summary:${userId}`);
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_PROFILE",
          entity: "User",
          entityId: userId,
          oldValues: { fullName: oldUser?.fullName, phone: oldUser?.phone },
          newValues: { fullName, phone },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Profile updated for user: ${user.email}`);

      res.json({
        success: true,
        data: user,
        message: "Profile updated successfully",
      });
    } catch (error) {
      logger.error("Update profile error:", error);
      next(error);
    }
  }

  /**
   * Get notification preferences
   * GET /api/v1/users/me/notification-preferences
   */
  async getNotificationPreferences(req, res, next) {
    try {
      const userId = req.user.id;
      const cacheKey = `user:notifications:${userId}`;

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

      let preferences = await prisma.notificationPreference.findUnique({
        where: { userId },
      });

      if (!preferences) {
        // Create default preferences if not exists
        preferences = await prisma.notificationPreference.create({
          data: {
            userId,
            emailNotifications: true,
            pushNotifications: true,
            smsNotifications: false,
            sessionReminders: true,
            attendanceReports: false,
            sessionStarted: true,
            sessionClosed: false,
            attendanceConfirmation: true,
            missedAttendance: true,
            absenceWarning: true,
            weeklyDigest: false,
          },
        });
      }

      // Cache for 10 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 600, JSON.stringify(preferences));
      }

      res.json({ success: true, data: preferences });
    } catch (error) {
      logger.error("Get notification preferences error:", error);
      next(error);
    }
  }

  /**
   * Update notification preferences
   * PUT /api/v1/users/me/notification-preferences
   */
  async updateNotificationPreferences(req, res, next) {
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
        emailNotifications,
        pushNotifications,
        smsNotifications,
        sessionReminders,
        attendanceReports,
        sessionStarted,
        sessionClosed,
        attendanceConfirmation,
        missedAttendance,
        absenceWarning,
        weeklyDigest,
      } = req.body;

      const userId = req.user.id;

      // Get old values for audit
      const oldPreferences = await prisma.notificationPreference.findUnique({
        where: { userId },
      });

      const preferences = await prisma.notificationPreference.upsert({
        where: { userId },
        update: {
          ...(emailNotifications !== undefined && { emailNotifications }),
          ...(pushNotifications !== undefined && { pushNotifications }),
          ...(smsNotifications !== undefined && { smsNotifications }),
          ...(sessionReminders !== undefined && { sessionReminders }),
          ...(attendanceReports !== undefined && { attendanceReports }),
          ...(sessionStarted !== undefined && { sessionStarted }),
          ...(sessionClosed !== undefined && { sessionClosed }),
          ...(attendanceConfirmation !== undefined && {
            attendanceConfirmation,
          }),
          ...(missedAttendance !== undefined && { missedAttendance }),
          ...(absenceWarning !== undefined && { absenceWarning }),
          ...(weeklyDigest !== undefined && { weeklyDigest }),
          updatedAt: new Date(),
        },
        create: {
          userId,
          emailNotifications:
            emailNotifications !== undefined ? emailNotifications : true,
          pushNotifications:
            pushNotifications !== undefined ? pushNotifications : true,
          smsNotifications:
            smsNotifications !== undefined ? smsNotifications : false,
          sessionReminders:
            sessionReminders !== undefined ? sessionReminders : true,
          attendanceReports:
            attendanceReports !== undefined ? attendanceReports : false,
          sessionStarted: sessionStarted !== undefined ? sessionStarted : true,
          sessionClosed: sessionClosed !== undefined ? sessionClosed : false,
          attendanceConfirmation:
            attendanceConfirmation !== undefined
              ? attendanceConfirmation
              : true,
          missedAttendance:
            missedAttendance !== undefined ? missedAttendance : true,
          absenceWarning: absenceWarning !== undefined ? absenceWarning : true,
          weeklyDigest: weeklyDigest !== undefined ? weeklyDigest : false,
        },
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:notifications:${userId}`);
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_NOTIFICATION_PREFERENCES",
          entity: "NotificationPreference",
          entityId: userId,
          oldValues: oldPreferences,
          newValues: req.body,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Notification preferences updated for user: ${req.user.id}`);

      res.json({
        success: true,
        data: preferences,
        message: "Notification preferences updated successfully",
      });
    } catch (error) {
      logger.error("Update notification preferences error:", error);
      next(error);
    }
  }

  /**
   * Get user's devices
   * GET /api/v1/users/me/devices
   */
  async getDevices(req, res, next) {
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
          platform: true,
          deviceModel: true,
          osVersion: true,
          appVersion: true,
          lastSeenAt: true,
          registeredAt: true,
          isTrusted: true,
          isActive: true,
        },
      });

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 120, JSON.stringify(devices));
      }

      res.json({
        success: true,
        data: devices,
        meta: {
          total: devices.length,
          message: devices.length === 0 ? "No trusted devices found" : null,
        },
      });
    } catch (error) {
      logger.error("Get devices error:", error);
      next(error);
    }
  }

  /**
   * Revoke a device (logout from specific device)
   * DELETE /api/v1/users/me/devices/:deviceId
   */
  async revokeDevice(req, res, next) {
    try {
      const { deviceId } = req.params;
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

      // Deactivate device
      await prisma.device.update({
        where: { id: deviceId },
        data: { isActive: false },
      });

      // Revoke all refresh tokens for this device
      await prisma.refreshToken.updateMany({
        where: {
          userId,
          deviceFingerprint: device.fingerprint,
          revoked: false,
        },
        data: { revoked: true },
      });

      // Clear Redis tokens for this device
      if (redisClient && redisClient.isReady) {
        const keys = await redisClient.keys(
          `refresh:${userId}:${device.fingerprint}`,
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
          action: "REVOKE_DEVICE",
          entity: "Device",
          entityId: deviceId,
          oldValues: {
            deviceName: device.deviceName,
            fingerprint: device.fingerprint,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Device revoked for user ${userId}: ${device.deviceName}`);

      res.json({
        success: true,
        data: { message: "Device revoked successfully" },
      });
    } catch (error) {
      logger.error("Revoke device error:", error);
      next(error);
    }
  }

  /**
   * Update FCM token for current device
   * PUT /api/v1/users/me/devices/fcm-token
   */
  async updateFCMToken(req, res, next) {
    try {
      const { fcmToken, deviceFingerprint } = req.body;
      const userId = req.user.id;

      if (!deviceFingerprint) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Device fingerprint is required",
          },
        });
      }

      const device = await prisma.device.findFirst({
        where: { fingerprint: deviceFingerprint, userId },
      });

      if (!device) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Device not found" },
        });
      }

      await prisma.device.update({
        where: { id: device.id },
        data: {
          fcmToken,
          lastSeenAt: new Date(),
        },
      });

      // Invalidate device cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:devices:${userId}`);
      }

      logger.info(`FCM token updated for device: ${device.deviceName}`);

      res.json({
        success: true,
        data: { message: "FCM token updated successfully" },
      });
    } catch (error) {
      logger.error("Update FCM token error:", error);
      next(error);
    }
  }

  /**
   * Get user's attendance statistics (for students)
   * GET /api/v1/users/me/attendance-stats
   */
  async getMyAttendanceStats(req, res, next) {
    try {
      const userId = req.user.id;

      // Check if user is student
      if (req.user.role !== "student") {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "Only students can access attendance stats",
          },
        });
      }

      const cacheKey = `user:attendance:${userId}`;

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

      const [
        totalRecords,
        presentRecords,
        lateRecords,
        absentRecords,
        excusedRecords,
        byCourse,
      ] = await Promise.all([
        prisma.attendanceRecord.count({ where: { studentId: userId } }),
        prisma.attendanceRecord.count({
          where: { studentId: userId, status: "present" },
        }),
        prisma.attendanceRecord.count({
          where: { studentId: userId, status: "late" },
        }),
        prisma.attendanceRecord.count({
          where: { studentId: userId, status: "absent" },
        }),
        prisma.attendanceRecord.count({
          where: { studentId: userId, status: "excused" },
        }),
        prisma.attendanceRecord.groupBy({
          by: ["session", "sessionId"],
          where: { studentId: userId },
          _count: true,
          _sum: { distanceM: true },
        }),
      ]);

      const stats = {
        total: totalRecords,
        present: presentRecords,
        late: lateRecords,
        absent: absentRecords,
        excused: excusedRecords,
        attendanceRate:
          totalRecords > 0
            ? parseFloat(
                (((presentRecords + lateRecords) / totalRecords) * 100).toFixed(
                  1,
                ),
              )
            : 0,
        lastUpdated: new Date(),
      };

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(stats));
      }

      res.json({ success: true, data: stats });
    } catch (error) {
      logger.error("Get attendance stats error:", error);
      next(error);
    }
  }

  /**
   * Upload profile picture/avatar
   * POST /api/v1/users/me/avatar
   */
  async uploadAvatar(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "No file uploaded" },
        });
      }

      // Validate file type
      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/jpg",
        "image/webp",
      ];
      if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid file type. Only JPEG, PNG, WEBP allowed",
          },
        });
      }

      // Validate file size (max 2MB)
      if (req.file.size > 2 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "File too large. Max 2MB",
          },
        });
      }

      // TODO: Upload to cloud storage (S3, Cloudinary, etc.)
      // For now, just return success

      // Invalidate profile cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:profile:${req.user.id}`);
      }

      logger.info(`Avatar uploaded for user: ${req.user.id}`);

      res.json({
        success: true,
        data: {
          message: "Avatar uploaded successfully",
          // url: uploadedImageUrl
        },
      });
    } catch (error) {
      logger.error("Upload avatar error:", error);
      next(error);
    }
  }

  /**
   * Delete account (request account deletion)
   * DELETE /api/v1/users/me
   */
  async deleteAccount(req, res, next) {
    try {
      const { password, reason } = req.body;
      const userId = req.user.id;

      // Verify password
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, email: true },
      });

      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({
          success: false,
          error: { code: "INVALID_PASSWORD", message: "Password is incorrect" },
        });
      }

      // Soft delete - deactivate account
      await prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
      });

      // Revoke all refresh tokens
      await prisma.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });

      // Clear all user caches
      if (redisClient && redisClient.isReady) {
        const keys = await redisClient.keys(`*${userId}*`);
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "DELETE_ACCOUNT",
          entity: "User",
          entityId: userId,
          newValues: { reason: reason || "User requested deletion" },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Account deactivated for user: ${user.email}`);

      res.json({
        success: true,
        data: {
          message:
            "Your account has been deactivated. Data will be retained for 30 days.",
        },
      });
    } catch (error) {
      logger.error("Delete account error:", error);
      next(error);
    }
  }
}

module.exports = new UserController();
