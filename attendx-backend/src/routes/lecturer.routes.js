const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const lecturerController = require("../controllers/lecturer.controller");

const router = express.Router();

// =====================================================
// LECTURER DASHBOARD ROUTES
// =====================================================

/**
 * @route   GET /api/v1/lecturer/dashboard
 * @desc    Get lecturer dashboard with overview statistics
 * @access  Private (Lecturer only)
 */
router.get(
  "/dashboard",
  authenticateToken,
  requireRole("lecturer"),
  lecturerController.getDashboard.bind(lecturerController),
);

// =====================================================
// COURSE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/lecturer/courses
 * @desc    Get all courses taught by lecturer
 * @access  Private (Lecturer only)
 */
router.get(
  "/courses",
  authenticateToken,
  requireRole("lecturer"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("semester").optional().isInt({ min: 1, max: 2 }).toInt(),
  query("academicYear").optional().isString(),
  query("includeStats").optional().isBoolean(),
  validate,
  lecturerController.getCourses.bind(lecturerController),
);

/**
 * @route   GET /api/v1/lecturer/courses/:courseId
 * @desc    Get course details with students and attendance
 * @access  Private (Lecturer only)
 */
router.get(
  "/courses/:courseId",
  authenticateToken,
  requireRole("lecturer"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  validate,
  lecturerController.getCourseDetails.bind(lecturerController),
);

/**
 * @route   GET /api/v1/lecturer/courses/:courseId/students
 * @desc    Get students enrolled in a course
 * @access  Private (Lecturer only)
 */
router.get(
  "/courses/:courseId/students",
  authenticateToken,
  requireRole("lecturer"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("sortBy")
    .optional()
    .isIn(["fullName", "regNumber", "email", "enrolledAt"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  query("attendanceBelow").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("attendanceAbove").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  validate,
  lecturerController.getCourseStudents.bind(lecturerController),
);

/**
 * @route   GET /api/v1/lecturer/courses/:courseId/students/:studentId
 * @desc    Get student's detailed attendance for a course
 * @access  Private (Lecturer only)
 */
router.get(
  "/courses/:courseId/students/:studentId",
  authenticateToken,
  requireRole("lecturer"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  param("studentId").isUUID().withMessage("Invalid student ID"),
  validate,
  lecturerController.getStudentCourseAttendance.bind(lecturerController),
);

// =====================================================
// ATTENDANCE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   POST /api/v1/lecturer/courses/:courseId/students/:studentId/attendance
 * @desc    Mark student attendance manually
 * @access  Private (Lecturer only)
 */
router.post(
  "/courses/:courseId/students/:studentId/attendance",
  authenticateToken,
  requireRole("lecturer"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  param("studentId").isUUID().withMessage("Invalid student ID"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  body("status")
    .isIn(["present", "late", "absent", "excused"])
    .withMessage("Valid status is required"),
  body("reason").optional().isString().trim().isLength({ max: 500 }),
  body("notes").optional().isString().trim().isLength({ max: 1000 }),
  validate,
  lecturerController.markStudentAttendance.bind(lecturerController),
);

/**
 * @route   POST /api/v1/lecturer/attendance/bulk
 * @desc    Bulk mark attendance for multiple students
 * @access  Private (Lecturer only)
 */
router.post(
  "/attendance/bulk",
  authenticateToken,
  requireRole("lecturer"),
  body("sessionId").isUUID().withMessage("Valid session ID is required"),
  body("attendances")
    .isArray({ min: 1 })
    .withMessage("At least one attendance record is required"),
  body("attendances.*.studentId").isUUID().withMessage("Invalid student ID"),
  body("attendances.*.status")
    .isIn(["present", "late", "absent", "excused"])
    .withMessage("Valid status is required"),
  body("attendances.*.reason").optional().isString(),
  validate,
  async (req, res, next) => {
    try {
      const { sessionId, attendances } = req.body;
      const lecturerId = req.user.id;

      // Verify session belongs to lecturer
      const session = await prisma.session.findFirst({
        where: { id: sessionId, lecturerId },
        include: { course: true },
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
          // Verify enrollment
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
          const existingAttendance = await prisma.attendanceRecord.findFirst({
            where: { sessionId, studentId: att.studentId },
          });

          if (existingAttendance) {
            await prisma.attendanceRecord.update({
              where: { id: existingAttendance.id },
              data: {
                status: att.status,
                overriddenAt: new Date(),
                overriddenBy: lecturerId,
                overrideReason: att.reason,
              },
            });
          } else {
            await prisma.attendanceRecord.create({
              data: {
                sessionId,
                studentId: att.studentId,
                status: att.status,
                submissionMethod: "manual",
                markedAt: new Date(),
                overriddenBy: lecturerId,
                overrideReason: att.reason,
              },
            });

            // Update session check-in count
            await prisma.session.update({
              where: { id: sessionId },
              data: { checkinsCount: { increment: 1 } },
            });
          }

          results.successful.push({
            studentId: att.studentId,
            status: att.status,
          });
        } catch (error) {
          results.failed.push({
            studentId: att.studentId,
            error: error.message,
          });
        }
      }

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

// =====================================================
// AT-RISK STUDENTS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/lecturer/at-risk-students
 * @desc    Get at-risk students across all courses
 * @access  Private (Lecturer only)
 */
router.get(
  "/at-risk-students",
  authenticateToken,
  requireRole("lecturer"),
  query("threshold").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("courseId").optional().isUUID(),
  validate,
  lecturerController.getAtRiskStudents.bind(lecturerController),
);

// =====================================================
// COURSE COMMUNICATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/lecturer/courses/:courseId/notify
 * @desc    Send notification to all students in a course
 * @access  Private (Lecturer only)
 */
router.post(
  "/courses/:courseId/notify",
  authenticateToken,
  requireRole("lecturer"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  body("title")
    .notEmpty()
    .withMessage("Title is required")
    .trim()
    .isLength({ min: 3, max: 100 }),
  body("message")
    .notEmpty()
    .withMessage("Message is required")
    .isLength({ max: 1000 }),
  body("type").optional().isIn(["announcement", "reminder", "warning", "info"]),
  validate,
  lecturerController.notifyCourseStudents.bind(lecturerController),
);

// =====================================================
// LECTURER STATISTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/lecturer/statistics/summary
 * @desc    Get lecturer performance summary
 * @access  Private (Lecturer only)
 */
router.get(
  "/statistics/summary",
  authenticateToken,
  requireRole("lecturer"),
  async (req, res, next) => {
    try {
      const lecturerId = req.user.id;

      const [
        totalCourses,
        totalStudents,
        totalSessions,
        totalCheckins,
        averageAttendance,
      ] = await Promise.all([
        prisma.course.count({ where: { lecturerId, isActive: true } }),
        prisma.enrollment.count({
          where: { course: { lecturerId }, isActive: true },
        }),
        prisma.session.count({ where: { lecturerId } }),
        prisma.roomCheckin.count({ where: { session: { lecturerId } } }),
        prisma.$queryRaw`
          SELECT AVG(attendance_rate) as avg_rate
          FROM (
            SELECT 
              s.id,
              COUNT(CASE WHEN ar.status IN ('present', 'late') THEN 1 END) * 100.0 / COUNT(*) as attendance_rate
            FROM sessions s
            JOIN attendance_records ar ON ar.session_id = s.id
            WHERE s.lecturer_id = ${lecturerId}
            GROUP BY s.id
          ) as session_rates
        `,
      ]);

      res.json({
        success: true,
        data: {
          totalCourses,
          totalStudents,
          totalSessions,
          totalCheckins,
          averageCheckinsPerSession:
            totalSessions > 0 ? (totalCheckins / totalSessions).toFixed(1) : 0,
          averageAttendanceRate: parseFloat(
            averageAttendance[0]?.avg_rate || 0,
          ).toFixed(1),
          studentToCourseRatio:
            totalCourses > 0 ? (totalStudents / totalCourses).toFixed(1) : 0,
        },
      });
    } catch (error) {
      logger.error("Get lecturer statistics error:", error);
      next(error);
    }
  },
);

/**
 * @route   GET /api/v1/lecturer/statistics/trends
 * @desc    Get attendance trends over time
 * @access  Private (Lecturer only)
 */
router.get(
  "/statistics/trends",
  authenticateToken,
  requireRole("lecturer"),
  query("period").optional().isIn(["daily", "weekly", "monthly"]),
  query("months").optional().isInt({ min: 1, max: 12 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const lecturerId = req.user.id;
      const { period = "monthly", months = 6 } = req.query;

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - parseInt(months));

      const sessions = await prisma.session.findMany({
        where: {
          lecturerId,
          startedAt: { gte: startDate },
          status: "closed",
        },
        include: {
          _count: { select: { roomCheckins: true } },
          course: { select: { id: true, name: true, code: true } },
        },
        orderBy: { startedAt: "asc" },
      });

      let trends = [];

      if (period === "daily") {
        const dailyData = new Map();
        sessions.forEach((s) => {
          const date = s.startedAt.toISOString().split("T")[0];
          if (!dailyData.has(date)) {
            dailyData.set(date, { date, sessions: 0, checkins: 0 });
          }
          const day = dailyData.get(date);
          day.sessions++;
          day.checkins += s._count.roomCheckins;
        });
        trends = Array.from(dailyData.values());
      } else if (period === "weekly") {
        const weeklyData = new Map();
        sessions.forEach((s) => {
          const week = this.getWeekNumber(s.startedAt);
          const year = s.startedAt.getFullYear();
          const key = `${year}-W${week}`;
          if (!weeklyData.has(key)) {
            weeklyData.set(key, { week: key, sessions: 0, checkins: 0 });
          }
          const w = weeklyData.get(key);
          w.sessions++;
          w.checkins += s._count.roomCheckins;
        });
        trends = Array.from(weeklyData.values());
      } else {
        const monthlyData = new Map();
        sessions.forEach((s) => {
          const month = s.startedAt.toISOString().substring(0, 7);
          if (!monthlyData.has(month)) {
            monthlyData.set(month, { month, sessions: 0, checkins: 0 });
          }
          const m = monthlyData.get(month);
          m.sessions++;
          m.checkins += s._count.roomCheckins;
        });
        trends = Array.from(monthlyData.values());
      }

      res.json({
        success: true,
        data: {
          period,
          dateRange: { from: startDate, to: new Date() },
          trends,
          summary: {
            totalSessions: sessions.length,
            totalCheckins: sessions.reduce(
              (sum, s) => sum + s._count.roomCheckins,
              0,
            ),
            averagePerSession:
              sessions.length > 0
                ? (
                    sessions.reduce(
                      (sum, s) => sum + s._count.roomCheckins,
                      0,
                    ) / sessions.length
                  ).toFixed(1)
                : 0,
          },
        },
      });
    } catch (error) {
      logger.error("Get lecturer trends error:", error);
      next(error);
    }
  },
);

/**
 * Helper function to get week number
 */
function getWeekNumber(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// =====================================================
// LECTURER EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/lecturer/export/attendance
 * @desc    Export attendance data for a course
 * @access  Private (Lecturer only)
 */
router.get(
  "/export/attendance",
  authenticateToken,
  requireRole("lecturer"),
  query("courseId").isUUID().withMessage("Course ID is required"),
  query("format").optional().isIn(["csv", "json"]),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, format = "csv", from, to } = req.query;
      const lecturerId = req.user.id;

      // Verify course belongs to lecturer
      const course = await prisma.course.findFirst({
        where: { id: courseId, lecturerId },
        select: { id: true, code: true, name: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      const whereSession = { courseId, status: "closed" };
      if (from || to) {
        whereSession.startedAt = {};
        if (from) whereSession.startedAt.gte = new Date(from);
        if (to) whereSession.startedAt.lte = new Date(to);
      }

      const sessions = await prisma.session.findMany({
        where: whereSession,
        include: {
          attendanceRecords: {
            include: {
              student: {
                select: { fullName: true, email: true, regNumber: true },
              },
            },
          },
        },
        orderBy: { startedAt: "asc" },
      });

      if (format === "json") {
        return res.json({ success: true, data: sessions });
      }

      const csvRows = [
        [
          "Session Code",
          "Date",
          "Student Name",
          "Registration Number",
          "Email",
          "Status",
          "Method",
          "Override Reason",
        ],
      ];

      for (const session of sessions) {
        for (const record of session.attendanceRecords) {
          csvRows.push([
            session.sessionCode,
            session.startedAt.toISOString(),
            `"${record.student.fullName.replace(/"/g, '""')}"`,
            record.student.regNumber || "",
            record.student.email,
            record.status,
            record.submissionMethod || "",
            record.overrideReason || "",
          ]);
        }
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=attendance_export_${course.code}_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      logger.error("Export attendance error:", error);
      next(error);
    }
  },
);

module.exports = router;
