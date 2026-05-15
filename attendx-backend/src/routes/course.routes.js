const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const courseController = require("../controllers/course.controller");

const router = express.Router();

// =====================================================
// PUBLIC COURSE ROUTES (Authenticated Users)
// =====================================================

/**
 * @route   GET /api/v1/courses
 * @desc    Get all courses (filtered by role)
 * @access  Private (All authenticated users)
 */
router.get(
  "/",
  authenticateToken,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("semester").optional().isInt({ min: 1, max: 2 }).toInt(),
  query("academicYear").optional().isString(),
  query("isActive").optional().isBoolean().toBoolean(),
  query("sortBy").optional().isIn(["createdAt", "code", "name", "credits"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  courseController.getCourses.bind(courseController),
);

/**
 * @route   GET /api/v1/courses/list
 * @desc    Get courses for dropdown/select inputs
 * @access  Private (All authenticated users)
 */
router.get(
  "/list",
  authenticateToken,
  courseController.getCourseList.bind(courseController),
);

/**
 * @route   GET /api/v1/courses/:courseId
 * @desc    Get single course by ID with full details
 * @access  Private (All authenticated users with access)
 */
router.get(
  "/:courseId",
  authenticateToken,
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  validate,
  courseController.getCourseById.bind(courseController),
);

/**
 * @route   GET /api/v1/courses/:courseId/enrollments
 * @desc    Get course enrollments with student details
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/:courseId/enrollments",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("attendanceBelow").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("attendanceAbove").optional().isFloat({ min: 0, max: 100 }).toFloat(),
  query("sortBy")
    .optional()
    .isIn(["fullName", "regNumber", "email", "enrolledAt"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  courseController.getCourseEnrollments.bind(courseController),
);

/**
 * @route   GET /api/v1/courses/:courseId/statistics
 * @desc    Get course statistics (attendance trends)
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/:courseId/statistics",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  query("period").optional().isIn(["daily", "weekly", "monthly"]),
  validate,
  courseController.getCourseStatistics.bind(courseController),
);

// =====================================================
// ADMIN ONLY COURSE MANAGEMENT ROUTES
// =====================================================

/**
 * @route   POST /api/v1/courses
 * @desc    Create new course (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/",
  authenticateToken,
  requireRole("admin"),
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
  body("description")
    .optional()
    .isString()
    .isLength({ max: 500 })
    .withMessage("Description cannot exceed 500 characters"),
  body("credits")
    .optional()
    .isInt({ min: 1, max: 6 })
    .withMessage("Credits must be between 1 and 6"),
  body("semester").optional().isString(),
  body("academicYear").optional().isString(),
  body("lecturerId")
    .optional()
    .isUUID()
    .withMessage("Valid lecturer ID is required"),
  validate,
  courseController.createCourse.bind(courseController),
);

/**
 * @route   PUT /api/v1/courses/:courseId
 * @desc    Update course (Admin only)
 * @access  Private (Admin only)
 */
router.put(
  "/:courseId",
  authenticateToken,
  requireRole("admin"),
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  body("code")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 3, max: 20 })
    .matches(/^[A-Za-z0-9]+$/),
  body("name").optional().isString().trim().isLength({ min: 3, max: 100 }),
  body("description").optional().isString().isLength({ max: 500 }),
  body("credits").optional().isInt({ min: 1, max: 6 }),
  body("semester").optional().isString(),
  body("academicYear").optional().isString(),
  body("lecturerId").optional().isUUID(),
  body("isActive").optional().isBoolean(),
  validate,
  courseController.updateCourse.bind(courseController),
);

/**
 * @route   DELETE /api/v1/courses/:courseId
 * @desc    Delete/Deactivate course (Admin only)
 * @access  Private (Admin only)
 */
router.delete(
  "/:courseId",
  authenticateToken,
  requireRole("admin"),
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  validate,
  courseController.deleteCourse.bind(courseController),
);

/**
 * @route   POST /api/v1/courses/:courseId/enrollments
 * @desc    Enroll students in course (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/:courseId/enrollments",
  authenticateToken,
  requireRole("admin"),
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  body("studentIds")
    .isArray({ min: 1 })
    .withMessage("At least one student ID is required"),
  body("studentIds.*").isUUID().withMessage("Invalid student ID format"),
  validate,
  courseController.enrollStudents.bind(courseController),
);

/**
 * @route   DELETE /api/v1/courses/:courseId/enrollments/:studentId
 * @desc    Remove student from course (Admin only)
 * @access  Private (Admin only)
 */
router.delete(
  "/:courseId/enrollments/:studentId",
  authenticateToken,
  requireRole("admin"),
  param("courseId").isUUID().withMessage("Invalid course ID format"),
  param("studentId").isUUID().withMessage("Invalid student ID format"),
  validate,
  courseController.removeStudent.bind(courseController),
);

// =====================================================
// COURSE REACTIVATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/courses/:courseId/activate
 * @desc    Reactivate deactivated course (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/:courseId/activate",
  authenticateToken,
  requireRole("admin"),
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

      const updatedCourse = await prisma.course.update({
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

      if (redisClient && redisClient.isReady) {
        await redisClient.del(`course:${courseId}`);
        const keys = await redisClient.keys("lecturer:dashboard:*");
        if (keys.length > 0) await redisClient.del(keys);
      }

      logger.info(`Course reactivated by ${req.user.email}: ${course.code}`);

      res.json({
        success: true,
        data: updatedCourse,
        message: "Course reactivated successfully",
      });
    } catch (error) {
      logger.error("Reactivate course error:", error);
      next(error);
    }
  },
);

// =====================================================
// COURSE ANALYTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/courses/analytics/summary
 * @desc    Get summary analytics for all courses (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/analytics/summary",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const [
        totalCourses,
        activeCourses,
        totalStudents,
        totalSessions,
        totalCheckins,
      ] = await Promise.all([
        prisma.course.count(),
        prisma.course.count({ where: { isActive: true } }),
        prisma.enrollment.count({ where: { isActive: true } }),
        prisma.session.count(),
        prisma.roomCheckin.count(),
      ]);

      const averageStudentsPerCourse =
        totalCourses > 0 ? totalStudents / totalCourses : 0;
      const averageSessionsPerCourse =
        totalCourses > 0 ? totalSessions / totalCourses : 0;
      const averageCheckinsPerSession =
        totalSessions > 0 ? totalCheckins / totalSessions : 0;

      // Get top courses by enrollment
      const topCoursesByEnrollment = await prisma.course.findMany({
        where: { isActive: true },
        include: {
          _count: {
            select: { enrollments: { where: { isActive: true } } },
          },
        },
        orderBy: { enrollments: { _count: "desc" } },
        take: 5,
      });

      res.json({
        success: true,
        data: {
          totalCourses,
          activeCourses,
          totalStudents,
          totalSessions,
          totalCheckins,
          averageStudentsPerCourse: parseFloat(
            averageStudentsPerCourse.toFixed(1),
          ),
          averageSessionsPerCourse: parseFloat(
            averageSessionsPerCourse.toFixed(1),
          ),
          averageCheckinsPerSession: parseFloat(
            averageCheckinsPerSession.toFixed(1),
          ),
          topCoursesByEnrollment: topCoursesByEnrollment.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            enrollmentCount: c._count.enrollments,
          })),
        },
      });
    } catch (error) {
      logger.error("Get course analytics summary error:", error);
      next(error);
    }
  },
);

/**
 * @route   GET /api/v1/courses/analytics/popular
 * @desc    Get most popular courses (by enrollment)
 * @access  Private (All authenticated users)
 */
router.get(
  "/analytics/popular",
  authenticateToken,
  query("limit").optional().isInt({ min: 1, max: 20 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { limit = 10 } = req.query;

      const popularCourses = await prisma.course.findMany({
        where: { isActive: true },
        include: {
          _count: {
            select: { enrollments: { where: { isActive: true } } },
          },
          lecturer: {
            select: { id: true, fullName: true },
          },
        },
        orderBy: { enrollments: { _count: "desc" } },
        take: parseInt(limit),
      });

      res.json({
        success: true,
        data: popularCourses.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          credits: c.credits,
          enrollmentCount: c._count.enrollments,
          lecturer: c.lecturer,
        })),
      });
    } catch (error) {
      logger.error("Get popular courses error:", error);
      next(error);
    }
  },
);

// =====================================================
// COURSE EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/courses/export
 * @desc    Export courses to CSV (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/export",
  authenticateToken,
  requireRole("admin"),
  query("format").optional().isIn(["csv", "json"]),
  validate,
  async (req, res, next) => {
    try {
      const { format = "csv" } = req.query;

      const courses = await prisma.course.findMany({
        where: { isActive: true },
        include: {
          lecturer: {
            select: { fullName: true, email: true },
          },
          _count: {
            select: { enrollments: true },
          },
        },
        orderBy: { code: "asc" },
      });

      if (format === "json") {
        return res.json({
          success: true,
          data: courses,
          total: courses.length,
        });
      }

      const csvRows = [
        [
          "Code",
          "Name",
          "Credits",
          "Lecturer",
          "Email",
          "Enrolled Students",
          "Semester",
          "Academic Year",
          "Created At",
        ],
      ];

      for (const course of courses) {
        csvRows.push([
          course.code,
          `"${course.name.replace(/"/g, '""')}"`,
          course.credits,
          course.lecturer?.fullName || "Not Assigned",
          course.lecturer?.email || "",
          course._count.enrollments,
          course.semester,
          course.academicYear,
          course.createdAt.toISOString(),
        ]);
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=courses_export_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      logger.error("Export courses error:", error);
      next(error);
    }
  },
);

// =====================================================
// BULK COURSE OPERATIONS (Admin only)
// =====================================================

/**
 * @route   POST /api/v1/courses/bulk
 * @desc    Bulk create courses (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/bulk",
  authenticateToken,
  requireRole("admin"),
  body("courses")
    .isArray({ min: 1 })
    .withMessage("At least one course is required"),
  body("courses.*.code")
    .notEmpty()
    .withMessage("Course code is required for each course"),
  body("courses.*.name")
    .notEmpty()
    .withMessage("Course name is required for each course"),
  body("courses.*.credits").optional().isInt({ min: 1, max: 6 }),
  validate,
  async (req, res, next) => {
    try {
      const { courses } = req.body;
      const results = {
        successful: [],
        failed: [],
      };

      for (const courseData of courses) {
        try {
          // Check if course code already exists
          const existingCourse = await prisma.course.findUnique({
            where: { code: courseData.code.toUpperCase() },
          });

          if (existingCourse) {
            results.failed.push({
              code: courseData.code,
              error: "Course code already exists",
            });
            continue;
          }

          const course = await prisma.course.create({
            data: {
              code: courseData.code.toUpperCase(),
              name: courseData.name,
              description: courseData.description,
              credits: courseData.credits || 3,
              semester:
                courseData.semester || new Date().getFullYear().toString(),
              academicYear:
                courseData.academicYear ||
                `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
              lecturerId: courseData.lecturerId,
              isActive: true,
            },
          });

          results.successful.push(course);
        } catch (error) {
          results.failed.push({
            code: courseData.code,
            error: error.message,
          });
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_CREATE_COURSES",
          entity: "Course",
          newValues: {
            total: courses.length,
            successful: results.successful.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Bulk course creation: ${results.successful.length} created, ${results.failed.length} failed by ${req.user.email}`,
      );

      res.json({
        success: true,
        data: {
          total: courses.length,
          successful: results.successful.length,
          failed: results.failed.length,
          details: {
            successful: results.successful.slice(0, 20),
            failed: results.failed.slice(0, 20),
          },
        },
      });
    } catch (error) {
      logger.error("Bulk create courses error:", error);
      next(error);
    }
  },
);

module.exports = router;
