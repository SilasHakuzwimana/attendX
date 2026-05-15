const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const reportController = require("../controllers/report.controller");

const router = express.Router();

// =====================================================
// COURSE ATTENDANCE REPORTS
// =====================================================

/**
 * @route   GET /api/v1/reports/course-attendance
 * @desc    Generate attendance report for a course
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/course-attendance",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").isUUID().withMessage("Course ID is required"),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  query("includeStudents").optional().isBoolean().toBoolean(),
  validate,
  reportController.generateCourseAttendanceReport.bind(reportController),
);

// =====================================================
// STUDENT ATTENDANCE REPORTS
// =====================================================

/**
 * @route   GET /api/v1/reports/student-attendance
 * @desc    Generate student attendance report
 * @access  Private (Student, Lecturer, Admin)
 */
router.get(
  "/student-attendance",
  authenticateToken,
  query("studentId").optional().isUUID(),
  query("courseId").optional().isUUID(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateStudentAttendanceReport.bind(reportController),
);

// =====================================================
// LECTURER SUMMARY REPORTS
// =====================================================

/**
 * @route   GET /api/v1/reports/lecturer-summary
 * @desc    Generate lecturer summary report
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/lecturer-summary",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("lecturerId").optional().isUUID(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateLecturerSummaryReport.bind(reportController),
);

// =====================================================
// SYSTEM ANALYTICS REPORTS (Admin Only)
// =====================================================

/**
 * @route   GET /api/v1/reports/system-analytics
 * @desc    Generate system analytics report (Admin only)
 * @access  Private (Admin only)
 */
router.get(
  "/system-analytics",
  authenticateToken,
  requireRole("admin"),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("period").optional().isIn(["weekly", "monthly", "yearly"]),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateSystemAnalyticsReport.bind(reportController),
);

// =====================================================
// AT-RISK STUDENTS REPORTS
// =====================================================

/**
 * @route   GET /api/v1/reports/at-risk-students
 * @desc    Generate at-risk students report
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/at-risk-students",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("threshold").optional().isInt({ min: 0, max: 100 }).toInt(),
  query("consecutiveAbsences").optional().isInt({ min: 1, max: 10 }).toInt(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  reportController.generateAtRiskReport.bind(reportController),
);

// =====================================================
// EMAIL REPORT DELIVERY
// =====================================================

/**
 * @route   POST /api/v1/reports/send
 * @desc    Send report via email
 * @access  Private (Lecturer or Admin)
 */
router.post(
  "/send",
  authenticateToken,
  requireRole("lecturer", "admin"),
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

// =====================================================
// REPORT SCHEDULING (Admin Only)
// =====================================================

/**
 * @route   POST /api/v1/reports/schedule
 * @desc    Schedule automated report generation
 * @access  Private (Admin only)
 */
router.post(
  "/schedule",
  authenticateToken,
  requireRole("admin"),
  body("reportType")
    .isIn([
      "course_attendance",
      "student_attendance",
      "lecturer_summary",
      "system_analytics",
      "at_risk",
    ])
    .withMessage("Invalid report type"),
  body("frequency")
    .isIn(["daily", "weekly", "monthly"])
    .withMessage("Invalid frequency"),
  body("recipientEmail")
    .isEmail()
    .withMessage("Valid recipient email is required"),
  body("format").optional().isIn(["pdf", "csv"]),
  body("courseId").optional().isUUID(),
  body("threshold").optional().isInt({ min: 0, max: 100 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const {
        reportType,
        frequency,
        recipientEmail,
        format = "pdf",
        courseId,
        threshold,
      } = req.body;

      // Store schedule in database
      const schedule = await prisma.reportSchedule.create({
        data: {
          reportType,
          frequency,
          recipientEmail,
          format,
          courseId: courseId || null,
          threshold: threshold || null,
          nextRunAt: calculateNextRun(frequency),
          isActive: true,
          createdBy: req.user.id,
        },
      });

      function calculateNextRun(frequency) {
        const now = new Date();
        switch (frequency) {
          case "daily":
            now.setDate(now.getDate() + 1);
            break;
          case "weekly":
            now.setDate(now.getDate() + 7);
            break;
          case "monthly":
            now.setMonth(now.getMonth() + 1);
            break;
        }
        return now;
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SCHEDULE_REPORT",
          entity: "ReportSchedule",
          entityId: schedule.id,
          newValues: { reportType, frequency, recipientEmail },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Report scheduled: ${reportType} - ${frequency} to ${recipientEmail}`,
      );

      res.json({
        success: true,
        data: schedule,
        message: `Report scheduled ${frequency} to ${recipientEmail}`,
      });
    } catch (error) {
      logger.error("Schedule report error:", error);
      next(error);
    }
  },
);

/**
 * @route   GET /api/v1/reports/schedules
 * @desc    Get all scheduled reports
 * @access  Private (Admin only)
 */
router.get(
  "/schedules",
  authenticateToken,
  requireRole("admin"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [schedules, total] = await Promise.all([
        prisma.reportSchedule.findMany({
          where: { isActive: true },
          include: {
            createdByUser: {
              select: { fullName: true, email: true },
            },
          },
          orderBy: { nextRunAt: "asc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.reportSchedule.count({ where: { isActive: true } }),
      ]);

      res.json({
        success: true,
        data: schedules,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) {
      logger.error("Get schedules error:", error);
      next(error);
    }
  },
);

/**
 * @route   DELETE /api/v1/reports/schedules/:scheduleId
 * @desc    Delete/cancel scheduled report
 * @access  Private (Admin only)
 */
router.delete(
  "/schedules/:scheduleId",
  authenticateToken,
  requireRole("admin"),
  param("scheduleId").isUUID().withMessage("Invalid schedule ID"),
  validate,
  async (req, res, next) => {
    try {
      const { scheduleId } = req.params;

      const schedule = await prisma.reportSchedule.update({
        where: { id: scheduleId },
        data: { isActive: false },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CANCEL_SCHEDULED_REPORT",
          entity: "ReportSchedule",
          entityId: scheduleId,
          newValues: { isActive: false },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: { message: "Scheduled report cancelled successfully" },
      });
    } catch (error) {
      logger.error("Cancel schedule error:", error);
      next(error);
    }
  },
);

// =====================================================
// REPORT DOWNLOAD & EXPORT
// =====================================================

/**
 * @route   GET /api/v1/reports/download/:reportId
 * @desc    Download generated report file
 * @access  Private (Owner or Admin)
 */
router.get(
  "/download/:reportId",
  authenticateToken,
  param("reportId").isUUID().withMessage("Invalid report ID"),
  validate,
  async (req, res, next) => {
    try {
      const { reportId } = req.params;

      const report = await prisma.generatedReport.findUnique({
        where: { id: reportId },
      });

      if (!report) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Report not found" },
        });
      }

      // Check permission
      if (req.user.role !== "admin" && report.userId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Access denied" },
        });
      }

      // Check if file exists
      const filePath = path.join(__dirname, "../reports", report.fileName);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Report file not found" },
        });
      }

      res.download(filePath, report.fileName);
    } catch (error) {
      logger.error("Download report error:", error);
      next(error);
    }
  },
);

// =====================================================
// REPORT HISTORY
// =====================================================

/**
 * @route   GET /api/v1/reports/history
 * @desc    Get report generation history
 * @access  Private (User's own or Admin)
 */
router.get(
  "/history",
  authenticateToken,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("reportType").optional().isString(),
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, reportType } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const where = {};
      if (req.user.role !== "admin") {
        where.userId = req.user.id;
      }
      if (reportType) where.reportType = reportType;

      const [reports, total] = await Promise.all([
        prisma.generatedReport.findMany({
          where,
          orderBy: { generatedAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.generatedReport.count({ where }),
      ]);

      res.json({
        success: true,
        data: reports,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) {
      logger.error("Get report history error:", error);
      next(error);
    }
  },
);

// =====================================================
// REPORT FORMATS & OPTIONS
// =====================================================

/**
 * @route   GET /api/v1/reports/formats
 * @desc    Get available report formats and options
 * @access  Private
 */
router.get("/formats", authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: {
      formats: ["json", "csv", "pdf"],
      reportTypes: [
        {
          type: "course_attendance",
          description: "Course attendance summary with session breakdown",
        },
        {
          type: "student_attendance",
          description: "Individual student attendance history",
        },
        {
          type: "lecturer_summary",
          description: "Lecturer's courses and overall statistics",
        },
        {
          type: "system_analytics",
          description: "System-wide analytics and trends (Admin only)",
        },
        {
          type: "at_risk",
          description: "Students with attendance below threshold",
        },
      ],
      frequencies: ["daily", "weekly", "monthly"],
      maxDateRange: 365,
      maxStudentsPerReport: 1000,
    },
  });
});

// =====================================================
// COMPARATIVE REPORTS
// =====================================================

/**
 * @route   GET /api/v1/reports/compare-courses
 * @desc    Compare attendance between multiple courses
 * @access  Private (Lecturer or Admin)
 */
router.get(
  "/compare-courses",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseIds")
    .isArray()
    .withMessage("At least one course ID is required"),
  query("courseIds.*").isUUID(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("format").optional().isIn(["json", "csv", "pdf"]),
  validate,
  async (req, res, next) => {
    try {
      const { courseIds, from, to, format = "json" } = req.query;
      const comparisonData = [];

      for (const courseId of courseIds) {
        // Verify access
        const course = await prisma.course.findFirst({
          where: {
            id: courseId,
            ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
          },
        });

        if (!course) continue;

        const whereSession = { courseId, status: "closed" };
        if (from) whereSession.startedAt = { gte: new Date(from) };
        if (to)
          whereSession.startedAt = {
            ...whereSession.startedAt,
            lte: new Date(to),
          };

        const sessions = await prisma.session.findMany({
          where: whereSession,
          include: { attendanceRecords: true },
        });

        let totalPresent = 0;
        let totalLate = 0;
        let totalAbsent = 0;
        let totalRecords = 0;

        for (const session of sessions) {
          const present = session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          const late = session.attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          const absent = session.attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length;

          totalPresent += present;
          totalLate += late;
          totalAbsent += absent;
          totalRecords += session.attendanceRecords.length;
        }

        const attendanceRate =
          totalRecords > 0
            ? ((totalPresent + totalLate) / totalRecords) * 100
            : 0;

        comparisonData.push({
          course: {
            id: course.id,
            code: course.code,
            name: course.name,
          },
          statistics: {
            totalSessions: sessions.length,
            totalPresent,
            totalLate,
            totalAbsent,
            attendanceRate: parseFloat(attendanceRate.toFixed(1)),
          },
        });
      }

      if (format === "csv") {
        const csvRows = [
          [
            "Course Code",
            "Course Name",
            "Total Sessions",
            "Present",
            "Late",
            "Absent",
            "Attendance Rate",
          ],
        ];
        for (const data of comparisonData) {
          csvRows.push([
            data.course.code,
            `"${data.course.name}"`,
            data.statistics.totalSessions,
            data.statistics.totalPresent,
            data.statistics.totalLate,
            data.statistics.totalAbsent,
            `${data.statistics.attendanceRate}%`,
          ]);
        }
        const csvContent = csvRows.map((row) => row.join(",")).join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=course_comparison_${Date.now()}.csv`,
        );
        return res.send(csvContent);
      }

      res.json({
        success: true,
        data: {
          comparison: comparisonData,
          summary: {
            averageAttendance:
              comparisonData.reduce(
                (sum, c) => sum + c.statistics.attendanceRate,
                0,
              ) / comparisonData.length,
            bestPerforming: comparisonData.reduce(
              (best, c) =>
                c.statistics.attendanceRate > best.statistics.attendanceRate
                  ? c
                  : best,
              comparisonData[0],
            ),
            worstPerforming: comparisonData.reduce(
              (worst, c) =>
                c.statistics.attendanceRate < worst.statistics.attendanceRate
                  ? c
                  : worst,
              comparisonData[0],
            ),
          },
        },
      });
    } catch (error) {
      logger.error("Compare courses error:", error);
      next(error);
    }
  },
);

// =====================================================
// EXPORT ALL REPORTS (Admin Only)
// =====================================================

/**
 * @route   GET /api/v1/reports/export-all
 * @desc    Export all data (backup) - Admin only
 * @access  Private (Admin only)
 */
router.get(
  "/export-all",
  authenticateToken,
  requireRole("admin"),
  query("include").optional().isString(),
  query("format").optional().isIn(["json", "zip"]),
  validate,
  async (req, res, next) => {
    try {
      const { include = "users,courses,attendance", format = "json" } =
        req.query;
      const sections = include.split(",");

      const exportData = {};

      if (sections.includes("users")) {
        exportData.users = await prisma.user.findMany({
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
            regNumber: true,
            staffNumber: true,
            isActive: true,
            createdAt: true,
            lastLoginAt: true,
          },
        });
      }

      if (sections.includes("courses")) {
        exportData.courses = await prisma.course.findMany({
          include: {
            lecturer: { select: { fullName: true, email: true } },
          },
        });
      }

      if (sections.includes("attendance")) {
        exportData.attendanceRecords = await prisma.attendanceRecord.findMany({
          include: {
            student: { select: { fullName: true, regNumber: true } },
            session: {
              select: { sessionCode: true, course: { select: { name: true } } },
            },
          },
          take: 10000,
        });
      }

      if (sections.includes("classrooms")) {
        exportData.classrooms = await prisma.classroom.findMany();
      }

      if (sections.includes("devices")) {
        exportData.devices = await prisma.device.findMany({
          select: {
            deviceName: true,
            platform: true,
            isActive: true,
            lastSeenAt: true,
          },
        });
      }

      res.json({
        success: true,
        data: exportData,
        metadata: {
          exportedAt: new Date(),
          exportedBy: req.user.email,
          sections: sections,
        },
      });
    } catch (error) {
      logger.error("Export all data error:", error);
      next(error);
    }
  },
);

module.exports = router;
