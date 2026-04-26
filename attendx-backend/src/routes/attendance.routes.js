const express = require("express");
const { query, param, body } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const attendanceController = require("../controllers/attendance.controller");

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * @route   GET /api/attendance
 * @desc    Query attendance records
 * @access  Private (Student sees own, Lecturer sees their courses, Admin sees all)
 */
router.get(
  "/",
  query("page").optional().isInt({ min: 1 }),
  query("limit").optional().isInt({ min: 1, max: 100 }),
  query("sessionId").optional().isUUID(),
  query("courseId").optional().isUUID(),
  query("studentId").optional().isUUID(),
  query("status").optional().isIn(["present", "absent", "excused", "late"]),
  query("from").optional().isDate(),
  query("to").optional().isDate(),
  validate,
  attendanceController.queryAttendance,
);

/**
 * @route   PATCH /api/attendance/:attendanceId/override
 * @desc    Override attendance record
 * @access  Private (Lecturer/Admin only)
 */
router.patch(
  "/:attendanceId/override",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("attendanceId").isUUID(),
  body("status")
    .isIn(["present", "absent", "excused", "late"])
    .withMessage("Valid status is required"),
  body("reason").optional().isString().trim(),
  validate,
  attendanceController.overrideAttendance,
);

/**
 * @route   GET /api/attendance/statistics/:studentId
 * @desc    Get attendance statistics for a student
 * @access  Private (Student sees own, Lecturer/Admin sees any)
 */
router.get(
  "/statistics/:studentId",
  param("studentId").isUUID(),
  validate,
  async (req, res, next) => {
    try {
      const { studentId } = req.params;

      // Check permission
      if (req.user.role === "student" && req.user.id !== studentId) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only view your own statistics",
          },
        });
      }

      const records = await global.prisma.attendanceRecord.findMany({
        where: { studentId },
        include: {
          session: {
            include: { course: true },
          },
        },
      });

      const totalClasses = records.length;
      const present = records.filter((r) => r.status === "present").length;
      const absent = records.filter((r) => r.status === "absent").length;
      const excused = records.filter((r) => r.status === "excused").length;
      const late = records.filter((r) => r.status === "late").length;

      // Per-course statistics
      const courseStats = {};
      for (const record of records) {
        const courseId = record.session.courseId;
        if (!courseStats[courseId]) {
          courseStats[courseId] = {
            courseName: record.session.course.name,
            courseCode: record.session.course.code,
            total: 0,
            present: 0,
            absent: 0,
            excused: 0,
            late: 0,
          };
        }
        courseStats[courseId].total++;
        courseStats[courseId][record.status]++;
      }

      res.json({
        success: true,
        data: {
          overall: {
            totalClasses,
            present,
            absent,
            excused,
            late,
            attendanceRate:
              totalClasses > 0 ? ((present + excused) / totalClasses) * 100 : 0,
          },
          perCourse: Object.values(courseStats),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @route   GET /api/attendance/export
 * @desc    Export attendance records as CSV
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/export",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("from").optional().isDate(),
  query("to").optional().isDate(),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, from, to } = req.query;

      const where = {};
      if (courseId) where.session = { courseId };
      if (from || to) {
        where.markedAt = {};
        if (from) where.markedAt.gte = new Date(from);
        if (to) where.markedAt.lte = new Date(to);
      }

      const records = await global.prisma.attendanceRecord.findMany({
        where,
        include: {
          student: true,
          session: {
            include: { course: true },
          },
        },
        orderBy: { markedAt: "desc" },
      });

      // Generate CSV
      let csv =
        "Student Name,Registration Number,Email,Course,Date,Status,Submission Method\n";
      for (const record of records) {
        csv += `"${record.student.fullName}","${record.student.regNumber || ""}","${record.student.email}","${record.session.course.name}","${record.markedAt.toISOString().split("T")[0]}","${record.status}","${record.submissionMethod || "N/A"}"\n`;
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=attendance_export_${Date.now()}.csv`,
      );
      res.send(csv);
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
