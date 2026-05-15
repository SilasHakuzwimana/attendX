const express = require("express");
const { body, param, query } = require("express-validator");
const multer = require("multer");
const { validate } = require("../middleware/validation.middleware");
const { authenticateToken } = require("../middleware/auth.middleware");
const userController = require("../controllers/user.controller");

const router = express.Router();

// Configure multer for avatar upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, WEBP allowed"), false);
    }
  },
});

// All routes require authentication
router.use(authenticateToken);

// =====================================================
// PROFILE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me
 * @desc    Get own profile with detailed information
 * @access  Private
 */
router.get("/me", userController.getProfile.bind(userController));

/**
 * @route   PATCH /api/v1/users/me
 * @desc    Update own profile
 * @access  Private
 */
router.patch(
  "/me",
  body("fullName")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Full name must be between 2 and 100 characters"),
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  validate,
  userController.updateProfile.bind(userController),
);

/**
 * @route   POST /api/v1/users/me/avatar
 * @desc    Upload profile picture/avatar
 * @access  Private
 */
router.post(
  "/me/avatar",
  upload.single("avatar"),
  userController.uploadAvatar.bind(userController),
);

/**
 * @route   DELETE /api/v1/users/me
 * @desc    Delete account (request account deletion)
 * @access  Private
 */
router.delete(
  "/me",
  body("password").notEmpty().withMessage("Password is required"),
  body("reason").optional().isString().trim(),
  validate,
  userController.deleteAccount.bind(userController),
);

// =====================================================
// NOTIFICATION PREFERENCES ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me/notification-preferences
 * @desc    Get notification preferences
 * @access  Private
 */
router.get(
  "/me/notification-preferences",
  userController.getNotificationPreferences.bind(userController),
);

/**
 * @route   PUT /api/v1/users/me/notification-preferences
 * @desc    Update notification preferences
 * @access  Private
 */
router.put(
  "/me/notification-preferences",
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
  userController.updateNotificationPreferences.bind(userController),
);

// =====================================================
// DEVICE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me/devices
 * @desc    Get user's devices
 * @access  Private
 */
router.get("/me/devices", userController.getDevices.bind(userController));

/**
 * @route   DELETE /api/v1/users/me/devices/:deviceId
 * @desc    Revoke a device (logout from specific device)
 * @access  Private
 */
router.delete(
  "/me/devices/:deviceId",
  param("deviceId").isUUID().withMessage("Invalid device ID"),
  validate,
  userController.revokeDevice.bind(userController),
);

/**
 * @route   PUT /api/v1/users/me/devices/fcm-token
 * @desc    Update FCM token for current device
 * @access  Private
 */
router.put(
  "/me/devices/fcm-token",
  body("fcmToken").notEmpty().withMessage("FCM token is required"),
  body("deviceFingerprint")
    .notEmpty()
    .withMessage("Device fingerprint is required"),
  validate,
  userController.updateFCMToken.bind(userController),
);

// =====================================================
// ATTENDANCE STATISTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me/attendance-stats
 * @desc    Get user's attendance statistics (for students)
 * @access  Private
 */
router.get(
  "/me/attendance-stats",
  userController.getMyAttendanceStats.bind(userController),
);

// =====================================================
// USER SESSIONS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me/sessions
 * @desc    Get user's session history
 * @access  Private
 */
router.get(
  "/me/sessions",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("role").optional().isIn(["student", "lecturer"]),
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, role } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const userId = req.user.id;

      let where = {};
      if (role === "lecturer" || req.user.role === "lecturer") {
        where = { lecturerId: userId };
      } else if (role === "student" || req.user.role === "student") {
        where = {
          attendanceRecords: {
            some: { studentId: userId },
          },
        };
      } else {
        where = {
          OR: [
            { lecturerId: userId },
            { attendanceRecords: { some: { studentId: userId } } },
          ],
        };
      }

      const [sessions, total] = await Promise.all([
        prisma.session.findMany({
          where,
          include: {
            course: {
              select: { id: true, code: true, name: true },
            },
            classroom: {
              select: { id: true, name: true, building: true },
            },
            _count: {
              select: { roomCheckins: true },
            },
          },
          orderBy: { startedAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.session.count({ where }),
      ]);

      // If student, add attendance status for each session
      let enrichedSessions = sessions;
      if (req.user.role === "student" || role === "student") {
        enrichedSessions = await Promise.all(
          sessions.map(async (session) => {
            const attendance = await prisma.attendanceRecord.findFirst({
              where: {
                sessionId: session.id,
                studentId: userId,
              },
              select: { status: true, markedAt: true },
            });
            return {
              ...session,
              myAttendance: attendance || { status: "absent", markedAt: null },
            };
          }),
        );
      }

      res.json({
        success: true,
        data: enrichedSessions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
          hasNextPage: skip + parseInt(limit) < total,
          hasPrevPage: page > 1,
        },
      });
    } catch (error) {
      logger.error("Get user sessions error:", error);
      next(error);
    }
  },
);

// =====================================================
// USER ACTIVITY ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me/activity
 * @desc    Get user's recent activity
 * @access  Private
 */
router.get(
  "/me/activity",
  query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { limit = 20 } = req.query;
      const userId = req.user.id;

      // Get recent check-ins (if student)
      let checkins = [];
      if (req.user.role === "student") {
        checkins = await prisma.roomCheckin.findMany({
          where: { studentId: userId },
          include: {
            session: {
              include: {
                course: { select: { name: true, code: true } },
              },
            },
          },
          orderBy: { checkedInAt: "desc" },
          take: parseInt(limit),
        });
      }

      // Get recent sessions (if lecturer)
      let sessions = [];
      if (req.user.role === "lecturer") {
        sessions = await prisma.session.findMany({
          where: { lecturerId: userId },
          include: {
            course: { select: { name: true, code: true } },
            _count: { select: { roomCheckins: true } },
          },
          orderBy: { startedAt: "desc" },
          take: parseInt(limit),
        });
      }

      // Get recent audit logs
      const auditLogs = await prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: parseInt(limit),
      });

      const activities = [
        ...checkins.map((c) => ({
          type: "checkin",
          title: `Checked in to ${c.session.course.name}`,
          timestamp: c.checkedInAt,
          data: { sessionCode: c.session.sessionCode, distanceM: c.distanceM },
        })),
        ...sessions.map((s) => ({
          type: "session",
          title: `Started session for ${s.course.name}`,
          timestamp: s.startedAt,
          data: { sessionCode: s.sessionCode, checkins: s._count.roomCheckins },
        })),
        ...auditLogs.map((log) => ({
          type: "audit",
          action: log.action,
          timestamp: log.createdAt,
          data: { entity: log.entity },
        })),
      ];

      // Sort by timestamp descending
      activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      res.json({
        success: true,
        data: activities.slice(0, parseInt(limit)),
        meta: {
          total: activities.length,
          limit: parseInt(limit),
        },
      });
    } catch (error) {
      logger.error("Get user activity error:", error);
      next(error);
    }
  },
);

// =====================================================
// USER STATISTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me/statistics
 * @desc    Get user statistics based on role
 * @access  Private
 */
router.get("/me/statistics", async (req, res, next) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;
    let statistics = {};

    if (role === "student") {
      const [
        totalAttendance,
        presentCount,
        lateCount,
        absentCount,
        enrolledCourses,
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
        prisma.enrollment.count({
          where: { studentId: userId, isActive: true },
        }),
      ]);

      const attended = presentCount + lateCount;
      statistics = {
        totalSessions: totalAttendance,
        present: presentCount,
        late: lateCount,
        absent: absentCount,
        attendanceRate:
          totalAttendance > 0
            ? parseFloat(((attended / totalAttendance) * 100).toFixed(1))
            : 100,
        enrolledCourses,
      };
    } else if (role === "lecturer") {
      const [totalCourses, totalStudents, totalSessions, totalCheckins] =
        await Promise.all([
          prisma.course.count({
            where: { lecturerId: userId, isActive: true },
          }),
          prisma.enrollment.count({
            where: { course: { lecturerId: userId }, isActive: true },
          }),
          prisma.session.count({ where: { lecturerId: userId } }),
          prisma.roomCheckin.count({
            where: { session: { lecturerId: userId } },
          }),
        ]);

      statistics = {
        totalCourses,
        totalStudents,
        totalSessions,
        totalCheckins,
        averageCheckinsPerSession:
          totalSessions > 0 ? (totalCheckins / totalSessions).toFixed(1) : 0,
      };
    }

    res.json({
      success: true,
      data: statistics,
      role,
    });
  } catch (error) {
    logger.error("Get user statistics error:", error);
    next(error);
  }
});

// =====================================================
// USER EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/me/export
 * @desc    Export user data
 * @access  Private
 */
router.get(
  "/me/export",
  query("format").optional().isIn(["json", "csv"]),
  validate,
  async (req, res, next) => {
    try {
      const { format = "json" } = req.query;
      const userId = req.user.id;

      // Get user profile
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          staffNumber: true,
          createdAt: true,
          lastLoginAt: true,
        },
      });

      // Get attendance records
      const attendance = await prisma.attendanceRecord.findMany({
        where: { studentId: userId },
        include: {
          session: {
            include: {
              course: { select: { name: true, code: true } },
            },
          },
        },
        orderBy: { markedAt: "desc" },
      });

      if (format === "csv") {
        const csvRows = [
          ["User Data Export"],
          [`Exported: ${new Date().toISOString()}`],
          [],
          ["Profile Information"],
          [
            "Full Name",
            "Email",
            "Phone",
            "Role",
            "Registration Number",
            "Created At",
            "Last Login",
          ],
          [
            user.fullName,
            user.email,
            user.phone || "",
            user.role,
            user.regNumber || user.staffNumber || "",
            user.createdAt.toISOString(),
            user.lastLoginAt ? user.lastLoginAt.toISOString() : "",
          ],
          [],
          ["Attendance Records"],
          [
            "Date",
            "Course",
            "Session Code",
            "Status",
            "Method",
            "Distance (m)",
          ],
        ];

        for (const record of attendance) {
          csvRows.push([
            record.markedAt.toISOString(),
            `${record.session.course.code} - ${record.session.course.name}`,
            record.session.sessionCode,
            record.status,
            record.submissionMethod || "N/A",
            record.distanceM || "N/A",
          ]);
        }

        const csvContent = csvRows.map((row) => row.join(",")).join("\n");

        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=my_data_${Date.now()}.csv`,
        );
        return res.send(csvContent);
      }

      res.json({
        success: true,
        data: {
          profile: user,
          attendance,
          exportDate: new Date(),
        },
      });
    } catch (error) {
      logger.error("Export user data error:", error);
      next(error);
    }
  },
);

// =====================================================
// PASSWORD CHANGE ROUTE (Additional security)
// =====================================================

/**
 * @route   POST /api/v1/users/me/change-password
 * @desc    Change password (alternative endpoint)
 * @access  Private
 */
router.post(
  "/me/change-password",
  body("currentPassword")
    .notEmpty()
    .withMessage("Current password is required"),
  body("newPassword")
    .isLength({ min: 8 })
    .withMessage("New password must be at least 8 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage("Password must contain uppercase, lowercase, and number"),
  body("revokeAllSessions").optional().isBoolean(),
  validate,
  async (req, res, next) => {
    try {
      const {
        currentPassword,
        newPassword,
        revokeAllSessions = false,
      } = req.body;
      const userId = req.user.id;
      const bcrypt = require("bcryptjs");

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, email: true },
      });

      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_PASSWORD",
            message: "Current password is incorrect",
          },
        });
      }

      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: hashedPassword },
      });

      if (revokeAllSessions) {
        await prisma.refreshToken.updateMany({
          where: { userId, revoked: false },
          data: { revoked: true },
        });

        if (redisClient && redisClient.isReady) {
          const keys = await redisClient.keys(`refresh:${userId}:*`);
          if (keys.length > 0) {
            await redisClient.del(keys);
          }
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CHANGE_PASSWORD",
          entity: "User",
          entityId: userId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Password changed for user: ${user.email}`);

      res.json({
        success: true,
        data: {
          message: revokeAllSessions
            ? "Password changed successfully. You have been logged out from all devices."
            : "Password changed successfully",
        },
      });
    } catch (error) {
      logger.error("Change password error:", error);
      next(error);
    }
  },
);

module.exports = router;
