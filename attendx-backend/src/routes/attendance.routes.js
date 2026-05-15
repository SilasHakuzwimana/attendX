const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const attendanceController = require("../controllers/attendance.controller");

const router = express.Router();

// ==================== QUERY & LIST ROUTES ====================

/**
 * @route   GET /api/v1/attendance
 * @desc    Query attendance records with advanced filtering
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/",
  authenticateToken,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("sessionId").optional().isUUID(),
  query("courseId").optional().isUUID(),
  query("studentId").optional().isUUID(),
  query("status").optional().isIn(["present", "absent", "excused", "late"]),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("sortBy").optional().isIn(["markedAt", "status", "submissionMethod"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  attendanceController.queryAttendance.bind(attendanceController),
);

/**
 * @route   GET /api/v1/attendance/:attendanceId
 * @desc    Get single attendance record by ID
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/:attendanceId",
  authenticateToken,
  param("attendanceId").isUUID().withMessage("Invalid attendance ID format"),
  validate,
  attendanceController.getAttendanceRecord.bind(attendanceController),
);

// ==================== ATTENDANCE MANAGEMENT ====================

/**
 * @route   PATCH /api/v1/attendance/:attendanceId/override
 * @desc    Override attendance record (Lecturer/Admin only)
 * @access  Private (Lecturer or Admin)
 */
router.patch(
  "/:attendanceId/override",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("attendanceId").isUUID().withMessage("Invalid attendance ID format"),
  body("status")
    .isIn(["present", "absent", "excused", "late"])
    .withMessage("Valid status is required"),
  body("reason").optional().isString().trim().isLength({ max: 500 }),
  body("notes").optional().isString().trim().isLength({ max: 1000 }),
  validate,
  attendanceController.overrideAttendance.bind(attendanceController),
);

// ==================== STATISTICS ROUTES ====================

/**
 * @route   GET /api/v1/attendance/statistics/:studentId
 * @desc    Get attendance statistics for a student
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/statistics/:studentId",
  authenticateToken,
  param("studentId").isUUID().withMessage("Invalid student ID format"),
  query("courseId").optional().isUUID(),
  query("semester").optional().isInt({ min: 1, max: 2 }).toInt(),
  query("academicYear").optional().isString(),
  validate,
  attendanceController.getStudentStatistics.bind(attendanceController),
);

/**
 * @route   GET /api/v1/attendance/course/:courseId/statistics
 * @desc    Get course attendance statistics (Lecturer/Admin)
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/course/:courseId/statistics",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("sessionId").optional().isUUID(),
  validate,
  attendanceController.getCourseStatistics.bind(attendanceController),
);

/**
 * @route   GET /api/v1/attendance/at-risk
 * @desc    Get at-risk students (below threshold)
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/at-risk",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").isUUID().withMessage("Course ID is required"),
  query("threshold").optional().isInt({ min: 0, max: 100 }).toInt(),
  validate,
  attendanceController.getAtRiskStudents.bind(attendanceController),
);

// ==================== EXPORT ROUTES ====================

/**
 * @route   GET /api/v1/attendance/export
 * @desc    Export attendance data to CSV
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/export",
  authenticateToken,
  query("courseId").optional().isUUID(),
  query("sessionId").optional().isUUID(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("format").optional().isIn(["csv", "json"]),
  validate,
  attendanceController.exportAttendance.bind(attendanceController),
);

// ==================== SUMMARY ROUTES ====================

/**
 * @route   GET /api/v1/attendance/summary/me
 * @desc    Get current user's attendance summary
 * @access  Private
 */
router.get("/summary/me", authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;

    if (role !== "student") {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Only students can access attendance summary",
        },
      });
    }

    const [
      totalRecords,
      presentRecords,
      lateRecords,
      absentRecords,
      excusedRecords,
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
    ]);

    const attended = presentRecords + lateRecords;
    const attendanceRate =
      totalRecords > 0 ? (attended / totalRecords) * 100 : 100;

    // Get recent attendance trend
    const last30Days = new Date();
    last30Days.setDate(last30Days.getDate() - 30);

    const recentRecords = await prisma.attendanceRecord.findMany({
      where: {
        studentId: userId,
        markedAt: { gte: last30Days },
      },
      select: { status: true, markedAt: true },
      orderBy: { markedAt: "asc" },
    });

    // Calculate weekly trend
    const weeklyTrend = [];
    for (let i = 0; i < 4; i++) {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - (i + 1) * 7);
      const weekEnd = new Date();
      weekEnd.setDate(weekEnd.getDate() - i * 7);

      const weekRecords = recentRecords.filter(
        (r) => r.markedAt >= weekStart && r.markedAt < weekEnd,
      );

      const weekPresent = weekRecords.filter(
        (r) => r.status === "present" || r.status === "late",
      ).length;
      weeklyTrend.unshift({
        week: i + 1,
        attendanceRate:
          weekRecords.length > 0 ? (weekPresent / weekRecords.length) * 100 : 0,
        totalSessions: weekRecords.length,
      });
    }

    res.json({
      success: true,
      data: {
        overall: {
          totalSessions: totalRecords,
          present: presentRecords,
          late: lateRecords,
          absent: absentRecords,
          excused: excusedRecords,
          attendanceRate: parseFloat(attendanceRate.toFixed(1)),
        },
        weeklyTrend,
        lastUpdated: new Date(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ==================== BULK ATTENDANCE OPERATIONS ====================

/**
 * @route   POST /api/v1/attendance/bulk/mark
 * @desc    Mark attendance for multiple students (Lecturer only)
 * @access  Private (Lecturer only)
 */
router.post(
  "/bulk/mark",
  authenticateToken,
  requireRole("lecturer"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  body("attendances")
    .isArray({ min: 1 })
    .withMessage("At least one attendance record is required"),
  body("attendances.*.studentId")
    .isUUID()
    .withMessage("Invalid student ID format"),
  body("attendances.*.status")
    .isIn(["present", "absent", "excused", "late"])
    .withMessage("Valid status is required"),
  body("attendances.*.reason").optional().isString(),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId, attendances } = req.body;

      // Verify session belongs to lecturer
      const session = await prisma.session.findFirst({
        where: { id: sessionId, lecturerId: req.user.id },
        select: { id: true, courseId: true },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Session not found or not yours",
          },
        });
      }

      const results = {
        successful: [],
        failed: [],
      };

      for (const att of attendances) {
        try {
          // Check if enrollment exists
          const enrollment = await prisma.enrollment.findFirst({
            where: {
              studentId: att.studentId,
              courseId: session.courseId,
              isActive: true,
            },
          });

          if (!enrollment) {
            results.failed.push({
              studentId: att.studentId,
              error: "Student not enrolled in this course",
            });
            continue;
          }

          // Check if attendance already exists
          const existing = await prisma.attendanceRecord.findFirst({
            where: {
              sessionId,
              studentId: att.studentId,
            },
          });

          let attendanceRecord;
          if (existing) {
            attendanceRecord = await prisma.attendanceRecord.update({
              where: { id: existing.id },
              data: {
                status: att.status,
                overriddenAt: new Date(),
                overriddenBy: req.user.id,
                overrideReason: att.reason,
              },
            });
          } else {
            attendanceRecord = await prisma.attendanceRecord.create({
              data: {
                sessionId,
                studentId: att.studentId,
                status: att.status,
                submissionMethod: "manual",
                markedAt: new Date(),
                overriddenBy: req.user.id,
                overrideReason: att.reason,
              },
            });
          }

          results.successful.push({
            studentId: att.studentId,
            status: att.status,
            attendanceId: attendanceRecord.id,
          });
        } catch (error) {
          results.failed.push({
            studentId: att.studentId,
            error: error.message,
          });
        }
      }

      // Update session check-in count
      if (results.successful.length > 0) {
        const totalCheckins = await prisma.roomCheckin.count({
          where: { sessionId },
        });
        await prisma.session.update({
          where: { id: sessionId },
          data: { checkinsCount: totalCheckins },
        });
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_MARK_ATTENDANCE",
          entity: "Session",
          entityId: sessionId,
          newValues: {
            total: attendances.length,
            successful: results.successful.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Bulk attendance marked for session ${sessionId}: ${results.successful.length} successful, ${results.failed.length} failed`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          total: attendances.length,
          successful: results.successful.length,
          failed: results.failed.length,
          details: {
            successful: results.successful.slice(0, 20),
            failed: results.failed.slice(0, 20),
          },
        },
      });
    } catch (error) {
      logger.error("Bulk mark attendance error:", error);
      next(error);
    }
  },
);

// ==================== WEEKLY DIGEST ====================

/**
 * @route   GET /api/v1/attendance/digest/weekly
 * @desc    Get weekly attendance digest for student
 * @access  Private (Student only)
 */
router.get(
  "/digest/weekly",
  authenticateToken,
  requireRole("student"),
  async (req, res, next) => {
    try {
      const studentId = req.user.id;
      const startOfWeek = new Date();
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(endOfWeek.getDate() + 7);

      const records = await prisma.attendanceRecord.findMany({
        where: {
          studentId,
          markedAt: { gte: startOfWeek, lt: endOfWeek },
        },
        include: {
          session: {
            include: {
              course: { select: { name: true, code: true } },
            },
          },
        },
        orderBy: { markedAt: "asc" },
      });

      const totalSessions = records.length;
      const present = records.filter((r) => r.status === "present").length;
      const late = records.filter((r) => r.status === "late").length;
      const absent = records.filter((r) => r.status === "absent").length;
      const attendanceRate =
        totalSessions > 0 ? ((present + late) / totalSessions) * 100 : 100;

      // Group by day
      const byDay = {};
      records.forEach((record) => {
        const day = record.markedAt.toLocaleDateString("en-US", {
          weekday: "long",
        });
        if (!byDay[day]) {
          byDay[day] = { present: 0, late: 0, absent: 0, courses: [] };
        }
        byDay[day][record.status]++;
        byDay[day].courses.push(record.session.course.name);
      });

      res.json({
        success: true,
        data: {
          week: {
            from: startOfWeek,
            to: endOfWeek,
          },
          summary: {
            totalSessions,
            present,
            late,
            absent,
            attendanceRate: parseFloat(attendanceRate.toFixed(1)),
          },
          dailyBreakdown: byDay,
          recommendations:
            attendanceRate < 75
              ? [
                  "Your attendance is below 75% this week. Try to attend all sessions next week.",
                ]
              : ["Great job! Keep up your attendance record."],
        },
      });
    } catch (error) {
      logger.error("Get weekly digest error:", error);
      next(error);
    }
  },
);

module.exports = router;
