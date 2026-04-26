const { validationResult } = require("express-validator");
const logger = require("../utils/logger");

class UserController {
  /**
   * Get own profile
   * GET /api/users/me
   */
  async getProfile(req, res, next) {
    try {
      const user = await global.prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          isActive: true,
          createdAt: true,
          notificationPref: true,
        },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update own profile
   * PATCH /api/users/me
   */
  async updateProfile(req, res, next) {
    try {
      const { fullName, phone } = req.body;

      const user = await global.prisma.user.update({
        where: { id: req.user.id },
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
          isActive: true,
          createdAt: true,
        },
      });

      logger.info(`Profile updated for user: ${user.email}`);
      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get notification preferences
   * GET /api/users/me/notification-preferences
   */
  async getNotificationPreferences(req, res, next) {
    try {
      let preferences = await global.prisma.notificationPreference.findUnique({
        where: { userId: req.user.id },
      });

      if (!preferences) {
        // Create default preferences if not exists
        preferences = await global.prisma.notificationPreference.create({
          data: { userId: req.user.id },
        });
      }

      res.json({ success: true, data: preferences });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update notification preferences
   * PUT /api/users/me/notification-preferences
   */
  async updateNotificationPreferences(req, res, next) {
    try {
      const {
        attendanceConfirmation,
        missedAttendance,
        absenceWarning,
        sessionStarted,
      } = req.body;

      const preferences = await global.prisma.notificationPreference.upsert({
        where: { userId: req.user.id },
        update: {
          attendanceConfirmation:
            attendanceConfirmation !== undefined
              ? attendanceConfirmation
              : undefined,
          missedAttendance:
            missedAttendance !== undefined ? missedAttendance : undefined,
          absenceWarning:
            absenceWarning !== undefined ? absenceWarning : undefined,
          sessionStarted:
            sessionStarted !== undefined ? sessionStarted : undefined,
        },
        create: {
          userId: req.user.id,
          attendanceConfirmation:
            attendanceConfirmation !== undefined
              ? attendanceConfirmation
              : true,
          missedAttendance:
            missedAttendance !== undefined ? missedAttendance : true,
          absenceWarning: absenceWarning !== undefined ? absenceWarning : true,
          sessionStarted: sessionStarted !== undefined ? sessionStarted : true,
        },
      });

      logger.info(`Notification preferences updated for user: ${req.user.id}`);
      res.json({ success: true, data: preferences });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new UserController();
