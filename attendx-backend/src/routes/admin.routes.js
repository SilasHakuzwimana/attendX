const express = require("express");
const { body, param, query } = require("express-validator");
const multer = require("multer");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const adminController = require("../controllers/admin.controller");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// All admin routes require authentication and admin role
router.use(authenticateToken, requireRole("admin"));

// ==================== USER MANAGEMENT ====================

/**
 * @route   GET /api/admin/users
 * @desc    List all users
 * @access  Private (Admin only)
 */
router.get(
  "/users",
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("role").optional().isIn(["student", "lecturer", "admin"]),
  query("search").optional().isString(),
  query("isActive").optional().isBoolean(),
  validate,
  adminController.listUsers,
);

/**
 * @route   POST /api/admin/users
 * @desc    Create new user
 * @access  Private (Admin only)
 */
router.post(
  "/users",
  body("fullName").notEmpty().trim().withMessage("Full name is required"),
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Valid email is required"),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
  body("role")
    .isIn(["student", "lecturer", "admin"])
    .withMessage("Valid role is required"),
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  body("regNumber").optional().isString(),
  validate,
  adminController.createUser,
);

/**
 * @route   POST /api/admin/users/bulk-import
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
 * @route   GET /api/admin/users/:userId
 * @desc    Get user by ID
 * @access  Private (Admin only)
 */
router.get(
  "/users/:userId",
  param("userId").isUUID(),
  validate,
  adminController.getUser,
);

/**
 * @route   PATCH /api/admin/users/:userId
 * @desc    Update user
 * @access  Private (Admin only)
 */
router.patch(
  "/users/:userId",
  param("userId").isUUID(),
  body("fullName").optional().isString().trim(),
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/),
  body("isActive").optional().isBoolean(),
  validate,
  adminController.updateUser,
);

/**
 * @route   DELETE /api/admin/users/:userId
 * @desc    Deactivate user (soft delete)
 * @access  Private (Admin only)
 */
router.delete(
  "/users/:userId",
  param("userId").isUUID(),
  validate,
  adminController.deactivateUser,
);

// ==================== COURSE MANAGEMENT ====================

/**
 * @route   GET /api/admin/courses
 * @desc    List all courses
 * @access  Private (Admin only)
 */
router.get(
  "/courses",
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("search").optional().isString(),
  query("lecturerId").optional().isUUID(),
  validate,
  adminController.listCourses,
);

/**
 * @route   POST /api/admin/courses
 * @desc    Create new course
 * @access  Private (Admin only)
 */
router.post(
  "/courses",
  body("code").notEmpty().trim().withMessage("Course code is required"),
  body("name").notEmpty().trim().withMessage("Course name is required"),
  body("lecturerId").isUUID().withMessage("Valid lecturer ID is required"),
  body("credits").optional().isInt({ min: 1, max: 6 }),
  body("semester").optional().isString(),
  body("description").optional().isString(),
  validate,
  adminController.createCourse,
);

/**
 * @route   PATCH /api/admin/courses/:courseId
 * @desc    Update course
 * @access  Private (Admin only)
 */
router.patch(
  "/courses/:courseId",
  param("courseId").isUUID(),
  body("name").optional().isString().trim(),
  body("lecturerId").optional().isUUID(),
  body("credits").optional().isInt({ min: 1, max: 6 }),
  body("isActive").optional().isBoolean(),
  validate,
  adminController.updateCourse,
);

/**
 * @route   DELETE /api/admin/courses/:courseId
 * @desc    Deactivate course
 * @access  Private (Admin only)
 */
router.delete(
  "/courses/:courseId",
  param("courseId").isUUID(),
  validate,
  adminController.deactivateCourse,
);

/**
 * @route   POST /api/admin/courses/:courseId/enroll
 * @desc    Enroll students in course
 * @access  Private (Admin only)
 */
router.post(
  "/courses/:courseId/enroll",
  param("courseId").isUUID(),
  body("studentIds")
    .isArray({ min: 1 })
    .withMessage("At least one student ID is required"),
  body("studentIds.*").isUUID(),
  validate,
  adminController.enrollStudents,
);

/**
 * @route   DELETE /api/admin/courses/:courseId/enroll/:studentId
 * @desc    Remove student from course
 * @access  Private (Admin only)
 */
router.delete(
  "/courses/:courseId/enroll/:studentId",
  param("courseId").isUUID(),
  param("studentId").isUUID(),
  validate,
  adminController.removeStudent,
);

/**
 * @route   GET /api/admin/courses/:courseId/students
 * @desc    List enrolled students for a course
 * @access  Private (Admin only)
 */
router.get(
  "/courses/:courseId/students",
  param("courseId").isUUID(),
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  validate,
  async (req, res, next) => {
    try {
      const { courseId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const skip = (page - 1) * limit;

      const [enrollments, total] = await Promise.all([
        global.prisma.enrollment.findMany({
          where: { courseId },
          include: {
            student: {
              select: {
                id: true,
                fullName: true,
                email: true,
                regNumber: true,
                phone: true,
              },
            },
          },
          skip: parseInt(skip),
          take: parseInt(limit),
        }),
        global.prisma.enrollment.count({ where: { courseId } }),
      ]);

      res.json({
        success: true,
        data: enrollments,
        meta: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ==================== CLASSROOM MANAGEMENT ====================

/**
 * @route   GET /api/admin/classrooms
 * @desc    List all classrooms
 * @access  Private (Admin only)
 */
router.get(
  "/classrooms",
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  validate,
  adminController.listClassrooms,
);

/**
 * @route   POST /api/admin/classrooms
 * @desc    Create classroom with geofence config
 * @access  Private (Admin only)
 */
router.post(
  "/classrooms",
  body("name").notEmpty().trim().withMessage("Classroom name is required"),
  body("latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("Valid latitude is required"),
  body("longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("Valid longitude is required"),
  body("radiusM")
    .isFloat({ min: 1, max: 500 })
    .withMessage("Radius must be between 1 and 500 meters"),
  body("building").optional().isString(),
  body("capacity").optional().isInt({ min: 1 }),
  validate,
  adminController.createClassroom,
);

/**
 * @route   GET /api/admin/classrooms/:classroomId
 * @desc    Get classroom details
 * @access  Private (Admin only)
 */
router.get(
  "/classrooms/:classroomId",
  param("classroomId").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { classroomId } = req.params;
      const classroom = await global.prisma.classroom.findUnique({
        where: { id: classroomId },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      res.json({ success: true, data: classroom });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   PATCH /api/admin/classrooms/:classroomId
 * @desc    Update classroom
 * @access  Private (Admin only)
 */
router.patch(
  "/classrooms/:classroomId",
  param("classroomId").isUUID(),
  body("name").optional().isString().trim(),
  body("building").optional().isString(),
  body("capacity").optional().isInt({ min: 1 }),
  body("latitude").optional().isFloat({ min: -90, max: 90 }),
  body("longitude").optional().isFloat({ min: -180, max: 180 }),
  body("radiusM").optional().isFloat({ min: 1, max: 500 }),
  validate,
  adminController.updateClassroom,
);

/**
 * @route   DELETE /api/admin/classrooms/:classroomId
 * @desc    Deactivate classroom
 * @access  Private (Admin only)
 */
router.delete(
  "/classrooms/:classroomId",
  param("classroomId").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { classroomId } = req.params;

      await global.prisma.classroom.update({
        where: { id: classroomId },
        data: { isActive: false },
      });

      res.json({ success: true, data: { message: "Classroom deactivated" } });
    } catch (error) {
      next(error);
    }
  },
);

// ==================== SYSTEM CONFIGURATION ====================

/**
 * @route   GET /api/admin/system/config
 * @desc    Get system configuration
 * @access  Private (Admin only)
 */
router.get("/system/config", adminController.getSystemConfig);

/**
 * @route   PUT /api/admin/system/config
 * @desc    Update system configuration
 * @access  Private (Admin only)
 */
router.put(
  "/system/config",
  body("defaultGeofenceRadiusM").optional().isFloat({ min: 1, max: 500 }),
  body("sessionCodeTtlMinutes").optional().isInt({ min: 15, max: 240 }),
  body("consecutiveAbsenceWarningThreshold")
    .optional()
    .isInt({ min: 1, max: 10 }),
  body("smsEnabled").optional().isBoolean(),
  body("emailNotificationsEnabled").optional().isBoolean(),
  body("pushNotificationsEnabled").optional().isBoolean(),
  validate,
  adminController.updateSystemConfig,
);

/**
 * @route   GET /api/admin/system/stats
 * @desc    Get real-time system health stats
 * @access  Private (Admin only)
 */
router.get("/system/stats", adminController.getSystemStats);

/**
 * @route   GET /api/admin/system/audit-logs
 * @desc    Get system audit logs
 * @access  Private (Admin only)
 */
router.get(
  "/system/audit-logs",
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("userId").optional().isUUID(),
  query("action").optional().isString(),
  query("from").optional().isDate(),
  query("to").optional().isDate(),
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 50, userId, action, from, to } = req.query;
      const skip = (page - 1) * limit;

      const where = {};
      if (userId) where.userId = userId;
      if (action) where.action = { contains: action, mode: "insensitive" };
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      // Note: You need to create an AuditLog model in Prisma
      // This is a placeholder - implement based on your logging system
      const logs = [];
      const total = 0;

      res.json({
        success: true,
        data: logs,
        meta: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
