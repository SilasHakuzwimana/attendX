const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const smsController = require("../controllers/sms.controller");

const router = express.Router();

// =====================================================
// PUBLIC WEBHOOK ROUTES (Twilio calls these)
// =====================================================

/**
 * @route   POST /api/v1/sms/webhook
 * @desc    Twilio SMS webhook handler for incoming messages
 * @access  Public (Twilio calls this)
 */
router.post(
  "/webhook",
  smsController.handleIncomingSMS.bind(smsController)
);

/**
 * @route   POST /api/v1/sms/status
 * @desc    Twilio SMS status webhook for delivery updates
 * @access  Public (Twilio calls this)
 */
router.post(
  "/status",
  smsController.smsStatus.bind(smsController)
);

// =====================================================
// LECTURER/ADMIN SMS ROUTES
// =====================================================

/**
 * @route   POST /api/v1/sms/broadcast
 * @desc    Broadcast SMS to course students
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/broadcast",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("courseId").isUUID().withMessage("Valid course ID is required"),
  body("message")
    .notEmpty()
    .withMessage("Message is required")
    .isLength({ min: 1, max: 160 })
    .withMessage("Message must be between 1 and 160 characters"),
  body("sendEmailCopy").optional().isBoolean(),
  validate,
  smsController.broadcastSMS.bind(smsController)
);

/**
 * @route   POST /api/v1/sms/send
 * @desc    Send SMS to single student
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/send",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("studentId").isUUID().withMessage("Valid student ID is required"),
  body("message")
    .notEmpty()
    .withMessage("Message is required")
    .isLength({ min: 1, max: 160 })
    .withMessage("Message must be between 1 and 160 characters"),
  validate,
  smsController.sendSingleSMS.bind(smsController)
);

/**
 * @route   POST /api/v1/sms/broadcast-bulk
 * @desc    Broadcast SMS to multiple courses
 * @access  Private (Admin only)
 */
router.post(
  "/broadcast-bulk",
  authenticateToken,
  requireRole("admin"),
  body("courseIds")
    .isArray({ min: 1 })
    .withMessage("At least one course ID is required"),
  body("courseIds.*").isUUID().withMessage("Invalid course ID format"),
  body("message")
    .notEmpty()
    .withMessage("Message is required")
    .isLength({ min: 1, max: 160 })
    .withMessage("Message must be between 1 and 160 characters"),
  body("role").optional().isIn(["student", "lecturer"]),
  validate,
  async (req, res, next) => {
    try {
      const { courseIds, message, role } = req.body;

      let allEnrollments = [];

      for (const courseId of courseIds) {
        const enrollments = await prisma.enrollment.findMany({
          where: {
            courseId,
            isActive: true,
            ...(role && { student: { role } }),
          },
          include: {
            student: {
              select: {
                id: true,
                fullName: true,
                phone: true,
                email: true,
                notificationPref: true,
              },
            },
            course: {
              select: { code: true, name: true },
            },
          },
        });
        allEnrollments.push(...enrollments);
      }

      // Remove duplicates by student ID
      const uniqueEnrollments = Array.from(
        new Map(allEnrollments.map(e => [e.student.id, e])).values()
      );

      const studentsWithPhone = uniqueEnrollments.filter(e => e.student.phone);

      if (studentsWithPhone.length === 0) {
        return res.json({
          success: true,
          data: {
            total: 0,
            sent: 0,
            failed: 0,
            message: "No students with registered phone numbers found.",
          },
        });
      }

      let sentCount = 0;
      let failedCount = 0;
      const results = [];

      for (const enrollment of studentsWithPhone) {
        try {
          const result = await smsController.smsService.sendSMS(
            enrollment.student.phone,
            `📢 ${enrollment.course.code}: ${message}`
          );
          sentCount++;
          results.push({
            phone: enrollment.student.phone,
            name: enrollment.student.fullName,
            success: true,
          });
        } catch (error) {
          failedCount++;
          results.push({
            phone: enrollment.student.phone,
            name: enrollment.student.fullName,
            success: false,
            error: error.message,
          });
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SMS_BULK_BROADCAST",
          entity: "SMS",
          newValues: { courses: courseIds.length, recipients: sentCount },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: {
          courses: courseIds.length,
          total: studentsWithPhone.length,
          sent: sentCount,
          failed: failedCount,
          details: results.slice(0, 20),
          message: `Broadcast sent to ${sentCount} students across ${courseIds.length} courses`,
        },
      });
    } catch (error) {
      logger.error("Bulk broadcast SMS error:", error);
      next(error);
    }
  }
);

// =====================================================
// SMS HISTORY & REPORTING ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sms/history
 * @desc    Get SMS history for current user or course
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/history",
  authenticateToken,
  requireRole("lecturer", "admin"),
  query("courseId").optional().isUUID(),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, page = 1, limit = 20, from, to } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Build where clause for audit logs
      const where = {
        action: { in: ["SMS_BROADCAST", "SMS_SINGLE", "SMS_BULK_BROADCAST"] },
        createdAt: {},
      };

      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);

      if (courseId) {
        where.entityId = courseId;
        where.entity = "Course";
      } else if (req.user.role === "lecturer") {
        // Get courses for this lecturer
        const courses = await prisma.course.findMany({
          where: { lecturerId: req.user.id },
          select: { id: true },
        });
        const courseIds = courses.map(c => c.id);
        if (courseIds.length > 0) {
          where.OR = [
            { entityId: { in: courseIds }, entity: "Course" },
            { userId: req.user.id },
          ];
        } else {
          where.userId = req.user.id;
        }
      } else {
        where.userId = req.user.id;
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          include: {
            user: {
              select: { fullName: true, email: true, role: true },
            },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.auditLog.count({ where }),
      ]);

      res.json({
        success: true,
        data: logs,
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
      logger.error("Get SMS history error:", error);
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/sms/history/:courseId
 * @desc    Get SMS history for a specific course
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/history/:courseId",
  authenticateToken,
  requireRole("lecturer", "admin"),
  param("courseId").isUUID().withMessage("Invalid course ID"),
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { courseId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Verify access
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found or access denied" },
        });
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: {
            action: { in: ["SMS_BROADCAST", "SMS_BULK_BROADCAST"] },
            entity: "Course",
            entityId: courseId,
          },
          include: {
            user: {
              select: { fullName: true, email: true, role: true },
            },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.auditLog.count({
          where: {
            action: { in: ["SMS_BROADCAST", "SMS_BULK_BROADCAST"] },
            entity: "Course",
            entityId: courseId,
          },
        }),
      ]);

      res.json({
        success: true,
        data: {
          course,
          broadcasts: logs,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      logger.error("Get course SMS history error:", error);
      next(error);
    }
  }
);

// =====================================================
// SMS STATISTICS & ANALYTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sms/statistics
 * @desc    Get SMS statistics and usage
 * @access  Private (Admin only)
 */
router.get(
  "/statistics",
  authenticateToken,
  requireRole("admin"),
  query("days").optional().isInt({ min: 1, max: 365 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { days = 30 } = req.query;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));

      const [totalBroadcasts, uniqueRecipients, broadcastsByDay, topCourses] = await Promise.all([
        prisma.auditLog.count({
          where: {
            action: { in: ["SMS_BROADCAST", "SMS_BULK_BROADCAST"] },
            createdAt: { gte: startDate },
          },
        }),
        prisma.auditLog.groupBy({
          by: ["userId"],
          where: {
            action: "SMS_BROADCAST",
            createdAt: { gte: startDate },
          },
          _count: true,
        }),
        prisma.$queryRaw`
          SELECT 
            DATE(created_at) as date,
            COUNT(*) as count
          FROM audit_logs
          WHERE action IN ('SMS_BROADCAST', 'SMS_BULK_BROADCAST')
            AND created_at >= ${startDate}
          GROUP BY DATE(created_at)
          ORDER BY date ASC
        `,
        prisma.$queryRaw`
          SELECT 
            entity_id as course_id,
            COUNT(*) as broadcast_count
          FROM audit_logs
          WHERE action = 'SMS_BROADCAST'
            AND created_at >= ${startDate}
          GROUP BY entity_id
          ORDER BY broadcast_count DESC
          LIMIT 5
        `,
      ]);

      res.json({
        success: true,
        data: {
          period: { days: parseInt(days), from: startDate, to: new Date() },
          totalBroadcasts,
          uniqueRecipients: uniqueRecipients.length,
          averageDaily: broadcastsByDay.length > 0
            ? (totalBroadcasts / broadcastsByDay.length).toFixed(1)
            : 0,
          dailyTrend: broadcastsByDay,
          topCourses,
        },
      });
    } catch (error) {
      logger.error("Get SMS statistics error:", error);
      next(error);
    }
  }
);

// =====================================================
// SMS CONFIGURATION & CREDITS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sms/remaining-credits
 * @desc    Get remaining SMS credits (if using prepaid)
 * @access  Private (Admin only)
 */
router.get(
  "/remaining-credits",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      // This would call Twilio API to get balance
      // For now, return placeholder
      let balance = null;
      let currency = "USD";

      if (smsController.smsService.initialized) {
        try {
          const account = await smsController.smsService.client.api.accounts(
            process.env.TWILIO_ACCOUNT_SID
          ).fetch();
          // Note: Actual balance check requires different API
        } catch (error) {
          logger.warn("Could not fetch Twilio balance:", error.message);
        }
      }

      res.json({
        success: true,
        data: {
          remaining: balance,
          currency,
          isUnlimited: !balance,
          lastUpdated: new Date(),
          serviceStatus: smsController.smsService.initialized ? "active" : "disabled",
        },
      });
    } catch (error) {
      logger.error("Get SMS credits error:", error);
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/sms/config
 * @desc    Get SMS configuration settings
 * @access  Private (Admin only)
 */
router.get(
  "/config",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const config = await prisma.systemConfig.findUnique({
        where: { id: "singleton" },
      });

      res.json({
        success: true,
        data: {
          smsEnabled: config?.smsEnabled ?? true,
          twilioConfigured: smsController.smsService.initialized,
          phoneNumber: process.env.TWILIO_PHONE_NUMBER ? 
            process.env.TWILIO_PHONE_NUMBER.replace(/.(?=.{4})/g, '*') : null,
          maxMessageLength: 160,
          rateLimitPerMinute: 3,
        },
      });
    } catch (error) {
      logger.error("Get SMS config error:", error);
      next(error);
    }
  }
);

// =====================================================
// SMS TEST & DEBUG ROUTES (Development only)
// =====================================================

/**
 * @route   POST /api/v1/sms/test
 * @desc    Test SMS sending (development only)
 * @access  Private (Development only)
 */
if (process.env.NODE_ENV === "development") {
  router.post(
    "/test",
    authenticateToken,
    body("to")
      .matches(/^\+?[1-9]\d{1,14}$/)
      .withMessage("Valid phone number required"),
    body("message")
      .notEmpty()
      .isLength({ max: 160 })
      .withMessage("Message must be between 1 and 160 characters"),
    validate,
    smsController.testSMS.bind(smsController)
  );
}

/**
 * @route   GET /api/v1/sms/test-webhook
 * @desc    Test webhook endpoint (development only)
 * @access  Private (Development only)
 */
if (process.env.NODE_ENV === "development") {
  router.post(
    "/test-webhook",
    authenticateToken,
    body("From").notEmpty(),
    body("Body").notEmpty(),
    validate,
    (req, res) => {
      // Simulate Twilio webhook for testing
      const mockReq = {
        body: req.body,
        ip: req.ip,
        get: (header) => req.get(header),
      };
      smsController.handleIncomingSMS(mockReq, res, () => {});
    }
  );
}

// =====================================================
// SMS EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/sms/export
 * @desc    Export SMS history to CSV
 * @access  Private (Admin only)
 */
router.get(
  "/export",
  authenticateToken,
  requireRole("admin"),
  query("courseId").optional().isUUID(),
  query("from").optional().isISO8601().toDate(),
  query("to").optional().isISO8601().toDate(),
  query("format").optional().isIn(["csv", "json"]),
  validate,
  async (req, res, next) => {
    try {
      const { courseId, from, to, format = "csv" } = req.query;

      const where = {
        action: { in: ["SMS_BROADCAST", "SMS_SINGLE", "SMS_BULK_BROADCAST"] },
      };

      if (courseId) {
        where.entityId = courseId;
        where.entity = "Course";
      }

      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      const logs = await prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: { fullName: true, email: true, role: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      if (format === "json") {
        return res.json({
          success: true,
          data: logs,
          total: logs.length,
        });
      }

      const csvRows = [
        ["Date", "Action", "User", "User Email", "Course ID", "Details", "IP Address"],
      ];

      for (const log of logs) {
        csvRows.push([
          log.createdAt.toISOString(),
          log.action,
          log.user?.fullName || "System",
          log.user?.email || "",
          log.entityId || "",
          JSON.stringify(log.newValues),
          log.ipAddress || "",
        ]);
      }

      const csvContent = csvRows.map(row => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=sms_history_${Date.now()}.csv`);
      res.send(csvContent);
    } catch (error) {
      logger.error("Export SMS history error:", error);
      next(error);
    }
  }
);

module.exports = router;