const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const sessionController = require("../controllers/session.controller");

const router = express.Router();

/**
 * @route   POST /api/sessions
 * @desc    Start a new attendance session
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("courseId").isUUID().withMessage("Valid course ID is required"),
  body("classroomId").isUUID().withMessage("Valid classroom ID is required"),
  body("durationMinutes")
    .optional()
    .isInt({ min: 15, max: 240 })
    .withMessage("Duration must be between 15 and 240 minutes"),
  validate,
  sessionController.startSession,
);

/**
 * @route   GET /api/sessions
 * @desc    List sessions
 * @access  Private (Lecturer sees own, Admin sees all)
 */
router.get(
  "/",
  authenticateToken,
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("courseId").optional().isUUID(),
  query("status").optional().isIn(["active", "closed", "expired"]),
  validate,
  sessionController.listSessions,
);

/**
 * @route   GET /api/sessions/:sessionId
 * @desc    Get session details
 * @access  Private
 */
router.get(
  "/:sessionId",
  authenticateToken,
  param("sessionId").isUUID(),
  validate,
  sessionController.getSession,
);

/**
 * @route   POST /api/sessions/:sessionId/checkin
 * @desc    Student check-in
 * @access  Private (Student only)
 */
router.post(
  "/:sessionId/checkin",
  authenticateToken,
  requireRole("student"),
  param("sessionId").isUUID(),
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
  sessionController.checkIn,
);

/**
 * @route   POST /api/sessions/:sessionId/close
 * @desc    Close session and finalize attendance
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/:sessionId/close",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID(),
  validate,
  sessionController.closeSession,
);

/**
 * @route   GET /api/sessions/:sessionId/checkins
 * @desc    Get live check-ins for session
 * @access  Private (Lecturer/Admin/Student can view their own)
 */
router.get(
  "/:sessionId/checkins",
  authenticateToken,
  param("sessionId").isUUID(),
  validate,
  sessionController.getLiveCheckins,
);

/**
 * @route   GET /api/sessions/:sessionId/export
 * @desc    Export session attendance as CSV
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/:sessionId/export",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;

      const session = await global.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          course: true,
          classroom: true,
          attendanceRecords: {
            include: { student: true },
          },
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }

      // Generate CSV
      let csv =
        "Student Name,Registration Number,Email,Status,Submission Method,Marked At\n";
      for (const record of session.attendanceRecords) {
        csv += `"${record.student.fullName}","${record.student.regNumber || ""}","${record.student.email}","${record.status}","${record.submissionMethod || "N/A"}","${record.markedAt.toISOString()}"\n`;
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=session_${sessionId}_attendance.csv`,
      );
      res.send(csv);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   POST /api/sessions/:sessionId/broadcast
 * @desc    Send notification to all students in session
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/:sessionId/broadcast",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID(),
  body("message").notEmpty().isLength({ max: 500 }),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { message } = req.body;

      const session = await global.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          course: {
            include: {
              enrollments: {
                include: {
                  student: {
                    include: { devices: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }

      // Send push notifications to all enrolled students
      const {
        sendPushNotification,
      } = require("../services/notification.service");
      let sentCount = 0;

      for (const enrollment of session.course.enrollments) {
        for (const device of enrollment.student.devices) {
          if (device.fcmToken && device.isActive) {
            await sendPushNotification(device.fcmToken, {
              title: `📢 ${session.course.name} Announcement`,
              body: message,
              data: { sessionId, type: "broadcast" },
            });
            sentCount++;
          }
        }
      }

      // Emit WebSocket event
      if (global.io) {
        global.io.to(`session:${sessionId}`).emit("broadcast", {
          message,
          from: req.user.fullName,
          timestamp: new Date(),
        });
      }

      res.json({
        success: true,
        data: {
          message: `Broadcast sent to ${sentCount} devices`,
          recipientCount: sentCount,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
