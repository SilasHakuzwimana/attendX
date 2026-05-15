const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { authenticateToken, requireRole } = require("../middleware/auth.middleware");
const alertController = require("../controllers/alert.controller");

const router = express.Router();

// ==================== STUDENT ALERT ROUTES ====================

/**
 * @route   GET /api/v1/alerts/check-attendance
 * @desc    Check and generate attendance alerts for students
 * @access  Private (Student or Lecturer or Admin)
 */
router.get(
  "/check-attendance",
  authenticateToken,
  query("studentId").optional().isUUID().withMessage("Invalid student ID format"),
  query("courseId").optional().isUUID().withMessage("Invalid course ID format"),
  validate,
  alertController.checkAttendanceAlerts.bind(alertController)
);

/**
 * @route   GET /api/v1/alerts/history
 * @desc    Get user's alert history
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/history",
  authenticateToken,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("type").optional().isString(),
  query("severity").optional().isIn(["info", "warning", "critical"]),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  validate,
  alertController.getAlertHistory.bind(alertController)
);

/**
 * @route   PATCH /api/v1/alerts/:alertId/read
 * @desc    Mark alert as read
 * @access  Private (Student, Lecturer, Admin)
 */
router.patch(
  "/:alertId/read",
  authenticateToken,
  param("alertId").isUUID().withMessage("Invalid alert ID format"),
  validate,
  alertController.markAlertRead.bind(alertController)
);

// ==================== SESSION ALERT ROUTES (Lecturer/Admin) ====================

/**
 * @route   POST /api/v1/alerts/session-reminder
 * @desc    Send session reminder alerts to students
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/session-reminder",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  body("minutesBefore")
    .optional()
    .isInt({ min: 5, max: 120 })
    .withMessage("Minutes before must be between 5 and 120")
    .toInt(),
  validate,
  alertController.sendSessionReminders.bind(alertController)
);

/**
 * @route   POST /api/v1/alerts/session-closing
 * @desc    Send session closing warning to students who haven't checked in
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/session-closing",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  body("minutesBefore")
    .optional()
    .isInt({ min: 1, max: 30 })
    .withMessage("Minutes before must be between 1 and 30")
    .toInt(),
  validate,
  alertController.sendSessionClosingWarning.bind(alertController)
);

// ==================== LECTURER AT-RISK ALERT ROUTES ====================

/**
 * @route   GET /api/v1/alerts/lecturer/at-risk
 * @desc    Get lecturer's at-risk students alerts
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/lecturer/at-risk",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID().withMessage("Invalid course ID format"),
  query("threshold")
    .optional()
    .isInt({ min: 0, max: 100 })
    .withMessage("Threshold must be between 0 and 100")
    .toInt(),
  validate,
  alertController.getLecturerAtRiskAlerts.bind(alertController)
);

/**
 * @route   POST /api/v1/alerts/send-at-risk-alert
 * @desc    Send alert to at-risk students
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/send-at-risk-alert",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("courseId").isUUID().withMessage("Valid course ID is required"),
  body("studentIds")
    .isArray({ min: 1 })
    .withMessage("At least one student ID is required"),
  body("studentIds.*").isUUID().withMessage("Invalid student ID format"),
  body("message")
    .optional()
    .isString()
    .isLength({ max: 500 })
    .withMessage("Message cannot exceed 500 characters"),
  body("sendEmail").optional().isBoolean(),
  body("sendPush").optional().isBoolean(),
  validate,
  alertController.sendAtRiskAlert.bind(alertController)
);

// ==================== SYSTEM ALERT ROUTES (Admin Only) ====================

/**
 * @route   GET /api/v1/alerts/system
 * @desc    Get system alerts
 * @access  Private (Admin only)
 */
router.get(
  "/system",
  authenticateToken,
  requireRole("admin"),
  alertController.getSystemAlerts.bind(alertController)
);

/**
 * @route   POST /api/v1/alerts/system/:alertId/dismiss
 * @desc    Dismiss system alert
 * @access  Private (Admin only)
 */
router.post(
  "/system/:alertId/dismiss",
  authenticateToken,
  requireRole("admin"),
  param("alertId").isString().notEmpty().withMessage("Alert ID is required"),
  validate,
  alertController.dismissSystemAlert.bind(alertController)
);

// ==================== BULK ALERT OPERATIONS (Admin Only) ====================

/**
 * @route   POST /api/v1/alerts/broadcast
 * @desc    Broadcast alert to multiple users (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/broadcast",
  authenticateToken,
  requireRole("admin"),
  body("title").notEmpty().withMessage("Title is required").trim().isLength({ min: 3, max: 100 }),
  body("message").notEmpty().withMessage("Message is required").isLength({ max: 500 }),
  body("userIds")
    .optional()
    .isArray()
    .withMessage("User IDs must be an array"),
  body("userIds.*").optional().isUUID(),
  body("role").optional().isIn(["student", "lecturer", "admin"]),
  body("sendEmail").optional().isBoolean(),
  body("sendPush").optional().isBoolean(),
  body("sendSMS").optional().isBoolean(),
  validate,
  async (req, res, next) => {
    try {
      const { title, message, userIds, role, sendEmail = true, sendPush = true, sendSMS = false } = req.body;
      
      // Build user filter
      let where = {};
      if (userIds && userIds.length > 0) {
        where.id = { in: userIds };
      } else if (role) {
        where.role = role;
        where.isActive = true;
      } else {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Either userIds or role must be provided"
          }
        });
      }

      const users = await prisma.user.findMany({
        where,
        include: {
          devices: {
            where: { isActive: true, fcmToken: { not: null } }
          },
          notificationPref: true
        }
      });

      let emailSent = 0;
      let pushSent = 0;
      let smsSent = 0;

      for (const user of users) {
        const preferences = user.notificationPref;

        // Send email
        if (sendEmail && preferences?.emailNotifications !== false) {
          await sendEmail(
            user.email,
            `📢 ${title} - AttendX`,
            `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0;">AttendX</h1>
              </div>
              <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
                <h2 style="color: #333;">${title}</h2>
                <p>Dear ${user.fullName},</p>
                <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
                  <p>${message}</p>
                </div>
                <hr style="margin: 20px 0;" />
                <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
              </div>
            </div>
            `
          );
          emailSent++;
        }

        // Send push notification
        if (sendPush && preferences?.pushNotifications !== false) {
          for (const device of user.devices) {
            if (device.fcmToken) {
              await sendPushNotification(device.fcmToken, {
                title,
                body: message,
                data: {
                  type: "broadcast",
                  timestamp: new Date().toISOString()
                }
              });
              pushSent++;
            }
          }
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BROADCAST_ALERT",
          entity: "Alert",
          newValues: { title, recipients: users.length, emailSent, pushSent },
          ipAddress: req.ip,
          userAgent: req.get("user-agent")
        }
      });

      logger.info(`Broadcast alert sent to ${users.length} users by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          title,
          recipients: users.length,
          emailSent,
          pushSent,
          smsSent,
          message: `Alert broadcast to ${users.length} users`
        }
      });
    } catch (error) {
      logger.error("Broadcast alert error:", error);
      next(error);
    }
  }
);

// ==================== ALERT PREFERENCES ROUTES ====================

/**
 * @route   GET /api/v1/alerts/preferences
 * @desc    Get current user's alert preferences
 * @access  Private
 */
router.get(
  "/preferences",
  authenticateToken,
  async (req, res, next) => {
    try {
      const preferences = await prisma.notificationPreference.findUnique({
        where: { userId: req.user.id }
      });

      if (!preferences) {
        // Create default preferences
        const defaultPrefs = await prisma.notificationPreference.create({
          data: { userId: req.user.id }
        });
        return res.json({ success: true, data: defaultPrefs });
      }

      res.json({ success: true, data: preferences });
    } catch (error) {
      logger.error("Get alert preferences error:", error);
      next(error);
    }
  }
);

/**
 * @route   PUT /api/v1/alerts/preferences
 * @desc    Update alert preferences
 * @access  Private
 */
router.put(
  "/preferences",
  authenticateToken,
  body("emailNotifications").optional().isBoolean(),
  body("pushNotifications").optional().isBoolean(),
  body("smsNotifications").optional().isBoolean(),
  body("sessionReminders").optional().isBoolean(),
  body("attendanceReports").optional().isBoolean(),
  body("sessionStarted").optional().isBoolean(),
  body("sessionClosed").optional().isBoolean(),
  body("attendanceConfirmation").optional().isBoolean(),
  body("missedAttendance").optional().isBoolean(),
  body("absenceWarning").optional().isBoolean(),
  body("weeklyDigest").optional().isBoolean(),
  validate,
  async (req, res, next) => {
    try {
      const preferences = await prisma.notificationPreference.upsert({
        where: { userId: req.user.id },
        update: req.body,
        create: { userId: req.user.id, ...req.body }
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`user:notifications:${req.user.id}`);
      }

      logger.info(`Alert preferences updated for user ${req.user.id}`);

      res.json({
        success: true,
        data: preferences,
        message: "Alert preferences updated successfully"
      });
    } catch (error) {
      logger.error("Update alert preferences error:", error);
      next(error);
    }
  }
);

// ==================== ALERT STATISTICS ROUTES ====================

/**
 * @route   GET /api/v1/alerts/statistics
 * @desc    Get alert statistics (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/statistics",
  authenticateToken,
  requireRole("admin"),
  query("days").optional().isInt({ min: 1, max: 365 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { days = 30 } = req.query;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));

      const [totalAlerts, alertsByType, alertsBySeverity, recentAlerts] = await Promise.all([
        prisma.auditLog.count({
          where: {
            action: { in: ["LOW_ATTENDANCE_ALERT", "CONSECUTIVE_ABSENCE_ALERT", "SESSION_REMINDER", "SEND_AT_RISK_ALERT"] },
            createdAt: { gte: startDate }
          }
        }),
        prisma.auditLog.groupBy({
          by: ["action"],
          where: {
            action: { in: ["LOW_ATTENDANCE_ALERT", "CONSECUTIVE_ABSENCE_ALERT", "SESSION_REMINDER", "SEND_AT_RISK_ALERT"] },
            createdAt: { gte: startDate }
          },
          _count: true
        }),
        prisma.auditLog.groupBy({
          by: ["action"],
          where: {
            action: { in: ["LOW_ATTENDANCE_ALERT", "CONSECUTIVE_ABSENCE_ALERT"] },
            createdAt: { gte: startDate }
          },
          _count: true
        }),
        prisma.auditLog.findMany({
          where: {
            action: { in: ["LOW_ATTENDANCE_ALERT", "CONSECUTIVE_ABSENCE_ALERT"] },
            createdAt: { gte: startDate }
          },
          include: {
            user: {
              select: { id: true, fullName: true, email: true, role: true }
            }
          },
          orderBy: { createdAt: "desc" },
          take: 20
        })
      ]);

      res.json({
        success: true,
        data: {
          period: { days: parseInt(days), from: startDate, to: new Date() },
          summary: {
            totalAlerts,
            averagePerDay: (totalAlerts / parseInt(days)).toFixed(1),
            uniqueRecipients: new Set(recentAlerts.map(a => a.userId)).size
          },
          byType: alertsByType,
          bySeverity: alertsBySeverity,
          recentAlerts
        }
      });
    } catch (error) {
      logger.error("Get alert statistics error:", error);
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/alerts/types
 * @desc    Get all alert types
 * @access  Public
 */
router.get("/types", (req, res) => {
  res.json({
    success: true,
    data: {
      alertTypes: {
        LOW_ATTENDANCE: "low_attendance",
        CONSECUTIVE_ABSENCE: "consecutive_absence",
        SESSION_REMINDER: "session_reminder",
        SESSION_STARTED: "session_started",
        SESSION_EXTENDED: "session_extended",
        SESSION_CLOSING: "session_closing",
        ATTENDANCE_OVERRIDE: "attendance_override",
        COURSE_ANNOUNCEMENT: "course_announcement",
        SYSTEM_MAINTENANCE: "system_maintenance",
        ACHIEVEMENT: "achievement",
        WARNING: "warning",
        INFO: "info"
      },
      severityLevels: ["info", "warning", "critical"]
    }
  });
});

module.exports = router;