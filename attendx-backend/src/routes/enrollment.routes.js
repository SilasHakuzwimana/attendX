const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const enrollmentController = require("../controllers/enrollment.controller");

const router = express.Router();

// =====================================================
// ENROLLMENT QUERY ROUTES
// =====================================================

/**
 * @route   GET /api/v1/enrollments
 * @desc    Get all enrollments with filtering
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/",
  authenticateToken,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("courseId").optional().isUUID().withMessage("Invalid course ID"),
  query("studentId").optional().isUUID().withMessage("Invalid student ID"),
  query("isActive").optional().isBoolean().toBoolean(),
  query("semester").optional().isInt({ min: 1, max: 2 }).toInt(),
  query("academicYear").optional().isString(),
  query("sortBy").optional().isIn(["enrolledAt", "studentId", "courseId"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  enrollmentController.getEnrollments.bind(enrollmentController),
);

/**
 * @route   GET /api/v1/enrollments/check
 * @desc    Check if student is enrolled in course
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/check",
  authenticateToken,
  query("studentId").isUUID().withMessage("Student ID is required"),
  query("courseId").isUUID().withMessage("Course ID is required"),
  validate,
  enrollmentController.checkEnrollment.bind(enrollmentController),
);

/**
 * @route   GET /api/v1/enrollments/:enrollmentId
 * @desc    Get single enrollment by ID
 * @access  Private (Student, Lecturer, Admin with access)
 */
router.get(
  "/:enrollmentId",
  authenticateToken,
  param("enrollmentId").isUUID().withMessage("Invalid enrollment ID"),
  validate,
  enrollmentController.getEnrollmentById.bind(enrollmentController),
);

// =====================================================
// ENROLLMENT CREATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/enrollments
 * @desc    Enroll student in course (Admin/Lecturer)
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("studentId").isUUID().withMessage("Valid student ID is required"),
  body("courseId").isUUID().withMessage("Valid course ID is required"),
  validate,
  enrollmentController.createEnrollment.bind(enrollmentController),
);

/**
 * @route   POST /api/v1/enrollments/bulk
 * @desc    Bulk enroll students in course (Admin/Lecturer)
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/bulk",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("courseId").isUUID().withMessage("Valid course ID is required"),
  body("studentIds")
    .isArray({ min: 1 })
    .withMessage("At least one student ID is required"),
  body("studentIds.*").isUUID().withMessage("Invalid student ID format"),
  validate,
  enrollmentController.bulkEnroll.bind(enrollmentController),
);

// =====================================================
// ENROLLMENT UPDATE ROUTES
// =====================================================

/**
 * @route   PUT /api/v1/enrollments/:enrollmentId
 * @desc    Update enrollment (Admin/Lecturer)
 * @access  Private (Lecturer or Admin)
 */
router.put(
  "/:enrollmentId",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("enrollmentId").isUUID().withMessage("Invalid enrollment ID"),
  body("isActive").optional().isBoolean(),
  body("notes").optional().isString().trim(),
  validate,
  enrollmentController.updateEnrollment.bind(enrollmentController),
);

/**
 * @route   DELETE /api/v1/enrollments/:enrollmentId
 * @desc    Delete/Drop enrollment (Admin/Lecturer or Student self-drop)
 * @access  Private (Student, Lecturer, Admin)
 */
router.delete(
  "/:enrollmentId",
  authenticateToken,
  param("enrollmentId").isUUID().withMessage("Invalid enrollment ID"),
  validate,
  enrollmentController.deleteEnrollment.bind(enrollmentController),
);

// =====================================================
// ENROLLMENT STATISTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/enrollments/statistics/course/:courseId
 * @desc    Get enrollment statistics for a course
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/statistics/course/:courseId",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  validate,
  enrollmentController.getCourseEnrollmentStats.bind(enrollmentController),
);

/**
 * @route   GET /api/v1/enrollments/student/:studentId/summary
 * @desc    Get student's enrollment summary
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/student/:studentId/summary",
  authenticateToken,
  param("studentId").isUUID().withMessage("Invalid student ID"),
  validate,
  enrollmentController.getStudentEnrollmentSummary.bind(enrollmentController),
);

// =====================================================
// ENROLLMENT EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/enrollments/export
 * @desc    Export enrollments to CSV (Admin/Lecturer)
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/export",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("format").optional().isIn(["csv", "json"]),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, format = "csv", from, to } = req.query;

      const where = { isActive: true };
      if (courseId) where.courseId = courseId;
      if (from || to) {
        where.enrolledAt = {};
        if (from) where.enrolledAt.gte = new Date(from);
        if (to) where.enrolledAt.lte = new Date(to);
      }

      // Role-based filtering
      if (req.user.role === "lecturer" && !courseId) {
        const courses = await prisma.course.findMany({
          where: { lecturerId: req.user.id },
          select: { id: true },
        });
        const courseIds = courses.map((c) => c.id);
        if (courseIds.length > 0) {
          where.courseId = { in: courseIds };
        } else {
          return res.json({ success: true, data: [], total: 0 });
        }
      }

      const enrollments = await prisma.enrollment.findMany({
        where,
        include: {
          student: {
            select: {
              fullName: true,
              email: true,
              regNumber: true,
              phone: true,
            },
          },
          course: {
            select: {
              code: true,
              name: true,
              credits: true,
            },
          },
        },
        orderBy: { enrolledAt: "desc" },
      });

      if (format === "json") {
        return res.json({
          success: true,
          data: enrollments,
          total: enrollments.length,
        });
      }

      const csvRows = [
        [
          "Student Name",
          "Registration Number",
          "Email",
          "Phone",
          "Course Code",
          "Course Name",
          "Credits",
          "Enrolled At",
          "Status",
        ],
      ];

      for (const enrollment of enrollments) {
        csvRows.push([
          `"${enrollment.student.fullName.replace(/"/g, '""')}"`,
          enrollment.student.regNumber || "",
          enrollment.student.email,
          enrollment.student.phone || "",
          enrollment.course.code,
          `"${enrollment.course.name.replace(/"/g, '""')}"`,
          enrollment.course.credits,
          enrollment.enrolledAt.toISOString(),
          enrollment.isActive ? "Active" : "Dropped",
        ]);
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=enrollments_export_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      logger.error("Export enrollments error:", error);
      next(error);
    }
  },
);

// =====================================================
// ENROLLMENT BULK UPDATE ROUTES
// =====================================================

/**
 * @route   POST /api/v1/enrollments/bulk/update
 * @desc    Bulk update enrollment statuses (Admin/Lecturer)
 * @access  Private (Admin only)
 */
router.post(
  "/bulk/update",
  authenticateToken,
  requireRole("admin"),
  body("updates")
    .isArray({ min: 1 })
    .withMessage("At least one update is required"),
  body("updates.*.enrollmentId").isUUID().withMessage("Invalid enrollment ID"),
  body("updates.*.isActive")
    .isBoolean()
    .withMessage("isActive must be boolean"),
  validate,
  async (req, res, next) => {
    try {
      const { updates } = req.body;
      const results = {
        successful: [],
        failed: [],
      };

      for (const update of updates) {
        try {
          const enrollment = await prisma.enrollment.update({
            where: { id: update.enrollmentId },
            data: {
              isActive: update.isActive,
              ...(update.isActive === false && { droppedAt: new Date() }),
              ...(update.isActive === true && { droppedAt: null }),
            },
            include: {
              student: { select: { fullName: true, email: true } },
              course: { select: { code: true, name: true } },
            },
          });

          results.successful.push(enrollment);

          // Send notification if dropping
          if (update.isActive === false) {
            await sendEmail(
              enrollment.student.email,
              "Course Drop Notification - AttendX",
              `<p>You have been dropped from ${enrollment.course.name} (${enrollment.course.code})</p>`,
            );
          }
        } catch (error) {
          results.failed.push({
            enrollmentId: update.enrollmentId,
            error: error.message,
          });
        }
      }

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const uniqueStudentIds = [
          ...new Set(results.successful.map((s) => s.studentId)),
        ];
        const uniqueCourseIds = [
          ...new Set(results.successful.map((s) => s.courseId)),
        ];

        for (const studentId of uniqueStudentIds) {
          await redisClient.del(`student:courses:${studentId}`);
          await redisClient.del(`student:dashboard:${studentId}`);
        }
        for (const courseId of uniqueCourseIds) {
          await redisClient.del(`course:${courseId}`);
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_UPDATE_ENROLLMENTS",
          entity: "Enrollment",
          newValues: {
            total: updates.length,
            successful: results.successful.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: {
          total: updates.length,
          successful: results.successful.length,
          failed: results.failed.length,
          details: {
            successful: results.successful.slice(0, 20),
            failed: results.failed.slice(0, 20),
          },
        },
      });
    } catch (error) {
      logger.error("Bulk update enrollments error:", error);
      next(error);
    }
  },
);

/**
 * @route   POST /api/v1/enrollments/bulk/delete
 * @desc    Bulk delete enrollments (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/bulk/delete",
  authenticateToken,
  requireRole("admin"),
  body("enrollmentIds")
    .isArray({ min: 1 })
    .withMessage("At least one enrollment ID is required"),
  body("enrollmentIds.*").isUUID().withMessage("Invalid enrollment ID"),
  body("confirm").equals("CONFIRM_DELETE").withMessage("Confirmation required"),
  validate,
  async (req, res, next) => {
    try {
      const { enrollmentIds } = req.body;

      const result = await prisma.enrollment.updateMany({
        where: {
          id: { in: enrollmentIds },
          isActive: true,
        },
        data: {
          isActive: false,
          droppedAt: new Date(),
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_DELETE_ENROLLMENTS",
          entity: "Enrollment",
          newValues: { count: result.count },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const affectedEnrollments = await prisma.enrollment.findMany({
          where: { id: { in: enrollmentIds } },
          select: { studentId: true, courseId: true },
        });

        for (const enrollment of affectedEnrollments) {
          await redisClient.del(`student:courses:${enrollment.studentId}`);
          await redisClient.del(`student:dashboard:${enrollment.studentId}`);
          await redisClient.del(`course:${enrollment.courseId}`);
        }
      }

      logger.info(
        `Bulk deleted ${result.count} enrollments by ${req.user.email}`,
      );

      res.json({
        success: true,
        data: {
          deletedCount: result.count,
          message: `${result.count} enrollments deleted successfully`,
        },
      });
    } catch (error) {
      logger.error("Bulk delete enrollments error:", error);
      next(error);
    }
  },
);

// =====================================================
// ENROLLMENT ANALYTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/enrollments/analytics/overview
 * @desc    Get enrollment analytics overview (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/analytics/overview",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const [
        totalEnrollments,
        activeEnrollments,
        droppedEnrollments,
        averagePerCourse,
        topCourses,
      ] = await Promise.all([
        prisma.enrollment.count(),
        prisma.enrollment.count({ where: { isActive: true } }),
        prisma.enrollment.count({ where: { isActive: false } }),
        prisma.$queryRaw`
          SELECT AVG(enrollment_count) as average
          FROM (
            SELECT COUNT(*) as enrollment_count
            FROM enrollments
            WHERE is_active = true
            GROUP BY course_id
          ) as course_counts
        `,
        prisma.course.findMany({
          where: { isActive: true },
          include: {
            _count: {
              select: { enrollments: { where: { isActive: true } } },
            },
          },
          orderBy: { enrollments: { _count: "desc" } },
          take: 5,
        }),
      ]);

      res.json({
        success: true,
        data: {
          totalEnrollments,
          activeEnrollments,
          droppedEnrollments,
          retentionRate:
            totalEnrollments > 0
              ? (activeEnrollments / totalEnrollments) * 100
              : 0,
          averagePerCourse: parseFloat(averagePerCourse[0]?.average || 0),
          topCourses: topCourses.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            enrollmentCount: c._count.enrollments,
          })),
        },
      });
    } catch (error) {
      logger.error("Get enrollment analytics error:", error);
      next(error);
    }
  },
);

module.exports = router;
