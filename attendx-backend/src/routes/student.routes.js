const express = require("express");
const { query, param, body } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const studentController = require("../controllers/student.controller");

const router = express.Router();

// All routes require student role
router.use(authenticateToken);
router.use(requireRole("student"));

// =====================================================
// STUDENT DASHBOARD ROUTES
// =====================================================

/**
 * @route   GET /api/v1/students/dashboard
 * @desc    Get student dashboard with overview statistics
 * @access  Private (Student only)
 */
router.get(
  "/dashboard",
  studentController.getDashboard.bind(studentController),
);

// =====================================================
// ATTENDANCE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/students/attendance/history
 * @desc    Get attendance history with advanced filtering
 * @access  Private (Student only)
 */
router.get(
  "/attendance/history",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("courseId").optional().isUUID(),
  query("status").optional().isIn(["present", "absent", "excused", "late"]),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("sortBy").optional().isIn(["markedAt", "status"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  studentController.getAttendanceHistory.bind(studentController),
);

/**
 * @route   GET /api/v1/students/attendance/trends
 * @desc    Get attendance trends for charts
 * @access  Private (Student only)
 */
router.get(
  "/attendance/trends",
  query("courseId").optional().isUUID(),
  query("view").optional().isIn(["daily", "weekly", "monthly"]),
  query("months").optional().isInt({ min: 1, max: 24 }).toInt(),
  validate,
  studentController.getAttendanceTrends.bind(studentController),
);

/**
 * @route   GET /api/v1/students/attendance/summary
 * @desc    Get attendance summary by course
 * @access  Private (Student only)
 */
router.get(
  "/attendance/summary",
  studentController.getAttendanceSummary.bind(studentController),
);

/**
 * @route   GET /api/v1/students/attendance/stats
 * @desc    Get quick attendance statistics
 * @access  Private (Student only)
 */
router.get("/attendance/stats", async (req, res, next) => {
  try {
    const studentId = req.user.id;

    const [
      totalRecords,
      presentRecords,
      lateRecords,
      absentRecords,
      excusedRecords,
    ] = await Promise.all([
      prisma.attendanceRecord.count({ where: { studentId } }),
      prisma.attendanceRecord.count({
        where: { studentId, status: "present" },
      }),
      prisma.attendanceRecord.count({ where: { studentId, status: "late" } }),
      prisma.attendanceRecord.count({ where: { studentId, status: "absent" } }),
      prisma.attendanceRecord.count({
        where: { studentId, status: "excused" },
      }),
    ]);

    const attended = presentRecords + lateRecords;
    const attendanceRate =
      totalRecords > 0 ? (attended / totalRecords) * 100 : 100;

    // Calculate current streak
    const recentRecords = await prisma.attendanceRecord.findMany({
      where: { studentId },
      orderBy: { markedAt: "desc" },
      take: 10,
    });

    let currentStreak = 0;
    for (const record of recentRecords) {
      if (record.status === "present" || record.status === "late") {
        currentStreak++;
      } else {
        break;
      }
    }

    res.json({
      success: true,
      data: {
        totalSessions: totalRecords,
        present: presentRecords,
        late: lateRecords,
        absent: absentRecords,
        excused: excusedRecords,
        attendanceRate: parseFloat(attendanceRate.toFixed(1)),
        currentStreak,
      },
    });
  } catch (error) {
    logger.error("Get attendance stats error:", error);
    next(error);
  }
});

// =====================================================
// COURSE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/students/courses
 * @desc    List enrolled courses
 * @access  Private (Student only)
 */
router.get(
  "/courses",
  query("semester").optional().isInt({ min: 1, max: 2 }).toInt(),
  query("academicYear").optional().isString(),
  query("includeProgress").optional().isBoolean().toBoolean(),
  validate,
  studentController.getEnrolledCourses.bind(studentController),
);

/**
 * @route   GET /api/v1/students/courses/:courseId
 * @desc    Get specific course details with attendance
 * @access  Private (Student only)
 */
router.get(
  "/courses/:courseId",
  param("courseId").isUUID().withMessage("Invalid course ID"),
  validate,
  async (req, res, next) => {
    try {
      const { courseId } = req.params;
      const studentId = req.user.id;

      // Verify enrollment
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true,
        },
        include: {
          course: {
            include: {
              lecturer: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          },
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

      // Get attendance records for this course
      const attendanceRecords = await prisma.attendanceRecord.findMany({
        where: {
          studentId,
          session: { courseId },
        },
        include: {
          session: {
            include: {
              classroom: true,
            },
          },
        },
        orderBy: { markedAt: "desc" },
      });

      const totalSessions = attendanceRecords.length;
      const presentCount = attendanceRecords.filter(
        (r) => r.status === "present",
      ).length;
      const lateCount = attendanceRecords.filter(
        (r) => r.status === "late",
      ).length;
      const absentCount = attendanceRecords.filter(
        (r) => r.status === "absent",
      ).length;
      const attendanceRate =
        totalSessions > 0
          ? ((presentCount + lateCount) / totalSessions) * 100
          : 100;

      // Get upcoming sessions for this course
      const upcomingSessions = await prisma.session.findMany({
        where: {
          courseId,
          status: "active",
          startedAt: { gt: new Date() },
        },
        include: {
          classroom: true,
        },
        orderBy: { startedAt: "asc" },
        take: 5,
      });

      res.json({
        success: true,
        data: {
          course: enrollment.course,
          enrolledAt: enrollment.enrolledAt,
          statistics: {
            totalSessions,
            present: presentCount,
            late: lateCount,
            absent: absentCount,
            attendanceRate: parseFloat(attendanceRate.toFixed(1)),
          },
          recentAttendance: attendanceRecords.slice(0, 10),
          upcomingSessions,
        },
      });
    } catch (error) {
      logger.error("Get course details error:", error);
      next(error);
    }
  },
);

// =====================================================
// SESSION MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/students/sessions/active
 * @desc    Get active sessions for enrolled courses
 * @access  Private (Student only)
 */
router.get(
  "/sessions/active",
  studentController.getActiveSessions.bind(studentController),
);

/**
 * @route   GET /api/v1/students/sessions/upcoming
 * @desc    Get upcoming scheduled sessions
 * @access  Private (Student only)
 */
router.get(
  "/sessions/upcoming",
  query("days").optional().isInt({ min: 1, max: 30 }).toInt(),
  validate,
  studentController.getUpcomingSessions.bind(studentController),
);

/**
 * @route   GET /api/v1/students/sessions/history
 * @desc    Get session attendance history
 * @access  Private (Student only)
 */
router.get(
  "/sessions/history",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("courseId").optional().isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, courseId } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const studentId = req.user.id;

      const where = { studentId };
      if (courseId) {
        where.session = { courseId };
      }

      const [sessions, total] = await Promise.all([
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
        data: sessions,
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
      logger.error("Get session history error:", error);
      next(error);
    }
  },
);

// =====================================================
// NOTIFICATION & PREFERENCE ROUTES
// =====================================================

/**
 * @route   GET /api/v1/students/notifications
 * @desc    Get student notifications
 * @access  Private (Student only)
 */
router.get(
  "/notifications",
  query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  query("read").optional().isBoolean(),
  validate,
  async (req, res, next) => {
    try {
      const { limit = 20, read } = req.query;
      const studentId = req.user.id;

      // Get recent absent warnings
      const warnings = await prisma.attendanceRecord.findMany({
        where: {
          studentId,
          status: "absent",
          markedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        include: {
          session: {
            include: {
              course: { select: { name: true, code: true } },
            },
          },
        },
        orderBy: { markedAt: "desc" },
        take: parseInt(limit),
      });

      const notifications = warnings.map((warning) => ({
        id: warning.id,
        type: "attendance_warning",
        title: "Missed Session",
        message: `You missed ${warning.session.course.name} on ${warning.markedAt.toLocaleDateString()}`,
        timestamp: warning.markedAt,
        read: false,
        data: {
          sessionId: warning.sessionId,
          courseName: warning.session.course.name,
        },
      }));

      res.json({
        success: true,
        data: notifications,
        meta: {
          total: notifications.length,
          unreadCount: notifications.filter((n) => !n.read).length,
        },
      });
    } catch (error) {
      logger.error("Get notifications error:", error);
      next(error);
    }
  },
);

/**
 * @route   PUT /api/v1/students/notifications/:notificationId/read
 * @desc    Mark notification as read
 * @access  Private (Student only)
 */
router.put(
  "/notifications/:notificationId/read",
  param("notificationId").isUUID().withMessage("Invalid notification ID"),
  validate,
  async (req, res, next) => {
    try {
      const { notificationId } = req.params;

      // In production, update notification status in database
      // For now, just return success

      res.json({
        success: true,
        data: { message: "Notification marked as read" },
      });
    } catch (error) {
      logger.error("Mark notification read error:", error);
      next(error);
    }
  },
);

/**
 * @route   PUT /api/v1/students/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Private (Student only)
 */
router.put("/notifications/read-all", async (req, res, next) => {
  try {
    // In production, update all notifications for student
    // For now, just return success

    res.json({
      success: true,
      data: { message: "All notifications marked as read" },
    });
  } catch (error) {
    logger.error("Mark all notifications read error:", error);
    next(error);
  }
});

// =====================================================
// PROFILE & PREFERENCE ROUTES
// =====================================================

/**
 * @route   GET /api/v1/students/profile
 * @desc    Get student profile
 * @access  Private (Student only)
 */
router.get("/profile", async (req, res, next) => {
  try {
    const student = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        regNumber: true,
        isActive: true,
        createdAt: true,
        notificationPref: true,
      },
    });

    if (!student) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Student not found" },
      });
    }

    res.json({ success: true, data: student });
  } catch (error) {
    logger.error("Get profile error:", error);
    next(error);
  }
});

/**
 * @route   PUT /api/v1/students/profile
 * @desc    Update student profile
 * @access  Private (Student only)
 */
router.put(
  "/profile",
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  body("fullName").optional().isString().trim().isLength({ min: 2, max: 100 }),
  validate,
  async (req, res, next) => {
    try {
      const { phone, fullName } = req.body;
      const studentId = req.user.id;

      const updatedStudent = await prisma.user.update({
        where: { id: studentId },
        data: {
          ...(phone && { phone }),
          ...(fullName && { fullName }),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          regNumber: true,
          updatedAt: true,
        },
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`student:dashboard:${studentId}`);
      }

      res.json({
        success: true,
        data: updatedStudent,
        message: "Profile updated successfully",
      });
    } catch (error) {
      logger.error("Update profile error:", error);
      next(error);
    }
  },
);

// =====================================================
// CACHE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   POST /api/v1/students/cache/invalidate
 * @desc    Invalidate student cache
 * @access  Private (Student only)
 */
router.post(
  "/cache/invalidate",
  studentController.invalidateCache.bind(studentController),
);

// =====================================================
// EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/students/export/attendance
 * @desc    Export student attendance to CSV
 * @access  Private (Student only)
 */
router.get(
  "/export/attendance",
  query("courseId").optional().isUUID(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("format").optional().isIn(["csv", "json"]),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, from, to, format = "csv" } = req.query;
      const studentId = req.user.id;

      const where = { studentId };
      if (courseId) {
        where.session = { courseId };
      }
      if (from || to) {
        where.markedAt = {};
        if (from) where.markedAt.gte = new Date(from);
        if (to) where.markedAt.lte = new Date(to);
      }

      const records = await prisma.attendanceRecord.findMany({
        where,
        include: {
          session: {
            include: {
              course: { select: { name: true, code: true } },
              classroom: { select: { name: true, building: true } },
            },
          },
        },
        orderBy: { markedAt: "desc" },
      });

      if (format === "json") {
        return res.json({
          success: true,
          data: records,
          total: records.length,
        });
      }

      const csvRows = [
        [
          "Date",
          "Course",
          "Session Code",
          "Status",
          "Classroom",
          "Distance (m)",
          "Method",
        ],
      ];

      for (const record of records) {
        csvRows.push([
          record.markedAt.toISOString(),
          `${record.session.course.code} - ${record.session.course.name}`,
          record.session.sessionCode,
          record.status.toUpperCase(),
          record.session.classroom?.name || "N/A",
          record.distanceM || "N/A",
          record.submissionMethod || "N/A",
        ]);
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=my_attendance_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      logger.error("Export attendance error:", error);
      next(error);
    }
  },
);

// =====================================================
// WEEKLY DIGEST ROUTE
// =====================================================

/**
 * @route   GET /api/v1/students/digest/weekly
 * @desc    Get weekly attendance digest
 * @access  Private (Student only)
 */
router.get("/digest/weekly", async (req, res, next) => {
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
});

module.exports = router;
