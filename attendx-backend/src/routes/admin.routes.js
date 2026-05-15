const express = require("express");
const { body, param, query } = require("express-validator");
const multer = require("multer");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const adminController = require("../controllers/admin.controller");
const reportController = require("../controllers/report.controller");
const { prisma } = require("../index");

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"), false);
    }
  },
});

// All admin routes require authentication and admin role
router.use(authenticateToken);
router.use(requireRole("admin"));

// ==================== USER MANAGEMENT ====================

/**
 * @route   GET /api/v1/admin/users
 * @desc    List all users with advanced filtering
 * @access  Private (Admin only)
 */
router.get(
  "/users",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("role").optional().isIn(["student", "lecturer", "admin"]),
  query("search").optional().isString().trim(),
  query("isActive").optional().isBoolean().toBoolean(),
  query("sortBy")
    .optional()
    .isString()
    .isIn(["createdAt", "fullName", "email", "role", "lastLoginAt"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  adminController.listUsers,
);

/**
 * @route   POST /api/v1/admin/users
 * @desc    Create new user
 * @access  Private (Admin only)
 */
router.post(
  "/users",
  body("fullName")
    .notEmpty()
    .withMessage("Full name is required")
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Full name must be between 2 and 100 characters"),
  body("email")
    .isEmail()
    .withMessage("Valid email is required")
    .normalizeEmail(),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage("Password must contain uppercase, lowercase, and number"),
  body("role")
    .isIn(["student", "lecturer", "admin"])
    .withMessage("Valid role is required"),
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  body("regNumber")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 5, max: 20 })
    .withMessage("Registration number must be between 5 and 20 characters"),
  body("staffNumber")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 5, max: 20 })
    .withMessage("Staff number must be between 5 and 20 characters"),
  validate,
  adminController.createUser,
);

/**
 * @route   POST /api/v1/admin/users/bulk-import
 * @desc    Bulk import users from CSV
 * @access  Private (Admin only)
 */
router.post(
  "/users/bulk-import",
  upload.single("file"),
  body("role")
    .isIn(["student", "lecturer"])
    .withMessage("Valid role is required"),
  validate,
  adminController.bulkImportUsers,
);

/**
 * @route   GET /api/v1/admin/users/:userId
 * @desc    Get user by ID with full details
 * @access  Private (Admin only)
 */
router.get(
  "/users/:userId",
  param("userId").isUUID().withMessage("Invalid user ID format"),
  validate,
  adminController.getUser,
);

/**
 * @route   PATCH /api/v1/admin/users/:userId
 * @desc    Update user
 * @access  Private (Admin only)
 */
router.patch(
  "/users/:userId",
  param("userId").isUUID().withMessage("Invalid user ID format"),
  body("fullName").optional().isString().trim().isLength({ min: 2, max: 100 }),
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  body("role").optional().isIn(["student", "lecturer", "admin"]),
  body("regNumber").optional().isString().trim(),
  body("staffNumber").optional().isString().trim(),
  body("isActive").optional().isBoolean(),
  validate,
  adminController.updateUser,
);

/**
 * @route   DELETE /api/v1/admin/users/:userId
 * @desc    Deactivate user (soft delete)
 * @access  Private (Admin only)
 */
router.delete(
  "/users/:userId",
  param("userId").isUUID().withMessage("Invalid user ID format"),
  validate,
  adminController.deactivateUser,
);

/**
 * @route   POST /api/v1/admin/users/:userId/reset-password
 * @desc    Force reset user password
 * @access  Private (Admin only)
 */
router.post(
  "/users/:userId/reset-password",
  param("userId").isUUID().withMessage("Invalid user ID format"),
  body("newPassword")
    .optional()
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
  validate,
  adminController.forceResetPassword,
);

/**
 * @route   POST /api/v1/admin/users/:userId/activate
 * @desc    Reactivate deactivated user
 * @access  Private (Admin only)
 */
router.post(
  "/users/:userId/activate",
  param("userId").isUUID().withMessage("Invalid user ID format"),
  validate,
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, isActive: true },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      if (user.isActive) {
        return res.status(400).json({
          success: false,
          error: { code: "ALREADY_ACTIVE", message: "User is already active" },
        });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { isActive: true },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "REACTIVATE",
          entity: "User",
          entityId: userId,
          newValues: { isActive: true },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`User reactivated by ${req.user.email}: ${user.email}`);

      res.json({
        success: true,
        data: { message: "User reactivated successfully" },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ==================== COURSE MANAGEMENT ====================

/**
 * @route   GET /api/v1/admin/courses
 * @desc    List all courses
 * @access  Private (Admin only)
 */
router.get(
  "/courses",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("lecturerId").optional().isUUID(),
  query("semester").optional().isString(),
  query("academicYear").optional().isString(),
  query("isActive").optional().isBoolean().toBoolean(),
  validate,
  adminController.listCourses,
);

/**
 * @route   POST /api/v1/admin/courses
 * @desc    Create new course
 * @access  Private (Admin only)
 */
router.post(
  "/courses",
  body("code")
    .notEmpty()
    .withMessage("Course code is required")
    .trim()
    .isLength({ min: 3, max: 20 })
    .withMessage("Course code must be between 3 and 20 characters")
    .matches(/^[A-Za-z0-9]+$/)
    .withMessage("Course code must be alphanumeric"),
  body("name")
    .notEmpty()
    .withMessage("Course name is required")
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage("Course name must be between 3 and 100 characters"),
  body("lecturerId").isUUID().withMessage("Valid lecturer ID is required"),
  body("credits")
    .optional()
    .isInt({ min: 1, max: 6 })
    .withMessage("Credits must be between 1 and 6"),
  body("academicYear").optional().isString(),
  body("semester").optional().isInt({ min: 1, max: 2 }),
  body("description")
    .optional()
    .isString()
    .isLength({ max: 500 })
    .withMessage("Description cannot exceed 500 characters"),
  validate,
  adminController.createCourse,
);

/**
 * @route   GET /api/v1/admin/courses/:courseId
 * @desc    Get course details
 * @access  Private (Admin only)
 */
router.get(
  "/courses/:courseId",
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  validate,
  async (req, res, next) => {
    try {
      const { courseId } = req.params;
      const course = await prisma.course.findUnique({
        where: { id: courseId },
        include: {
          lecturer: {
            select: {
              id: true,
              fullName: true,
              email: true,
              staffNumber: true,
            },
          },
          _count: {
            select: {
              enrollments: {
                where: { isActive: true },
              },
              sessions: true,
            },
          },
        },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Get additional statistics
      const totalCheckins = await prisma.roomCheckin.count({
        where: { session: { courseId } },
      });

      const averageAttendance =
        course._count.sessions > 0
          ? (totalCheckins /
              (course._count.enrollments * course._count.sessions)) *
            100
          : 0;

      res.json({
        success: true,
        data: {
          ...course,
          statistics: {
            totalCheckins,
            averageAttendance: parseFloat(averageAttendance.toFixed(1)),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   PATCH /api/v1/admin/courses/:courseId
 * @desc    Update course
 * @access  Private (Admin only)
 */
router.patch(
  "/courses/:courseId",
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  body("name").optional().isString().trim().isLength({ min: 3, max: 100 }),
  body("lecturerId").optional().isUUID(),
  body("credits").optional().isInt({ min: 1, max: 6 }),
  body("description").optional().isString().isLength({ max: 500 }),
  body("isActive").optional().isBoolean(),
  body("academicYear").optional().isString(),
  body("semester").optional().isInt({ min: 1, max: 2 }),
  validate,
  adminController.updateCourse,
);

/**
 * @route   DELETE /api/v1/admin/courses/:courseId
 * @desc    Deactivate course
 * @access  Private (Admin only)
 */
router.delete(
  "/courses/:courseId",
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("force").optional().isBoolean().toBoolean(),
  validate,
  adminController.deactivateCourse,
);

/**
 * @route   POST /api/v1/admin/courses/:courseId/activate
 * @desc    Reactivate deactivated course
 * @access  Private (Admin only)
 */
router.post(
  "/courses/:courseId/activate",
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  validate,
  async (req, res, next) => {
    try {
      const { courseId } = req.params;

      const course = await prisma.course.findUnique({
        where: { id: courseId },
        select: { code: true, name: true, isActive: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      if (course.isActive) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ALREADY_ACTIVE",
            message: "Course is already active",
          },
        });
      }

      await prisma.course.update({
        where: { id: courseId },
        data: { isActive: true },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "COURSE_REACTIVATED",
          entity: "Course",
          entityId: courseId,
          newValues: { isActive: true },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Course reactivated by ${req.user.email}: ${course.code}`);

      res.json({
        success: true,
        data: { message: "Course reactivated successfully" },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   GET /api/v1/admin/courses/:courseId/enrollments
 * @desc    List enrolled students for a course
 * @access  Private (Admin only)
 */
router.get(
  "/courses/:courseId/enrollments",
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("status").optional().isIn(["active", "dropped"]),
  validate,
  async (req, res, next) => {
    try {
      const { courseId } = req.params;
      const { page = 1, limit = 20, search, status = "active" } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const where = {
        courseId,
        isActive: status === "active",
      };

      if (search) {
        where.student = {
          OR: [
            { fullName: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { regNumber: { contains: search, mode: "insensitive" } },
          ],
        };
      }

      const [enrollments, total] = await Promise.all([
        prisma.enrollment.findMany({
          where,
          include: {
            student: {
              select: {
                id: true,
                fullName: true,
                email: true,
                regNumber: true,
                phone: true,
                isActive: true,
              },
            },
          },
          skip,
          take: parseInt(limit),
          orderBy: { enrolledAt: "desc" },
        }),
        prisma.enrollment.count({ where }),
      ]);

      // Get attendance statistics for each student
      const enrollmentsWithStats = await Promise.all(
        enrollments.map(async (enrollment) => {
          const attendanceRecords = await prisma.attendanceRecord.count({
            where: {
              studentId: enrollment.student.id,
              session: { courseId },
            },
          });

          const presentRecords = await prisma.attendanceRecord.count({
            where: {
              studentId: enrollment.student.id,
              session: { courseId },
              status: { in: ["present", "late"] },
            },
          });

          const attendanceRate =
            attendanceRecords > 0
              ? (presentRecords / attendanceRecords) * 100
              : 100;

          return {
            ...enrollment,
            statistics: {
              totalSessions: attendanceRecords,
              attendedSessions: presentRecords,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
            },
          };
        }),
      );

      res.json({
        success: true,
        data: enrollmentsWithStats,
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
      next(error);
    }
  },
);

/**
 * @route   POST /api/v1/admin/courses/:courseId/enrollments
 * @desc    Enroll students in course
 * @access  Private (Admin only)
 */
router.post(
  "/courses/:courseId/enrollments",
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  body("studentIds")
    .isArray({ min: 1 })
    .withMessage("At least one student ID is required"),
  body("studentIds.*").isUUID().withMessage("Invalid student ID format"),
  validate,
  adminController.enrollStudents,
);

/**
 * @route   DELETE /api/v1/admin/courses/:courseId/enrollments/:studentId
 * @desc    Remove student from course
 * @access  Private (Admin only)
 */
router.delete(
  "/courses/:courseId/enrollments/:studentId",
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  param("studentId").isUUID().withMessage("Invalid student ID format"),
  validate,
  adminController.removeStudent,
);

// ==================== CLASSROOM MANAGEMENT ====================

/**
 * @route   GET /api/v1/admin/classrooms
 * @desc    List all classrooms
 * @access  Private (Admin only)
 */
router.get(
  "/classrooms",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("building").optional().isString().trim(),
  query("isActive").optional().isBoolean().toBoolean(),
  validate,
  adminController.listClassrooms,
);

/**
 * @route   POST /api/v1/admin/classrooms
 * @desc    Create classroom with geofence config
 * @access  Private (Admin only)
 */
router.post(
  "/classrooms",
  body("name")
    .notEmpty()
    .withMessage("Classroom name is required")
    .trim()
    .isLength({ min: 2, max: 100 }),
  body("code")
    .optional()
    .isString()
    .trim()
    .matches(/^[A-Za-z0-9\-_]+$/)
    .withMessage(
      "Classroom code can only contain letters, numbers, hyphens, and underscores",
    ),
  body("building").optional().isString().trim(),
  body("latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("Valid latitude is required (-90 to 90)"),
  body("longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("Valid longitude is required (-180 to 180)"),
  body("radiusM")
    .isInt({ min: 1, max: 500 })
    .withMessage("Radius must be between 1 and 500 meters"),
  body("capacity")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Capacity must be at least 1"),
  validate,
  adminController.createClassroom,
);

/**
 * @route   GET /api/v1/admin/classrooms/:classroomId
 * @desc    Get classroom details
 * @access  Private (Admin only)
 */
router.get(
  "/classrooms/:classroomId",
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  validate,
  async (req, res, next) => {
    try {
      const { classroomId } = req.params;
      const classroom = await prisma.classroom.findUnique({
        where: { id: classroomId },
        include: {
          _count: {
            select: { sessions: true },
          },
        },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      const activeSessions = await prisma.session.count({
        where: { classroomId, status: "active" },
      });

      const totalCheckins = await prisma.roomCheckin.count({
        where: { session: { classroomId } },
      });

      // Get usage statistics by month
      const monthlyUsage = await prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', started_at) as month,
          COUNT(*) as session_count
        FROM sessions
        WHERE classroom_id = ${classroomId}
        GROUP BY DATE_TRUNC('month', started_at)
        ORDER BY month DESC
        LIMIT 6
      `;

      res.json({
        success: true,
        data: {
          ...classroom,
          statistics: {
            totalSessions: classroom._count.sessions,
            activeSessions,
            totalCheckins,
            utilizationRate:
              classroom._count.sessions > 0
                ? (activeSessions / classroom._count.sessions) * 100
                : 0,
          },
          monthlyUsage,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   PATCH /api/v1/admin/classrooms/:classroomId
 * @desc    Update classroom
 * @access  Private (Admin only)
 */
router.patch(
  "/classrooms/:classroomId",
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  body("name").optional().isString().trim().isLength({ min: 2, max: 100 }),
  body("building").optional().isString().trim(),
  body("code").optional().isString().trim(),
  body("capacity").optional().isInt({ min: 1 }),
  body("latitude").optional().isFloat({ min: -90, max: 90 }),
  body("longitude").optional().isFloat({ min: -180, max: 180 }),
  body("radiusM").optional().isInt({ min: 1, max: 500 }),
  body("isActive").optional().isBoolean(),
  validate,
  adminController.updateClassroom,
);

/**
 * @route   DELETE /api/v1/admin/classrooms/:classroomId
 * @desc    Deactivate classroom
 * @access  Private (Admin only)
 */
router.delete(
  "/classrooms/:classroomId",
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  query("force").optional().isBoolean().toBoolean(),
  validate,
  adminController.deleteClassroom,
);

// ==================== SYSTEM CONFIGURATION ====================

/**
 * @route   GET /api/v1/admin/config
 * @desc    Get system configuration
 * @access  Private (Admin only)
 */
router.get("/config", adminController.getSystemConfig);

/**
 * @route   PUT /api/v1/admin/config
 * @desc    Update system configuration
 * @access  Private (Admin only)
 */
router.put(
  "/config",
  body("defaultGeofenceRadiusM")
    .optional()
    .isInt({ min: 1, max: 500 })
    .withMessage("Default geofence radius must be between 1 and 500 meters"),
  body("sessionCodeTtlMinutes")
    .optional()
    .isInt({ min: 15, max: 240 })
    .withMessage("Session TTL must be between 15 and 240 minutes"),
  body("consecutiveAbsenceWarningThreshold")
    .optional()
    .isInt({ min: 1, max: 10 })
    .withMessage("Warning threshold must be between 1 and 10"),
  body("smsEnabled").optional().isBoolean(),
  body("emailNotificationsEnabled").optional().isBoolean(),
  body("pushNotificationsEnabled").optional().isBoolean(),
  body("maxConcurrentSessionsPerLecturer")
    .optional()
    .isInt({ min: 1, max: 20 })
    .withMessage("Max concurrent sessions must be between 1 and 20"),
  body("maxDevicesPerUser")
    .optional()
    .isInt({ min: 1, max: 10 })
    .withMessage("Max devices per user must be between 1 and 10"),
  body("checkinGracePeriodMinutes")
    .optional()
    .isInt({ min: 0, max: 60 })
    .withMessage("Grace period must be between 0 and 60 minutes"),
  validate,
  adminController.updateSystemConfig,
);

/**
 * @route   GET /api/v1/admin/system/stats
 * @desc    Get real-time system health stats
 * @access  Private (Admin only)
 */
router.get("/system/stats", adminController.getSystemStats);

/**
 * @route   GET /api/v1/admin/system/overview
 * @desc    Get system overview analytics
 * @access  Private (Admin only)
 */
router.get("/system/overview", adminController.getSystemOverview);

/**
 * @route   GET /api/v1/admin/audit-logs
 * @desc    Get system audit logs
 * @access  Private (Admin only)
 */
router.get(
  "/audit-logs",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("userId").optional().isUUID(),
  query("action").optional().isString(),
  query("entity").optional().isString(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  validate,
  adminController.getAuditLogs,
);

// ==================== REPORTS (Admin) ====================

/**
 * @route   GET /api/v1/admin/reports/course-attendance
 * @desc    Generate course attendance report
 * @access  Private (Admin only)
 */
router.get(
  "/reports/course-attendance",
  query("courseId").isUUID().withMessage("Course ID is required"),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  query("includeStudents").optional().isBoolean(),
  validate,
  reportController.generateCourseAttendanceReport.bind(reportController),
);

/**
 * @route   GET /api/v1/admin/reports/student-attendance
 * @desc    Generate student attendance report
 * @access  Private (Admin only)
 */
router.get(
  "/reports/student-attendance",
  query("studentId").isUUID().withMessage("Student ID is required"),
  query("courseId").optional().isUUID(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateStudentAttendanceReport.bind(reportController),
);

/**
 * @route   GET /api/v1/admin/reports/lecturer-summary
 * @desc    Generate lecturer summary report
 * @access  Private (Admin only)
 */
router.get(
  "/reports/lecturer-summary",
  query("lecturerId").optional().isUUID(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateLecturerSummaryReport.bind(reportController),
);

/**
 * @route   GET /api/v1/admin/reports/system-analytics
 * @desc    Generate system analytics report
 * @access  Private (Admin only)
 */
router.get(
  "/reports/system-analytics",
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("period").optional().isIn(["weekly", "monthly", "yearly"]),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateSystemAnalyticsReport.bind(reportController),
);

/**
 * @route   GET /api/v1/admin/reports/at-risk-students
 * @desc    Generate at-risk students report
 * @access  Private (Admin only)
 */
router.get(
  "/reports/at-risk-students",
  query("courseId").optional().isUUID(),
  query("threshold").optional().isInt({ min: 0, max: 100 }).toInt(),
  query("consecutiveAbsences").optional().isInt({ min: 1, max: 10 }).toInt(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateAtRiskReport.bind(reportController),
);

/**
 * @route   POST /api/v1/admin/reports/send
 * @desc    Send report via email
 * @access  Private (Admin only)
 */
router.post(
  "/reports/send",
  body("reportType")
    .isIn([
      "course_attendance",
      "student_attendance",
      "lecturer_summary",
      "system_analytics",
      "at_risk",
    ])
    .withMessage("Invalid report type"),
  body("recipientEmail")
    .isEmail()
    .withMessage("Valid recipient email is required"),
  body("format").optional().isIn(["pdf", "csv"]),
  body("courseId").optional().isUUID(),
  body("studentId").optional().isUUID(),
  body("lecturerId").optional().isUUID(),
  body("from").optional().isISO8601(),
  body("to").optional().isISO8601(),
  body("threshold").optional().isInt({ min: 0, max: 100 }).toInt(),
  validate,
  reportController.sendReportByEmail.bind(reportController),
);

// ==================== DASHBOARD & ANALYTICS ====================

/**
 * @route   GET /api/v1/admin/dashboard
 * @desc    Get admin dashboard data
 * @access  Private (Admin only)
 */
router.get("/dashboard", async (req, res, next) => {
  try {
    const [
      totalUsers,
      activeUsers,
      totalCourses,
      activeCourses,
      totalSessions,
      activeSessions,
      totalCheckinsToday,
      totalStudents,
      totalLecturers,
      totalDevices,
      pendingImports,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.course.count(),
      prisma.course.count({ where: { isActive: true } }),
      prisma.session.count(),
      prisma.session.count({ where: { status: "active" } }),
      prisma.roomCheckin.count({
        where: {
          checkedInAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      prisma.user.count({ where: { role: "student", isActive: true } }),
      prisma.user.count({ where: { role: "lecturer", isActive: true } }),
      prisma.device.count({ where: { isActive: true } }),
      prisma.bulkImportJob.count({ where: { status: "pending" } }),
    ]);

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weeklyActiveUsers = await prisma.user.count({
      where: { lastLoginAt: { gte: weekAgo } },
    });

    const recentSessions = await prisma.session.findMany({
      take: 5,
      orderBy: { startedAt: "desc" },
      include: {
        course: { select: { name: true, code: true } },
        _count: { select: { roomCheckins: true } },
      },
    });

    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          students: totalStudents,
          lecturers: totalLecturers,
          weeklyActive: weeklyActiveUsers,
          totalDevices,
        },
        academics: {
          totalCourses,
          activeCourses,
          totalSessions,
          activeSessions,
        },
        attendance: {
          todayCheckins: totalCheckinsToday,
        },
        system: {
          pendingImports,
        },
        recentActivity: recentSessions.map((session) => ({
          id: session.id,
          sessionCode: session.sessionCode,
          courseName: session.course.name,
          date: session.startedAt,
          checkins: session._count.roomCheckins,
          status: session.status,
        })),
        timestamp: new Date(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ==================== BULK OPERATIONS ====================

/**
 * @route   POST /api/v1/admin/bulk/enroll
 * @desc    Bulk enroll students across multiple courses
 * @access  Private (Admin only)
 */
router.post(
  "/bulk/enroll",
  body("enrollments")
    .isArray({ min: 1 })
    .withMessage("At least one enrollment is required"),
  body("enrollments.*.studentId")
    .isUUID()
    .withMessage("Invalid student ID format"),
  body("enrollments.*.courseId")
    .isUUID()
    .withMessage("Invalid course ID format"),
  validate,
  async (req, res, next) => {
    try {
      const { enrollments } = req.body;
      const results = {
        successful: [],
        failed: [],
      };

      for (const enrollment of enrollments) {
        try {
          const result = await prisma.enrollment.create({
            data: {
              studentId: enrollment.studentId,
              courseId: enrollment.courseId,
              isActive: true,
            },
            include: {
              student: { select: { fullName: true, email: true } },
              course: { select: { code: true, name: true } },
            },
          });
          results.successful.push(result);
        } catch (error) {
          results.failed.push({
            ...enrollment,
            error: error.code === "P2002" ? "Already enrolled" : error.message,
          });
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_ENROLLMENT",
          entity: "Enrollment",
          newValues: {
            total: enrollments.length,
            successful: results.successful.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: {
          total: enrollments.length,
          successful: results.successful.length,
          failed: results.failed.length,
          details: {
            successful: results.successful.slice(0, 10),
            failed: results.failed.slice(0, 10),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   POST /api/v1/admin/bulk/deactivate-users
 * @desc    Bulk deactivate users
 * @access  Private (Admin only)
 */
router.post(
  "/bulk/deactivate-users",
  body("userIds")
    .isArray({ min: 1 })
    .withMessage("At least one user ID is required"),
  body("userIds.*").isUUID().withMessage("Invalid user ID format"),
  validate,
  async (req, res, next) => {
    try {
      const { userIds } = req.body;

      const result = await prisma.user.updateMany({
        where: {
          id: { in: userIds },
          role: { not: "admin" },
        },
        data: { isActive: false },
      });

      await prisma.refreshToken.updateMany({
        where: { userId: { in: userIds }, revoked: false },
        data: { revoked: true },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_DEACTIVATE_USERS",
          entity: "User",
          newValues: { count: result.count },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: {
          deactivatedCount: result.count,
          message: `${result.count} users deactivated successfully`,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   POST /api/v1/admin/bulk/delete-sessions
 * @desc    Bulk delete old sessions
 * @access  Private (Admin only)
 */
router.post(
  "/bulk/delete-sessions",
  body("olderThanDays")
    .isInt({ min: 30, max: 365 })
    .withMessage("Older than days must be between 30 and 365"),
  body("confirm").notEmpty().withMessage("Confirmation required"),
  validate,
  async (req, res, next) => {
    try {
      const { olderThanDays, confirm } = req.body;

      if (confirm !== "CONFIRM_DELETE") {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Please confirm deletion with 'confirm': 'CONFIRM_DELETE'",
          },
        });
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const deletedSessions = await prisma.session.deleteMany({
        where: {
          status: "closed",
          closedAt: { lt: cutoffDate },
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_DELETE_SESSIONS",
          entity: "Session",
          newValues: { count: deletedSessions.count, olderThanDays },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: {
          deletedCount: deletedSessions.count,
          message: `${deletedSessions.count} old sessions deleted successfully`,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ==================== EXPORT ROUTES ====================

/**
 * @route   GET /api/v1/admin/export/users
 * @desc    Export users to CSV/JSON
 * @access  Private (Admin only)
 */
router.get(
  "/export/users",
  query("role").optional().isIn(["student", "lecturer", "admin"]),
  query("format").optional().isIn(["csv", "json"]),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const { role, format = "csv", from, to } = req.query;

      const where = {};
      if (role) where.role = role;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      const users = await prisma.user.findMany({
        where,
        select: {
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          staffNumber: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      if (format === "json") {
        return res.json({
          success: true,
          data: users,
          total: users.length,
          filters: { role, from, to },
        });
      }

      const csvRows = [
        [
          "Full Name",
          "Email",
          "Phone",
          "Role",
          "Reg Number",
          "Staff Number",
          "Active",
          "Last Login",
          "Created At",
        ],
      ];

      for (const user of users) {
        csvRows.push([
          `"${user.fullName.replace(/"/g, '""')}"`,
          user.email,
          user.phone || "",
          user.role,
          user.regNumber || "",
          user.staffNumber || "",
          user.isActive ? "Yes" : "No",
          user.lastLoginAt ? user.lastLoginAt.toISOString() : "",
          user.createdAt.toISOString(),
        ]);
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=users_export_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   GET /api/v1/admin/export/attendance
 * @desc    Export attendance records
 * @access  Private (Admin only)
 */
router.get(
  "/export/attendance",
  query("courseId").optional().isUUID(),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("format").optional().isIn(["csv", "json"]),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, from, to, format = "csv" } = req.query;

      const where = {};
      if (courseId) where.session = { courseId };
      if (from || to) {
        where.markedAt = {};
        if (from) where.markedAt.gte = new Date(from);
        if (to) where.markedAt.lte = new Date(to);
      }

      const records = await prisma.attendanceRecord.findMany({
        where,
        include: {
          student: {
            select: {
              fullName: true,
              email: true,
              regNumber: true,
            },
          },
          session: {
            select: {
              sessionCode: true,
              course: { select: { name: true, code: true } },
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
          "Student Name",
          "Registration Number",
          "Email",
          "Course",
          "Session Code",
          "Status",
          "Method",
          "Distance (m)",
        ],
      ];

      for (const record of records) {
        csvRows.push([
          record.markedAt.toISOString(),
          `"${record.student.fullName.replace(/"/g, '""')}"`,
          record.student.regNumber || "",
          record.student.email,
          `${record.session.course.code} - ${record.session.course.name}`,
          record.session.sessionCode,
          record.status,
          record.submissionMethod || "",
          record.distanceM || "",
        ]);
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=attendance_export_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
