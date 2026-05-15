const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const checkinController = require("../controllers/checkin.controller");

const router = express.Router();

// =====================================================
// STUDENT CHECK-IN ROUTES
// =====================================================

/**
 * @route   POST /api/v1/sessions/:sessionId/checkin
 * @desc    Student check-in to session with GPS validation
 * @access  Private (Student only)
 */
router.post(
  "/sessions/:sessionId/checkin",
  authenticateToken,
  requireRole("student"),
  param("sessionId").isUUID().withMessage("Invalid session ID format"),
  body("latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("Valid latitude is required"),
  body("longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("Valid longitude is required"),
  body("deviceFingerprint")
    .notEmpty()
    .withMessage("Device fingerprint is required"),
  validate,
  checkinController.checkIn.bind(checkinController),
);

/**
 * @route   GET /api/v1/sessions/:sessionId/checkin-status
 * @desc    Get check-in status for a session
 * @access  Private (Student only)
 */
router.get(
  "/sessions/:sessionId/checkin-status",
  authenticateToken,
  requireRole("student"),
  param("sessionId").isUUID().withMessage("Invalid session ID format"),
  validate,
  checkinController.getCheckinStatus.bind(checkinController),
);

/**
 * @route   GET /api/v1/checkin/nearby
 * @desc    Get nearby active sessions for student
 * @access  Private (Student only)
 */
router.get(
  "/nearby",
  authenticateToken,
  requireRole("student"),
  query("latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("Valid latitude is required"),
  query("longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("Valid longitude is required"),
  query("radius")
    .optional()
    .isFloat({ min: 10, max: 5000 })
    .withMessage("Radius must be between 10 and 5000 meters"),
  validate,
  checkinController.getNearbySessions.bind(checkinController),
);

// =====================================================
// LECTURER/ADMIN CHECK-IN MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sessions/:sessionId/checkins
 * @desc    Get all check-ins for a session (Lecturer only)
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/sessions/:sessionId/checkins",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID format"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("status").optional().isIn(["present", "late", "absent", "excused"]),
  validate,
  checkinController.getSessionCheckins.bind(checkinController),
);

/**
 * @route   POST /api/v1/sessions/:sessionId/manual-checkin
 * @desc    Manual check-in for lecturer/admin (for absent students)
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/sessions/:sessionId/manual-checkin",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID format"),
  body("studentId").isUUID().withMessage("Valid student ID is required"),
  body("status")
    .optional()
    .isIn(["present", "late", "excused"])
    .withMessage("Status must be present, late, or excused"),
  body("reason").optional().isString().trim().isLength({ max: 500 }),
  validate,
  checkinController.manualCheckin.bind(checkinController),
);

/**
 * @route   GET /api/v1/checkin/statistics
 * @desc    Get check-in statistics for lecturer dashboard
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/statistics",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("date").optional().isISO8601(),
  validate,
  checkinController.getCheckinStatistics.bind(checkinController),
);

// =====================================================
// BULK CHECK-IN OPERATIONS (Lecturer/Admin)
// =====================================================

/**
 * @route   POST /api/v1/checkin/bulk
 * @desc    Bulk check-in for multiple students (Lecturer only)
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/bulk",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  body("students")
    .isArray({ min: 1 })
    .withMessage("At least one student is required"),
  body("students.*.studentId")
    .isUUID()
    .withMessage("Invalid student ID format"),
  body("students.*.status")
    .optional()
    .isIn(["present", "late", "excused"])
    .withMessage("Invalid status"),
  body("students.*.reason").optional().isString(),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId, students } = req.body;
      const results = {
        successful: [],
        failed: [],
      };

      // Verify session exists and belongs to lecturer
      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        include: { course: true },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Session not found or access denied",
          },
        });
      }

      for (const student of students) {
        try {
          // Verify enrollment
          const enrollment = await prisma.enrollment.findFirst({
            where: {
              studentId: student.studentId,
              courseId: session.courseId,
              isActive: true,
            },
          });

          if (!enrollment) {
            results.failed.push({
              studentId: student.studentId,
              error: "Student not enrolled in this course",
            });
            continue;
          }

          // Check if already checked in
          const existingCheckin = await prisma.roomCheckin.findFirst({
            where: {
              sessionId,
              studentId: student.studentId,
            },
          });

          const status = student.status || "present";

          if (existingCheckin) {
            // Update existing
            await prisma.attendanceRecord.update({
              where: {
                sessionId_studentId: {
                  sessionId,
                  studentId: student.studentId,
                },
              },
              data: {
                status,
                overriddenAt: new Date(),
                overriddenBy: req.user.id,
                overrideReason: student.reason,
              },
            });
          } else {
            // Create new check-in
            const checkin = await prisma.roomCheckin.create({
              data: {
                sessionId,
                studentId: student.studentId,
                latitude: 0,
                longitude: 0,
                distanceM: 0,
                deviceFingerprint: "bulk_manual",
                submissionMethod: "manual",
                checkedInAt: new Date(),
              },
            });

            await prisma.attendanceRecord.create({
              data: {
                sessionId,
                studentId: student.studentId,
                status,
                submissionMethod: "manual",
                geofencePassed: true,
                distanceM: 0,
                checkinId: checkin.id,
                markedAt: new Date(),
                overriddenBy: req.user.id,
                overrideReason: student.reason,
              },
            });
          }

          results.successful.push({
            studentId: student.studentId,
            status,
          });

          // Update session check-in count
          await prisma.session.update({
            where: { id: sessionId },
            data: {
              checkinsCount: { increment: 1 },
            },
          });
        } catch (error) {
          results.failed.push({
            studentId: student.studentId,
            error: error.message,
          });
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_CHECKIN",
          entity: "Session",
          entityId: sessionId,
          newValues: {
            total: students.length,
            successful: results.successful.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Bulk check-in for session ${sessionId}: ${results.successful.length} successful, ${results.failed.length} failed`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          total: students.length,
          successful: results.successful.length,
          failed: results.failed.length,
          details: {
            successful: results.successful.slice(0, 20),
            failed: results.failed.slice(0, 20),
          },
        },
      });
    } catch (error) {
      logger.error("Bulk check-in error:", error);
      next(error);
    }
  },
);

// =====================================================
// CHECK-IN VALIDATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/checkin/validate-location
 * @desc    Validate location before check-in (pre-check validation)
 * @access  Private (Student only)
 */
router.post(
  "/validate-location",
  authenticateToken,
  requireRole("student"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  body("latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("Valid latitude is required"),
  body("longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("Valid longitude is required"),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId, latitude, longitude } = req.body;
      const studentId = req.user.id;

      // Get session with classroom
      const session = await prisma.session.findUnique({
        where: { id: sessionId, status: "active", checkinOpen: true },
        include: { classroom: true, course: true },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Active session not found" },
        });
      }

      // Check enrollment
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId: session.courseId,
          isActive: true,
        },
      });

      if (!enrollment) {
        return res.status(403).json({
          success: false,
          error: {
            code: "NOT_ENROLLED",
            message: "You are not enrolled in this course",
          },
        });
      }

      // Calculate distance
      const distance = calculateDistance(
        parseFloat(latitude),
        parseFloat(longitude),
        parseFloat(session.classroom.latitude),
        parseFloat(session.classroom.longitude),
      );

      const isValid = distance <= session.classroom.radiusM;
      const isLate = new Date() > new Date(session.expiresAt);

      res.json({
        success: true,
        data: {
          isValid,
          distanceM: Math.round(distance),
          radiusM: session.classroom.radiusM,
          isLate,
          canCheckin: isValid && !isLate,
          message: isValid
            ? isLate
              ? "You are within range but session has expired"
              : "You are within range. Ready to check in!"
            : `You are ${Math.round(distance)}m away. Must be within ${session.classroom.radiusM}m.`,
        },
      });
    } catch (error) {
      logger.error("Validate location error:", error);
      next(error);
    }
  },
);

// =====================================================
// CHECK-IN HISTORY ROUTES
// =====================================================

/**
 * @route   GET /api/v1/checkin/history
 * @desc    Get student's check-in history
 * @access  Private (Student only)
 */
router.get(
  "/history",
  authenticateToken,
  requireRole("student"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, from, to } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const studentId = req.user.id;

      const where = { studentId };
      if (from || to) {
        where.checkedInAt = {};
        if (from) where.checkedInAt.gte = new Date(from);
        if (to) where.checkedInAt.lte = new Date(to);
      }

      const [checkins, total] = await Promise.all([
        prisma.roomCheckin.findMany({
          where,
          include: {
            session: {
              include: {
                course: { select: { name: true, code: true } },
                classroom: { select: { name: true, building: true } },
              },
            },
          },
          orderBy: { checkedInAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.roomCheckin.count({ where }),
      ]);

      res.json({
        success: true,
        data: checkins,
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
      logger.error("Get check-in history error:", error);
      next(error);
    }
  },
);

/**
 * @route   GET /api/v1/checkin/today
 * @desc    Get today's check-in status for student
 * @access  Private (Student only)
 */
router.get(
  "/today",
  authenticateToken,
  requireRole("student"),
  async (req, res, next) => {
    try {
      const studentId = req.user.id;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const checkins = await prisma.roomCheckin.findMany({
        where: {
          studentId,
          checkedInAt: { gte: today, lt: tomorrow },
        },
        include: {
          session: {
            include: {
              course: { select: { name: true, code: true } },
            },
          },
        },
        orderBy: { checkedInAt: "desc" },
      });

      const checkedInSessions = checkins.map((c) => ({
        sessionId: c.sessionId,
        sessionCode: c.session.sessionCode,
        courseName: c.session.course.name,
        checkedInAt: c.checkedInAt,
        status: c.status,
      }));

      res.json({
        success: true,
        data: {
          hasCheckedInToday: checkins.length > 0,
          totalCheckinsToday: checkins.length,
          checkins: checkedInSessions,
        },
      });
    } catch (error) {
      logger.error("Get today's check-ins error:", error);
      next(error);
    }
  },
);

// =====================================================
// CHECK-IN REMINDER ROUTES
// =====================================================

/**
 * @route   POST /api/v1/checkin/reminder
 * @desc    Send check-in reminder for upcoming sessions
 * @access  Private (Student only)
 */
router.post(
  "/reminder",
  authenticateToken,
  requireRole("student"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.body;
      const studentId = req.user.id;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          status: "active",
          checkinOpen: true,
          expiresAt: { gt: new Date() },
        },
        include: {
          course: true,
          classroom: true,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Active session not found" },
        });
      }

      // Check enrollment
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId: session.courseId,
          isActive: true,
        },
      });

      if (!enrollment) {
        return res.status(403).json({
          success: false,
          error: {
            code: "NOT_ENROLLED",
            message: "You are not enrolled in this course",
          },
        });
      }

      // Send reminder (push notification)
      const devices = await prisma.device.findMany({
        where: {
          userId: studentId,
          isActive: true,
          fcmToken: { not: null },
        },
      });

      for (const device of devices) {
        await sendPushNotification(device.fcmToken, {
          title: "Session Reminder",
          body: `Don't forget to check in to ${session.course.name}! Session code: ${session.sessionCode}`,
          data: {
            type: "checkin_reminder",
            sessionId: session.id,
            sessionCode: session.sessionCode,
            courseName: session.course.name,
          },
        });
      }

      res.json({
        success: true,
        data: {
          message: "Reminder sent successfully",
          sessionId: session.id,
          courseName: session.course.name,
        },
      });
    } catch (error) {
      logger.error("Send check-in reminder error:", error);
      next(error);
    }
  },
);

module.exports = router;
