const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const courseManagementController = require("../controllers/courseManagement.controller");

const router = express.Router();

// All routes require authentication and admin role
router.use(authenticateToken);
router.use(requireRole("admin"));

/**
 * @route   GET /api/v1/admin/courses
 * @desc    Get all courses with advanced filtering
 * @access  Private (Admin only)
 */
router.get(
  "/",
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("lecturerId").optional().isUUID(),
  query("semester").optional().isString(),
  query("academicYear").optional().isString(),
  query("isActive").optional().isBoolean().toBoolean(),
  query("sortBy").optional().isIn(["createdAt", "code", "name", "credits"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  courseManagementController.getAllCourses,
);

/**
 * @route   GET /api/v1/admin/courses/list
 * @desc    Get courses for dropdown/select inputs
 * @access  Private (Admin only)
 */
router.get(
  "/list",
  query("isActive").optional().isBoolean().toBoolean(),
  validate,
  courseManagementController.getCourseList,
);

/**
 * @route   GET /api/v1/admin/courses/:courseId
 * @desc    Get course by ID with full details
 * @access  Private (Admin only)
 */
router.get(
  "/:courseId",
  param("courseId").isUUID().withMessage("Invalid course ID"),
  validate,
  courseManagementController.getCourseById,
);

/**
 * @route   GET /api/v1/admin/courses/:courseId/statistics
 * @desc    Get course statistics
 * @access  Private (Admin only)
 */
router.get(
  "/:courseId/statistics",
  param("courseId").isUUID().withMessage("Invalid course ID"),
  query("period").optional().isIn(["daily", "weekly", "monthly"]),
  validate,
  courseManagementController.getCourseStatistics,
);

/**
 * @route   POST /api/v1/admin/courses
 * @desc    Create new course
 * @access  Private (Admin only)
 */
router.post(
  "/",
  body("code")
    .notEmpty()
    .withMessage("Course code is required")
    .trim()
    .isLength({ min: 3, max: 20 }),
  body("name")
    .notEmpty()
    .withMessage("Course name is required")
    .trim()
    .isLength({ min: 3, max: 100 }),
  body("description").optional().isString().isLength({ max: 500 }),
  body("credits").optional().isInt({ min: 1, max: 6 }),
  body("semester").optional().isString(),
  body("academicYear").optional().isString(),
  body("lecturerId").optional().isUUID(),
  validate,
  courseManagementController.createCourse,
);

/**
 * @route   POST /api/v1/admin/courses/bulk
 * @desc    Bulk create courses
 * @access  Private (Admin only)
 */
router.post(
  "/bulk",
  body("courses").isArray({ min: 1 }).withMessage("Courses array is required"),
  body("courses.*.code").notEmpty().withMessage("Course code is required"),
  body("courses.*.name").notEmpty().withMessage("Course name is required"),
  body("courses.*.credits").optional().isInt({ min: 1, max: 6 }),
  body("courses.*.lecturerId").optional().isUUID(),
  validate,
  courseManagementController.bulkCreateCourses,
);

/**
 * @route   PUT /api/v1/admin/courses/:courseId
 * @desc    Update course
 * @access  Private (Admin only)
 */
router.put(
  "/:courseId",
  param("courseId").isUUID().withMessage("Invalid course ID"),
  body("code").optional().isString().trim(),
  body("name").optional().isString().trim(),
  body("description").optional().isString(),
  body("credits").optional().isInt({ min: 1, max: 6 }),
  body("semester").optional().isString(),
  body("academicYear").optional().isString(),
  body("lecturerId").optional().isUUID(),
  body("isActive").optional().isBoolean(),
  validate,
  courseManagementController.updateCourse,
);

/**
 * @route   DELETE /api/v1/admin/courses/:courseId
 * @desc    Delete/Deactivate course
 * @access  Private (Admin only)
 */
router.delete(
  "/:courseId",
  param("courseId").isUUID().withMessage("Invalid course ID"),
  validate,
  courseManagementController.deleteCourse,
);

/**
 * @route   POST /api/v1/admin/courses/:courseId/activate
 * @desc    Reactivate deactivated course
 * @access  Private (Admin only)
 */
router.post(
  "/:courseId/activate",
  param("courseId").isUUID().withMessage("Invalid course ID"),
  validate,
  courseManagementController.reactivateCourse,
);

module.exports = router;
