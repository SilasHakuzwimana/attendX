const express = require("express");
const { query, param } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const studentController = require("../controllers/student.controller");

const router = express.Router();

// All routes require student role
router.use(authenticateToken, requireRole("student"));

/**
 * @route   GET /api/students/dashboard
 * @desc    Get student dashboard
 * @access  Private (Student only)
 */
router.get("/dashboard", studentController.getDashboard);

/**
 * @route   GET /api/students/attendance/history
 * @desc    Get attendance history
 * @access  Private (Student only)
 */
router.get(
  "/attendance/history",
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("courseId").optional().isUUID(),
  query("from").optional().isDate(),
  query("to").optional().isDate(),
  validate,
  studentController.getAttendanceHistory,
);

/**
 * @route   GET /api/students/attendance/trends
 * @desc    Get attendance trends for charts
 * @access  Private (Student only)
 */
router.get(
  "/attendance/trends",
  query("courseId").optional().isUUID(),
  query("weeks").optional().isInt({ min: 1, max: 52 }),
  validate,
  studentController.getAttendanceTrends,
);

/**
 * @route   GET /api/students/courses
 * @desc    Get enrolled courses
 * @access  Private (Student only)
 */
router.get("/courses", studentController.getEnrolledCourses);

/**
 * @route   GET /api/students/sessions/active
 * @desc    Get active sessions for enrolled courses
 * @access  Private (Student only)
 */
router.get("/sessions/active", studentController.getActiveSessions);

/**
 * @route   GET /api/students/attendance/summary
 * @desc    Get attendance summary
 * @access  Private (Student only)
 */
router.get("/attendance/summary", async (req, res, next) => {
  try {
    const { courseId } = req.query;

    const where = { studentId: req.user.id };
    if (courseId) where.session = { courseId };

    const records = await global.prisma.attendanceRecord.findMany({
      where,
      include: { session: { include: { course: true } } },
    });

    const total = records.length;
    const present = records.filter((r) => r.status === "present").length;
    const absent = records.filter((r) => r.status === "absent").length;
    const excused = records.filter((r) => r.status === "excused").length;
    const late = records.filter((r) => r.status === "late").length;

    const byCourse = {};
    for (const record of records) {
      const courseName = record.session.course.name;
      if (!byCourse[courseName]) {
        byCourse[courseName] = {
          total: 0,
          present: 0,
          absent: 0,
          excused: 0,
          late: 0,
        };
      }
      byCourse[courseName].total++;
      byCourse[courseName][record.status]++;
    }

    res.json({
      success: true,
      data: {
        overall: {
          total,
          present,
          absent,
          excused,
          late,
          attendanceRate: total > 0 ? (present / total) * 100 : 0,
        },
        byCourse: Object.entries(byCourse).map(([name, stats]) => ({
          courseName: name,
          ...stats,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/students/upcoming-sessions
 * @desc    Get upcoming sessions (based on schedule)
 * @access  Private (Student only)
 */
router.get("/upcoming-sessions", async (req, res, next) => {
  try {
    // Get student's enrolled courses
    const enrollments = await global.prisma.enrollment.findMany({
      where: { studentId: req.user.id },
      include: { course: true },
    });

    const courseIds = enrollments.map((e) => e.courseId);

    // Get future sessions (for demo, we return active sessions)
    const sessions = await global.prisma.session.findMany({
      where: {
        courseId: { in: courseIds },
        status: "active",
        startedAt: { gt: new Date() },
      },
      include: {
        course: true,
        classroom: true,
      },
      orderBy: { startedAt: "asc" },
      take: 10,
    });

    res.json({ success: true, data: sessions });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
