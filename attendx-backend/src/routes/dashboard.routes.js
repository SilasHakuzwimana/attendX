const express = require("express");
const { query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { authenticateToken, requireRole } = require("../middleware/auth.middleware");
const dashboardController = require("../controllers/dashboard.controller");

const router = express.Router();

// =====================================================
// MAIN DASHBOARD ROUTES
// =====================================================

/**
 * @route   GET /api/v1/dashboard
 * @desc    Get role-based dashboard (auto-detects user role)
 * @access  Private (All authenticated users)
 */
router.get(
  "/",
  authenticateToken,
  dashboardController.getDashboard.bind(dashboardController)
);

/**
 * @route   GET /api/v1/dashboard/student
 * @desc    Get student dashboard (explicit)
 * @access  Private (Student only)
 */
router.get(
  "/student",
  authenticateToken,
  requireRole("student"),
  dashboardController.getStudentDashboard.bind(dashboardController)
);

/**
 * @route   GET /api/v1/dashboard/lecturer
 * @desc    Get lecturer dashboard (explicit)
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer",
  authenticateToken,
  requireRole("lecturer", "admin"),
  dashboardController.getLecturerDashboard.bind(dashboardController)
);

/**
 * @route   GET /api/v1/dashboard/admin
 * @desc    Get admin dashboard (explicit)
 * @access  Private (Admin only)
 */
router.get(
  "/admin",
  authenticateToken,
  requireRole("admin"),
  dashboardController.getAdminDashboard.bind(dashboardController)
);

// =====================================================
// DASHBOARD WIDGETS (Modular data fetching)
// =====================================================

/**
 * @route   GET /api/v1/dashboard/widgets
 * @desc    Get specific dashboard widgets (modular loading)
 * @access  Private (All authenticated users)
 */
router.get(
  "/widgets",
  authenticateToken,
  query("widgets").optional().isString().trim(),
  validate,
  dashboardController.getDashboardWidgets.bind(dashboardController)
);

/**
 * @route   POST /api/v1/dashboard/refresh
 * @desc    Refresh dashboard cache for current user
 * @access  Private (All authenticated users)
 */
router.post(
  "/refresh",
  authenticateToken,
  dashboardController.refreshDashboard.bind(dashboardController)
);

// =====================================================
// STUDENT-SPECIFIC DASHBOARD WIDGETS
// =====================================================

/**
 * @route   GET /api/v1/dashboard/student/attendance
 * @desc    Get student attendance widget data
 * @access  Private (Student only)
 */
router.get(
  "/student/attendance",
  authenticateToken,
  requireRole("student"),
  async (req, res, next) => {
    try {
      const attendanceStats = await dashboardController.getStudentAttendanceStats(req.user.id);
      res.json({
        success: true,
        data: attendanceStats,
        widget: "attendance"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/student/active-sessions
 * @desc    Get student active sessions widget
 * @access  Private (Student only)
 */
router.get(
  "/student/active-sessions",
  authenticateToken,
  requireRole("student"),
  async (req, res, next) => {
    try {
      const activeSessions = await dashboardController.getStudentActiveSessions(req.user.id);
      res.json({
        success: true,
        data: activeSessions,
        widget: "active_sessions"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/student/upcoming
 * @desc    Get student upcoming sessions widget
 * @access  Private (Student only)
 */
router.get(
  "/student/upcoming",
  authenticateToken,
  requireRole("student"),
  async (req, res, next) => {
    try {
      const upcomingSessions = await dashboardController.getStudentUpcomingSessions(req.user.id);
      res.json({
        success: true,
        data: upcomingSessions,
        widget: "upcoming_sessions"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/student/progress
 * @desc    Get student course progress widget
 * @access  Private (Student only)
 */
router.get(
  "/student/progress",
  authenticateToken,
  requireRole("student"),
  async (req, res, next) => {
    try {
      const courseProgress = await dashboardController.getStudentCourseProgress(req.user.id);
      res.json({
        success: true,
        data: courseProgress,
        widget: "course_progress"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/student/recent-activity
 * @desc    Get student recent activity widget
 * @access  Private (Student only)
 */
router.get(
  "/student/recent-activity",
  authenticateToken,
  requireRole("student"),
  async (req, res, next) => {
    try {
      const recentActivity = await dashboardController.getStudentRecentActivity(req.user.id);
      res.json({
        success: true,
        data: recentActivity,
        widget: "recent_activity"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/student/notifications
 * @desc    Get student notifications widget
 * @access  Private (Student only)
 */
router.get(
  "/student/notifications",
  authenticateToken,
  requireRole("student"),
  query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { limit = 10 } = req.query;
      const notifications = await dashboardController.getStudentNotifications(req.user.id);
      res.json({
        success: true,
        data: notifications.slice(0, parseInt(limit)),
        widget: "notifications",
        total: notifications.length
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// LECTURER-SPECIFIC DASHBOARD WIDGETS
// =====================================================

/**
 * @route   GET /api/v1/dashboard/lecturer/courses
 * @desc    Get lecturer courses overview widget
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer/courses",
  authenticateToken,
  requireRole("lecturer"),
  async (req, res, next) => {
    try {
      const coursesOverview = await dashboardController.getLecturerCoursesOverview(req.user.id);
      res.json({
        success: true,
        data: coursesOverview,
        widget: "courses_overview"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/lecturer/active-sessions
 * @desc    Get lecturer active sessions widget
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer/active-sessions",
  authenticateToken,
  requireRole("lecturer"),
  async (req, res, next) => {
    try {
      const activeSessions = await dashboardController.getLecturerActiveSessions(req.user.id);
      res.json({
        success: true,
        data: activeSessions,
        widget: "active_sessions"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/lecturer/today-schedule
 * @desc    Get lecturer today's schedule widget
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer/today-schedule",
  authenticateToken,
  requireRole("lecturer"),
  async (req, res, next) => {
    try {
      const todaySchedule = await dashboardController.getLecturerTodaySchedule(req.user.id);
      res.json({
        success: true,
        data: todaySchedule,
        widget: "today_schedule"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/lecturer/at-risk
 * @desc    Get lecturer at-risk students summary widget
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer/at-risk",
  authenticateToken,
  requireRole("lecturer"),
  async (req, res, next) => {
    try {
      const atRiskSummary = await dashboardController.getLecturerAtRiskSummary(req.user.id);
      res.json({
        success: true,
        data: atRiskSummary,
        widget: "at_risk"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/lecturer/recent-activity
 * @desc    Get lecturer recent activity widget
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer/recent-activity",
  authenticateToken,
  requireRole("lecturer"),
  async (req, res, next) => {
    try {
      const recentActivity = await dashboardController.getLecturerRecentActivity(req.user.id);
      res.json({
        success: true,
        data: recentActivity,
        widget: "recent_activity"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/lecturer/notifications
 * @desc    Get lecturer notifications widget
 * @access  Private (Lecturer only)
 */
router.get(
  "/lecturer/notifications",
  authenticateToken,
  requireRole("lecturer"),
  query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { limit = 10 } = req.query;
      const notifications = await dashboardController.getLecturerNotifications(req.user.id);
      res.json({
        success: true,
        data: notifications.slice(0, parseInt(limit)),
        widget: "notifications",
        total: notifications.length
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// ADMIN-SPECIFIC DASHBOARD WIDGETS
// =====================================================

/**
 * @route   GET /api/v1/dashboard/admin/system-stats
 * @desc    Get admin system statistics widget
 * @access  Private (Admin only)
 */
router.get(
  "/admin/system-stats",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const systemStats = await dashboardController.getSystemStats();
      res.json({
        success: true,
        data: systemStats,
        widget: "system_stats"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/admin/user-stats
 * @desc    Get admin user statistics widget
 * @access  Private (Admin only)
 */
router.get(
  "/admin/user-stats",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const userStats = await dashboardController.getUserStats();
      res.json({
        success: true,
        data: userStats,
        widget: "user_stats"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/admin/academic-stats
 * @desc    Get admin academic statistics widget
 * @access  Private (Admin only)
 */
router.get(
  "/admin/academic-stats",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const academicStats = await dashboardController.getAcademicStats();
      res.json({
        success: true,
        data: academicStats,
        widget: "academic_stats"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/admin/attendance-overview
 * @desc    Get admin attendance overview widget
 * @access  Private (Admin only)
 */
router.get(
  "/admin/attendance-overview",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const attendanceOverview = await dashboardController.getAttendanceOverview();
      res.json({
        success: true,
        data: attendanceOverview,
        widget: "attendance_overview"
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/admin/recent-activity
 * @desc    Get admin recent activity widget
 * @access  Private (Admin only)
 */
router.get(
  "/admin/recent-activity",
  authenticateToken,
  requireRole("admin"),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { limit = 20 } = req.query;
      const recentActivity = await dashboardController.getAdminRecentActivity();
      res.json({
        success: true,
        data: recentActivity.slice(0, parseInt(limit)),
        widget: "recent_activity",
        total: recentActivity.length
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/admin/system-health
 * @desc    Get admin system health widget
 * @access  Private (Admin only)
 */
router.get(
  "/admin/system-health",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const systemHealth = await dashboardController.getSystemHealth();
      res.json({
        success: true,
        data: systemHealth,
        widget: "system_health"
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================
// DASHBOARD METRICS & KPI ROUTES
// =====================================================

/**
 * @route   GET /api/v1/dashboard/metrics
 * @desc    Get key performance indicators (KPIs) for current user
 * @access  Private (All authenticated users)
 */
router.get(
  "/metrics",
  authenticateToken,
  async (req, res, next) => {
    try {
      const { role, id } = req.user;
      let metrics = {};

      if (role === "student") {
        const stats = await dashboardController.getStudentAttendanceStats(id);
        metrics = {
          attendanceRate: stats.attendanceRate,
          currentStreak: stats.currentStreak,
          totalSessions: stats.totalSessions,
          enrolledCourses: (await prisma.enrollment.count({ where: { studentId: id, isActive: true } }))
        };
      } else if (role === "lecturer") {
        const courses = await prisma.course.findMany({ where: { lecturerId: id, isActive: true } });
        const sessions = await prisma.session.count({ where: { lecturerId: id } });
        const students = await prisma.enrollment.count({
          where: { course: { lecturerId: id }, isActive: true }
        });
        
        metrics = {
          totalCourses: courses.length,
          totalSessions: sessions,
          totalStudents: students,
          activeSessions: await prisma.session.count({ where: { lecturerId: id, status: "active" } })
        };
      } else if (role === "admin") {
        metrics = {
          totalUsers: await prisma.user.count(),
          activeSessions: await prisma.session.count({ where: { status: "active" } }),
          totalCourses: await prisma.course.count(),
          todayCheckins: await prisma.roomCheckin.count({
            where: { checkedInAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } }
          })
        };
      }

      res.json({
        success: true,
        data: metrics,
        role
      });
    } catch (error) {
      logger.error("Get dashboard metrics error:", error);
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/dashboard/quick-stats
 * @desc    Get quick statistics cards for dashboard
 * @access  Private (All authenticated users)
 */
router.get(
  "/quick-stats",
  authenticateToken,
  async (req, res, next) => {
    try {
      const { role, id } = req.user;
      let stats = [];

      if (role === "student") {
        const attendance = await dashboardController.getStudentAttendanceStats(id);
        const activeSessions = await dashboardController.getStudentActiveSessions(id);
        
        stats = [
          { label: "Attendance Rate", value: `${attendance.attendanceRate}%`, icon: "📊", color: "blue" },
          { label: "Present", value: attendance.present, icon: "✅", color: "green" },
          { label: "Late", value: attendance.late, icon: "⏰", color: "orange" },
          { label: "Active Sessions", value: activeSessions.length, icon: "🎯", color: "purple" }
        ];
      } else if (role === "lecturer") {
        const courses = await dashboardController.getLecturerCoursesOverview(id);
        const activeSessions = await dashboardController.getLecturerActiveSessions(id);
        
        stats = [
          { label: "Total Courses", value: courses.length, icon: "📚", color: "blue" },
          { label: "Total Students", value: courses.reduce((sum, c) => sum + c.enrolledCount, 0), icon: "👥", color: "green" },
          { label: "Active Sessions", value: activeSessions.length, icon: "🎯", color: "orange" },
          { label: "Avg Attendance", value: `${courses.reduce((sum, c) => sum + c.attendanceRate, 0) / courses.length || 0}%`, icon: "📈", color: "purple" }
        ];
      } else if (role === "admin") {
        const systemStats = await dashboardController.getSystemStats();
        
        stats = [
          { label: "Total Users", value: systemStats.totalUsers, icon: "👥", color: "blue" },
          { label: "Active Sessions", value: systemStats.activeSessions, icon: "🎯", color: "green" },
          { label: "Total Courses", value: (await prisma.course.count()), icon: "📚", color: "orange" },
          { label: "Today's Checkins", value: systemStats.todayCheckins, icon: "✅", color: "purple" }
        ];
      }

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error("Get quick stats error:", error);
      next(error);
    }
  }
);

module.exports = router;