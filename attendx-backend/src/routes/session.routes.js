const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const sessionController = require("../controllers/session.controller");
const checkinController = require("../controllers/checkin.controller");

const router = express.Router();

// =====================================================
// SESSION MANAGEMENT ROUTES
// =====================================================

/**
 * @route   POST /api/v1/sessions
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
    .withMessage("Duration must be between 15 and 240 minutes")
    .toInt(),
  validate,
  sessionController.startSession.bind(sessionController),
);

/**
 * @route   GET /api/v1/sessions
 * @desc    List sessions for lecturer
 * @access  Private (Lecturer sees own, Admin sees all)
 */
router.get(
  "/",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("courseId").optional().isUUID(),
  query("status").optional().isIn(["active", "closed", "expired"]),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("sortBy").optional().isIn(["startedAt", "expiresAt", "status"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  sessionController.listSessions.bind(sessionController),
);

/**
 * @route   GET /api/v1/sessions/statistics
 * @desc    Get session statistics for lecturer dashboard
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/statistics",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("period").optional().isIn(["week", "month", "semester"]),
  validate,
  sessionController.getSessionStatistics.bind(sessionController),
);

/**
 * @route   GET /api/v1/sessions/active/course/:courseId
 * @desc    Get active session for a course (for students)
 * @access  Private (Student only)
 */
router.get(
  "/active/course/:courseId",
  authenticateToken,
  requireRole("student"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  validate,
  sessionController.getActiveSessionByCourse.bind(sessionController),
);

/**
 * @route   GET /api/v1/sessions/:sessionId
 * @desc    Get session details
 * @access  Private (All authenticated users with access)
 */
router.get(
  "/:sessionId",
  authenticateToken,
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  validate,
  sessionController.getSession.bind(sessionController),
);

/**
 * @route   PATCH /api/v1/sessions/:sessionId/extend
 * @desc    Extend session duration
 * @access  Private (Lecturer/Admin only)
 */
router.patch(
  "/:sessionId/extend",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  body("minutes")
    .isInt({ min: 1, max: 120 })
    .withMessage("Minutes must be between 1 and 120")
    .toInt(),
  validate,
  sessionController.extendSession.bind(sessionController),
);

/**
 * @route   POST /api/v1/sessions/:sessionId/close
 * @desc    Close session and finalize attendance
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/:sessionId/close",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  validate,
  sessionController.closeSession.bind(sessionController),
);

// =====================================================
// CHECK-IN ROUTES
// =====================================================

/**
 * @route   POST /api/v1/sessions/:sessionId/checkin
 * @desc    Student check-in with GPS validation
 * @access  Private (Student only)
 */
router.post(
  "/:sessionId/checkin",
  authenticateToken,
  requireRole("student"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
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
  "/:sessionId/checkin-status",
  authenticateToken,
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  validate,
  checkinController.getCheckinStatus.bind(checkinController),
);

/**
 * @route   GET /api/v1/sessions/:sessionId/checkins
 * @desc    Get all check-ins for a session (Lecturer only)
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/:sessionId/checkins",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("status").optional().isIn(["present", "late", "absent", "excused"]),
  validate,
  checkinController.getSessionCheckins.bind(checkinController),
);

// =====================================================
// SESSION COMMUNICATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/sessions/:sessionId/broadcast
 * @desc    Send notification to all students in session
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/:sessionId/broadcast",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  body("title")
    .notEmpty()
    .withMessage("Title is required")
    .trim()
    .isLength({ min: 3, max: 100 }),
  body("message")
    .notEmpty()
    .withMessage("Message is required")
    .isLength({ max: 500 }),
  body("type").optional().isIn(["announcement", "reminder", "warning", "info"]),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { title, message, type = "announcement" } = req.body;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        include: {
          course: {
            include: {
              enrollments: {
                where: { isActive: true },
                include: {
                  student: {
                    include: {
                      devices: {
                        where: { isActive: true, fcmToken: { not: null } },
                      },
                      notificationPref: true,
                    },
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
          error: {
            code: "NOT_FOUND",
            message: "Session not found or access denied",
          },
        });
      }

      let emailSent = 0;
      let pushSent = 0;

      for (const enrollment of session.course.enrollments) {
        const student = enrollment.student;
        const preferences = student.notificationPref;

        // Send email
        if (preferences?.emailNotifications !== false) {
          await sendEmail(
            student.email,
            `📢 ${title} - ${session.course.code}`,
            `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #2196F3; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
                <h1 style="color: white; margin: 0;">AttendX</h1>
              </div>
              <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
                <h2 style="color: #333;">${title}</h2>
                <p>Dear ${student.fullName},</p>
                <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
                  <p><strong>Session:</strong> ${session.course.name} (${session.sessionCode})</p>
                  <p><strong>Message:</strong></p>
                  <p>${message}</p>
                </div>
                <hr style="margin: 20px 0;" />
                <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
              </div>
            </div>
            `,
          );
          emailSent++;
        }

        // Send push notification
        if (preferences?.pushNotifications !== false) {
          for (const device of student.devices) {
            if (device.fcmToken) {
              await sendPushNotification(device.fcmToken, {
                title,
                body: message,
                data: {
                  type,
                  sessionId,
                  sessionCode: session.sessionCode,
                  courseCode: session.course.code,
                  timestamp: new Date().toISOString(),
                },
              });
              pushSent++;
            }
          }
        }
      }

      // Emit WebSocket event
      if (io) {
        io.to(`session:${sessionId}`).emit("broadcast", {
          title,
          message,
          type,
          from: req.user.fullName,
          timestamp: new Date(),
        });
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SESSION_BROADCAST",
          entity: "Session",
          entityId: sessionId,
          newValues: {
            title,
            message,
            type,
            recipients: session.course.enrollments.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Broadcast sent to session ${sessionId}: ${title}`);

      res.json({
        success: true,
        data: {
          sessionId,
          title,
          message,
          type,
          recipients: {
            total: session.course.enrollments.length,
            emailSent,
            pushSent,
          },
        },
      });
    } catch (error) {
      logger.error("Session broadcast error:", error);
      next(error);
    }
  },
);

// =====================================================
// SESSION EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sessions/:sessionId/export
 * @desc    Export session attendance as CSV
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/:sessionId/export",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  query("format").optional().isIn(["csv", "json"]),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { format = "csv" } = req.query;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        include: {
          course: true,
          classroom: true,
          attendanceRecords: {
            include: {
              student: {
                select: {
                  fullName: true,
                  email: true,
                  regNumber: true,
                  phone: true,
                },
              },
            },
          },
          roomCheckins: true,
        },
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

      // Get enrolled students
      const enrolledCount = await prisma.enrollment.count({
        where: { courseId: session.courseId, isActive: true },
      });

      if (format === "json") {
        return res.json({
          success: true,
          data: {
            session: {
              id: session.id,
              sessionCode: session.sessionCode,
              startedAt: session.startedAt,
              expiresAt: session.expiresAt,
              status: session.status,
              course: session.course,
              classroom: session.classroom,
            },
            statistics: {
              totalEnrolled: enrolledCount,
              totalCheckins: session.roomCheckins.length,
              totalAttendance: session.attendanceRecords.length,
            },
            attendanceRecords: session.attendanceRecords,
          },
        });
      }

      // CSV format
      const csvRows = [
        [
          "Student Name",
          "Registration Number",
          "Email",
          "Phone",
          "Status",
          "Submission Method",
          "Marked At",
          "Distance (m)",
        ],
      ];

      for (const record of session.attendanceRecords) {
        csvRows.push([
          `"${record.student.fullName.replace(/"/g, '""')}"`,
          record.student.regNumber || "",
          record.student.email,
          record.student.phone || "",
          record.status.toUpperCase(),
          record.submissionMethod || "N/A",
          record.markedAt.toISOString(),
          record.distanceM || "",
        ]);
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=session_${session.sessionCode}_attendance_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      logger.error("Export session error:", error);
      next(error);
    }
  },
);

// =====================================================
// SESSION SUMMARY ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sessions/:sessionId/summary
 * @desc    Get session summary for students
 * @access  Private (Student only)
 */
router.get(
  "/:sessionId/summary",
  authenticateToken,
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const studentId = req.user.id;

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          course: true,
          classroom: true,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Session not found" },
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
            code: "FORBIDDEN",
            message: "You are not enrolled in this course",
          },
        });
      }

      const checkin = await prisma.roomCheckin.findFirst({
        where: { sessionId, studentId },
      });

      const attendance = await prisma.attendanceRecord.findFirst({
        where: { sessionId, studentId },
      });

      res.json({
        success: true,
        data: {
          session: {
            id: session.id,
            sessionCode: session.sessionCode,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            status: session.status,
            courseName: session.course.name,
            courseCode: session.course.code,
            classroom: session.classroom.name,
            building: session.classroom.building,
          },
          myAttendance: {
            hasCheckedIn: !!checkin,
            checkedInAt: checkin?.checkedInAt || null,
            status: attendance?.status || "absent",
            distanceM: checkin?.distanceM || null,
            submissionMethod: checkin?.submissionMethod || null,
          },
          statistics: {
            totalCheckins: await prisma.roomCheckin.count({
              where: { sessionId },
            }),
            totalEnrolled: await prisma.enrollment.count({
              where: { courseId: session.courseId, isActive: true },
            }),
          },
        },
      });
    } catch (error) {
      logger.error("Get session summary error:", error);
      next(error);
    }
  },
);

// =====================================================
// SESSION QR CODE ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sessions/:sessionId/qrcode
 * @desc    Generate QR code for session check-in
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/:sessionId/qrcode",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const QRCode = require("qrcode");

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        select: {
          id: true,
          sessionCode: true,
          course: { select: { name: true } },
        },
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

      const qrData = JSON.stringify({
        type: "session_checkin",
        sessionId: session.id,
        sessionCode: session.sessionCode,
        timestamp: new Date().toISOString(),
      });

      const qrCode = await QRCode.toDataURL(qrData);

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          sessionCode: session.sessionCode,
          courseName: session.course.name,
          qrCode,
          instructions:
            "Students can scan this QR code to check in to the session",
        },
      });
    } catch (error) {
      logger.error("Generate QR code error:", error);
      next(error);
    }
  },
);

// =====================================================
// SESSION REMINDER ROUTES
// =====================================================

/**
 * @route   POST /api/v1/sessions/:sessionId/remind
 * @desc    Send reminder for upcoming session
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/:sessionId/remind",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("sessionId").isUUID().withMessage("Invalid session ID"),
  body("minutesBefore")
    .optional()
    .isInt({ min: 5, max: 120 })
    .withMessage("Minutes before must be between 5 and 120")
    .toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { minutesBefore = 30 } = req.body;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
          status: "active",
          startedAt: { gt: new Date() },
        },
        include: {
          course: {
            include: {
              enrollments: {
                where: { isActive: true },
                include: {
                  student: {
                    include: {
                      devices: {
                        where: { isActive: true, fcmToken: { not: null } },
                      },
                      notificationPref: true,
                    },
                  },
                },
              },
            },
          },
          classroom: true,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Active session not found or access denied",
          },
        });
      }

      let emailSent = 0;
      let pushSent = 0;

      const startTime = new Date(session.startedAt);
      const reminderTime = new Date(
        startTime.getTime() - minutesBefore * 60000,
      );

      // Only send if current time is past reminder time
      if (new Date() < reminderTime) {
        return res.json({
          success: true,
          data: {
            message: `Reminders will be sent at ${reminderTime.toLocaleTimeString()}`,
            scheduled: true,
          },
        });
      }

      for (const enrollment of session.course.enrollments) {
        const student = enrollment.student;
        const preferences = student.notificationPref;

        if (preferences?.sessionReminders !== false) {
          if (preferences?.emailNotifications !== false) {
            await sendEmail(
              student.email,
              `⏰ Session Reminder: ${session.course.name} - AttendX`,
              `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
                  <h1 style="color: white; margin: 0;">AttendX</h1>
                </div>
                <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
                  <h2 style="color: #333;">⏰ Session Reminder</h2>
                  <p>Dear ${student.fullName},</p>
                  <p>This is a reminder that your session starts in <strong>${minutesBefore} minutes</strong>.</p>
                  <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
                    <p><strong>Session Details:</strong></p>
                    <ul>
                      <li>Course: ${session.course.name} (${session.course.code})</li>
                      <li>Session Code: <strong>${session.sessionCode}</strong></li>
                      <li>Date: ${startTime.toLocaleDateString()}</li>
                      <li>Time: ${startTime.toLocaleTimeString()}</li>
                      <li>Location: ${session.classroom?.building || ""} ${session.classroom?.name || "Classroom"}</li>
                    </ul>
                  </div>
                  <p>Please arrive on time and have your device ready for check-in.</p>
                  <hr style="margin: 20px 0;" />
                  <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
                </div>
              </div>
              `,
            );
            emailSent++;
          }

          if (preferences?.pushNotifications !== false) {
            for (const device of student.devices) {
              if (device.fcmToken) {
                await sendPushNotification(device.fcmToken, {
                  title: "Session Reminder",
                  body: `${session.course.name} starts in ${minutesBefore} minutes. Session code: ${session.sessionCode}`,
                  data: {
                    type: "session_reminder",
                    sessionId: session.id,
                    sessionCode: session.sessionCode,
                    courseName: session.course.name,
                    startTime: session.startedAt.toISOString(),
                  },
                });
                pushSent++;
              }
            }
          }
        }
      }

      logger.info(
        `Session reminders sent for session ${sessionId}: ${emailSent} emails, ${pushSent} pushes`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          minutesBefore,
          recipients: session.course.enrollments.length,
          emailSent,
          pushSent,
          message: `Reminders sent to ${session.course.enrollments.length} students`,
        },
      });
    } catch (error) {
      logger.error("Send session reminders error:", error);
      next(error);
    }
  },
);

module.exports = router;
