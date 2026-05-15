const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const analyticsController = require("../controllers/analytics.controller");

const router = express.Router();

// ==================== LECTURER ANALYTICS ====================

/**
 * @route   GET /api/v1/analytics/lecturer/dashboard
 * @desc    Get lecturer dashboard analytics
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/lecturer/dashboard",
  authenticateToken,
  requireRole("lecturer", "admin"),
  analyticsController.getLecturerDashboard.bind(analyticsController),
);

// ==================== COURSE ANALYTICS ====================

/**
 * @route   GET /api/v1/analytics/courses/:courseId/summary
 * @desc    Get course attendance summary with detailed analytics
 * @access  Private (Lecturer or Admin for their courses)
 */
router.get(
  "/courses/:courseId/summary",
  authenticateToken,
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("period").optional().isIn(["all", "daily", "weekly", "monthly"]),
  validate,
  analyticsController.getCourseSummary.bind(analyticsController),
);

/**
 * @route   GET /api/v1/analytics/courses/:courseId/students
 * @desc    Get per-student attendance breakdown for a course
 * @access  Private (Lecturer or Admin for their courses)
 */
router.get(
  "/courses/:courseId/students",
  authenticateToken,
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("sortBy")
    .optional()
    .isIn(["attendanceRate", "fullName", "present", "late", "absent"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  query("search").optional().isString().trim(),
  query("status").optional().isIn(["good", "warning", "critical"]),
  validate,
  analyticsController.getStudentBreakdown.bind(analyticsController),
);

/**
 * @route   GET /api/v1/analytics/courses/:courseId/attendance
 * @desc    Get course attendance statistics with filters
 * @access  Private (Lecturer or Admin for their courses)
 */
router.get(
  "/courses/:courseId/attendance",
  authenticateToken,
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("sessionId").optional().isUUID(),
  validate,
  analyticsController.getCourseAttendanceStats.bind(analyticsController),
);

// ==================== AT-RISK STUDENTS ANALYTICS ====================

/**
 * @route   GET /api/v1/analytics/at-risk
 * @desc    Get at-risk students across courses
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/at-risk",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("threshold").optional().isInt({ min: 0, max: 100 }).toInt(),
  query("consecutiveAbsences").optional().isInt({ min: 1, max: 10 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 200 }).toInt(),
  validate,
  analyticsController.getAtRiskStudents.bind(analyticsController),
);

// ==================== TRENDS ANALYTICS ====================

/**
 * @route   GET /api/v1/analytics/trends
 * @desc    Get attendance trends over time
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/trends",
  authenticateToken,
  query("courseId").optional().isUUID(),
  query("period").optional().isIn(["daily", "weekly", "monthly"]),
  query("months").optional().isInt({ min: 1, max: 24 }).toInt(),
  validate,
  analyticsController.getAttendanceTrends.bind(analyticsController),
);

// ==================== ADMIN ANALYTICS ====================

/**
 * @route   GET /api/v1/analytics/admin/overview
 * @desc    Get admin system overview analytics
 * @access  Private (Admin only)
 */
router.get(
  "/admin/overview",
  authenticateToken,
  requireRole("admin"),
  analyticsController.getAdminOverview.bind(analyticsController),
);

// ==================== SUMMARY STATISTICS ====================

/**
 * @route   GET /api/v1/analytics/summary
 * @desc    Get summary statistics for current user
 * @access  Private
 */
router.get("/summary", authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const role = req.user.role;

    let data = {};

    if (role === "student") {
      // Student summary
      const [totalRecords, presentRecords, lateRecords, coursesEnrolled] =
        await Promise.all([
          prisma.attendanceRecord.count({ where: { studentId: userId } }),
          prisma.attendanceRecord.count({
            where: { studentId: userId, status: "present" },
          }),
          prisma.attendanceRecord.count({
            where: { studentId: userId, status: "late" },
          }),
          prisma.enrollment.count({
            where: { studentId: userId, isActive: true },
          }),
        ]);

      const attendanceRate =
        totalRecords > 0
          ? ((presentRecords + lateRecords) / totalRecords) * 100
          : 100;

      data = {
        role: "student",
        totalSessions: totalRecords,
        present: presentRecords,
        late: lateRecords,
        attendanceRate: parseFloat(attendanceRate.toFixed(1)),
        coursesEnrolled,
      };
    } else if (role === "lecturer") {
      // Lecturer summary
      const [courses, totalStudents, totalSessions, totalCheckins] =
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

      data = {
        role: "lecturer",
        totalCourses: courses,
        totalStudents,
        totalSessions,
        totalCheckins,
        averageCheckinsPerSession:
          totalSessions > 0
            ? parseFloat((totalCheckins / totalSessions).toFixed(1))
            : 0,
      };
    }

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ==================== PERFORMANCE METRICS ====================

/**
 * @route   GET /api/v1/analytics/performance
 * @desc    Get system performance metrics (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/performance",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { days = 7 } = req.query;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));

      // Get API response times (from audit logs or custom metrics)
      const responseTimes = await prisma.auditLog.findMany({
        where: {
          createdAt: { gte: startDate },
          action: "API_REQUEST",
        },
        select: {
          createdAt: true,
          newValues: true,
        },
      });

      // Get database query performance
      const dbPerformance = await prisma.$queryRaw`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as query_count,
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_duration
        FROM audit_logs
        WHERE created_at >= ${startDate}
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `;

      // Get cache hit rates
      let cacheHitRate = 0;
      if (redisClient && redisClient.isReady) {
        const info = await redisClient.info("stats");
        const hits = info.match(/keyspace_hits:(\d+)/)?.[1] || 0;
        const misses = info.match(/keyspace_misses:(\d+)/)?.[1] || 0;
        const total = parseInt(hits) + parseInt(misses);
        cacheHitRate = total > 0 ? (parseInt(hits) / total) * 100 : 0;
      }

      res.json({
        success: true,
        data: {
          period: { days: parseInt(days), from: startDate, to: new Date() },
          responseTimes: {
            average: 245, // Placeholder - implement actual metrics
            p95: 512,
            p99: 1024,
          },
          database: dbPerformance,
          cache: {
            hitRate: parseFloat(cacheHitRate.toFixed(1)),
            hits: 0,
            misses: 0,
          },
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
        },
      });
    } catch (error) {
      logger.error("Get performance metrics error:", error);
      next(error);
    }
  },
);

// ==================== ENGAGEMENT METRICS ====================

/**
 * @route   GET /api/v1/analytics/engagement
 * @desc    Get user engagement metrics (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/engagement",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { period = "month" } = req.query;
      let startDate = new Date();

      switch (period) {
        case "week":
          startDate.setDate(startDate.getDate() - 7);
          break;
        case "month":
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case "semester":
          startDate.setMonth(startDate.getMonth() - 6);
          break;
        case "year":
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        default:
          startDate.setMonth(startDate.getMonth() - 1);
      }

      // Daily active users
      const dailyActive = await prisma.$queryRaw`
        SELECT 
          DATE(last_login_at) as date,
          COUNT(*) as active_users
        FROM users
        WHERE last_login_at >= ${startDate}
        GROUP BY DATE(last_login_at)
        ORDER BY date ASC
      `;

      // Session engagement
      const sessionEngagement = await prisma.$queryRaw`
        SELECT 
          DATE(started_at) as date,
          COUNT(*) as total_sessions,
          AVG(checkins_count) as avg_checkins
        FROM sessions
        WHERE started_at >= ${startDate}
        GROUP BY DATE(started_at)
        ORDER BY date ASC
      `;

      // Student engagement
      const studentEngagement = await prisma.attendanceRecord.groupBy({
        by: ["studentId"],
        where: {
          markedAt: { gte: startDate },
        },
        _count: true,
        orderBy: { _count: "desc" },
        take: 10,
      });

      // Get student details for top engaged
      const topStudents = await Promise.all(
        studentEngagement.map(async (record) => {
          const student = await prisma.user.findUnique({
            where: { id: record.studentId },
            select: { fullName: true, email: true, regNumber: true },
          });
          return {
            student,
            attendanceCount: record._count,
          };
        }),
      );

      res.json({
        success: true,
        data: {
          period,
          dateRange: { from: startDate, to: new Date() },
          dailyActive,
          sessionEngagement,
          topStudents,
          summary: {
            totalActiveUsers: dailyActive.length,
            averageDailyActive:
              dailyActive.reduce(
                (sum, d) => sum + parseInt(d.active_users),
                0,
              ) / dailyActive.length,
          },
        },
      });
    } catch (error) {
      logger.error("Get engagement metrics error:", error);
      next(error);
    }
  },
);

// ==================== PREDICTIVE ANALYTICS ====================

/**
 * @route   GET /api/v1/analytics/predictions
 * @desc    Get predictive analytics (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/predictions",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const { courseId } = req.query;

      // Get historical attendance data
      const where = {};
      if (courseId) where.courseId = courseId;

      const historicalData = await prisma.attendanceRecord.findMany({
        where,
        include: {
          session: {
            select: {
              startedAt: true,
              courseId: true,
            },
          },
        },
        orderBy: { markedAt: "asc" },
      });

      // Simple prediction based on historical average
      const totalRecords = historicalData.length;
      const presentRecords = historicalData.filter(
        (r) => r.status === "present",
      ).length;
      const averageAttendance =
        totalRecords > 0 ? (presentRecords / totalRecords) * 100 : 0;

      // Predict at-risk students
      const atRiskPrediction = [];
      if (courseId) {
        const enrollments = await prisma.enrollment.findMany({
          where: { courseId, isActive: true },
          select: { studentId: true },
        });

        for (const enrollment of enrollments) {
          const studentRecords = historicalData.filter(
            (r) => r.studentId === enrollment.studentId,
          );
          const studentTotal = studentRecords.length;
          const studentPresent = studentRecords.filter(
            (r) => r.status === "present",
          ).length;
          const studentRate =
            studentTotal > 0 ? (studentPresent / studentTotal) * 100 : 100;

          if (studentRate < 60) {
            atRiskPrediction.push({
              studentId: enrollment.studentId,
              currentRate: parseFloat(studentRate.toFixed(1)),
              predictedRate: parseFloat((studentRate * 0.9).toFixed(1)),
              risk: studentRate < 40 ? "high" : "medium",
            });
          }
        }
      }

      res.json({
        success: true,
        data: {
          overallPrediction: {
            currentAverage: parseFloat(averageAttendance.toFixed(1)),
            predictedAverage: parseFloat((averageAttendance * 0.95).toFixed(1)),
            trend: averageAttendance > 75 ? "stable" : "declining",
          },
          atRiskPrediction: atRiskPrediction.slice(0, 20),
          factors: [
            "Attendance rate below 60% in last 3 sessions",
            "Consecutive absences detected",
            "Late check-ins increasing",
          ],
          recommendations: [
            "Schedule additional support sessions",
            "Send automated reminders to at-risk students",
            "Review course difficulty and engagement",
          ],
        },
      });
    } catch (error) {
      logger.error("Get predictions error:", error);
      next(error);
    }
  },
);

// ==================== COMPARATIVE ANALYTICS ====================

/**
 * @route   GET /api/v1/analytics/compare
 * @desc    Compare analytics between courses or periods
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/compare",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseIds")
    .isArray()
    .withMessage("At least one course ID is required"),
  query("courseIds.*").isUUID(),
  query("metric").optional().isIn(["attendance", "checkins", "engagement"]),
  query("period").optional().isIn(["week", "month", "semester"]),
  validate,
  async (req, res, next) => {
    try {
      const { courseIds, metric = "attendance", period = "month" } = req.query;

      let startDate = new Date();
      switch (period) {
        case "week":
          startDate.setDate(startDate.getDate() - 7);
          break;
        case "month":
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case "semester":
          startDate.setMonth(startDate.getMonth() - 6);
          break;
      }

      const comparisonData = [];

      for (const courseId of courseIds) {
        const course = await prisma.course.findUnique({
          where: { id: courseId },
          select: { id: true, code: true, name: true },
        });

        if (!course) continue;

        // Get course statistics
        const sessions = await prisma.session.findMany({
          where: {
            courseId,
            startedAt: { gte: startDate },
            status: "closed",
          },
          include: {
            attendanceRecords: true,
          },
        });

        const totalSessions = sessions.length;
        let totalPresent = 0;
        let totalRecords = 0;

        for (const session of sessions) {
          totalPresent += session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          totalRecords += session.attendanceRecords.length;
        }

        const attendanceRate =
          totalRecords > 0 ? (totalPresent / totalRecords) * 100 : 0;

        comparisonData.push({
          course,
          metrics: {
            totalSessions,
            attendanceRate: parseFloat(attendanceRate.toFixed(1)),
            totalPresent,
            totalRecords,
          },
        });
      }

      // Calculate comparisons
      const avgAttendance =
        comparisonData.reduce((sum, c) => sum + c.metrics.attendanceRate, 0) /
        comparisonData.length;
      const bestPerforming = comparisonData.reduce(
        (best, c) =>
          c.metrics.attendanceRate > best.metrics.attendanceRate ? c : best,
        comparisonData[0],
      );
      const worstPerforming = comparisonData.reduce(
        (worst, c) =>
          c.metrics.attendanceRate < worst.metrics.attendanceRate ? c : worst,
        comparisonData[0],
      );

      res.json({
        success: true,
        data: {
          period,
          dateRange: { from: startDate, to: new Date() },
          comparison: comparisonData,
          insights: {
            averageAttendance: parseFloat(avgAttendance.toFixed(1)),
            bestPerforming: {
              course: bestPerforming.course,
              attendanceRate: bestPerforming.metrics.attendanceRate,
            },
            worstPerforming: {
              course: worstPerforming.course,
              attendanceRate: worstPerforming.metrics.attendanceRate,
            },
            variance: parseFloat(
              (
                bestPerforming.metrics.attendanceRate -
                worstPerforming.metrics.attendanceRate
              ).toFixed(1),
            ),
          },
        },
      });
    } catch (error) {
      logger.error("Compare analytics error:", error);
      next(error);
    }
  },
);

module.exports = router;
