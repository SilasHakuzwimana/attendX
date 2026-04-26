const express = require("express");
const { query, param } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const analyticsController = require("../controllers/analytics.controller");

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * @route   GET /api/analytics/courses/:courseId/summary
 * @desc    Get course attendance summary
 * @access  Private (Lecturer sees their courses, Admin sees all)
 */
router.get(
  "/courses/:courseId/summary",
  param("courseId").isUUID(),
  query("from").optional().isDate(),
  query("to").optional().isDate(),
  validate,
  analyticsController.getCourseSummary,
);

/**
 * @route   GET /api/analytics/courses/:courseId/students
 * @desc    Get per-student attendance breakdown
 * @access  Private (Lecturer sees their courses, Admin sees all)
 */
router.get(
  "/courses/:courseId/students",
  param("courseId").isUUID(),
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("sortBy")
    .optional()
    .isIn(["attendanceRate", "consecutiveAbsences", "fullName"]),
  query("order").optional().isIn(["asc", "desc"]),
  validate,
  analyticsController.getStudentBreakdown,
);

/**
 * @route   GET /api/analytics/at-risk
 * @desc    Get at-risk students
 * @access  Private (Lecturer sees their courses, Admin sees all)
 */
router.get(
  "/at-risk",
  query("courseId").optional().isUUID(),
  validate,
  analyticsController.getAtRiskStudents,
);

/**
 * @route   GET /api/analytics/lecturer/dashboard
 * @desc    Get lecturer dashboard analytics
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer/dashboard",
  requireRole("lecturer"),
  analyticsController.getLecturerDashboard,
);

/**
 * @route   GET /api/analytics/admin/overview
 * @desc    Get system-wide attendance overview
 * @access  Private (Admin only)
 */
router.get(
  "/admin/overview",
  requireRole("admin"),
  analyticsController.getAdminOverview,
);

/**
 * @route   GET /api/analytics/trends
 * @desc    Get attendance trends over time
 * @access  Private (Lecturer/Admin)
 */
router.get(
  "/trends",
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("weeks").optional().isInt({ min: 1, max: 52 }),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, weeks = 12 } = req.query;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - weeks * 7);

      const where = {
        markedAt: { gte: startDate },
      };

      if (courseId) {
        where.session = { courseId };
      } else if (req.user.role === "lecturer") {
        const courses = await global.prisma.course.findMany({
          where: { lecturerId: req.user.id },
          select: { id: true },
        });
        where.session = { courseId: { in: courses.map((c) => c.id) } };
      }

      const records = await global.prisma.attendanceRecord.findMany({
        where,
        include: {
          session: { include: { course: true } },
        },
        orderBy: { markedAt: "asc" },
      });

      // Group by week
      const weeklyData = {};
      for (const record of records) {
        const week = getWeekNumber(record.markedAt);
        if (!weeklyData[week]) {
          weeklyData[week] = { week, total: 0, present: 0 };
        }
        weeklyData[week].total++;
        if (record.status === "present") weeklyData[week].present++;
      }

      res.json({
        success: true,
        data: Object.values(weeklyData).map((w) => ({
          week: w.week,
          attendanceRate: w.total > 0 ? (w.present / w.total) * 100 : 0,
          total: w.total,
          present: w.present,
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

// Helper function to get week number
function getWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
  );
}

module.exports = router;
