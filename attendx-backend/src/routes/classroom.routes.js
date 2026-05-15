const express = require("express");
const { body, param, query } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { authenticateToken, requireRole } = require("../middleware/auth.middleware");
const classroomController = require("../controllers/classroom.controller");

const router = express.Router();

// =====================================================
// PUBLIC CLASSROOM ROUTES (Authenticated Users)
// =====================================================

/**
 * @route   GET /api/v1/classrooms
 * @desc    Get all classrooms with pagination and filtering
 * @access  Private (All authenticated users)
 */
router.get(
  "/",
  authenticateToken,
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("search").optional().isString().trim(),
  query("building").optional().isString().trim(),
  query("minCapacity").optional().isInt({ min: 1 }).toInt(),
  query("isActive").optional().isBoolean().toBoolean(),
  query("sortBy").optional().isIn(["name", "building", "capacity", "createdAt"]),
  query("sortOrder").optional().isIn(["asc", "desc"]),
  validate,
  classroomController.getClassrooms.bind(classroomController)
);

/**
 * @route   GET /api/v1/classrooms/list
 * @desc    Get classrooms for dropdown/select inputs
 * @access  Private (All authenticated users)
 */
router.get(
  "/list",
  authenticateToken,
  classroomController.getClassroomList.bind(classroomController)
);

/**
 * @route   GET /api/v1/classrooms/buildings
 * @desc    Get classrooms grouped by building
 * @access  Private (All authenticated users)
 */
router.get(
  "/buildings",
  authenticateToken,
  classroomController.getBuildings.bind(classroomController)
);

/**
 * @route   GET /api/v1/classrooms/available
 * @desc    Get available classrooms for a given time slot
 * @access  Private (All authenticated users)
 */
router.get(
  "/available",
  authenticateToken,
  query("date").isISO8601().withMessage("Valid date is required"),
  query("startTime").matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage("Valid start time is required (HH:MM)"),
  query("endTime").matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage("Valid end time is required (HH:MM)"),
  query("minCapacity").optional().isInt({ min: 1 }).toInt(),
  query("building").optional().isString().trim(),
  validate,
  classroomController.getAvailableClassrooms.bind(classroomController)
);

/**
 * @route   GET /api/v1/classrooms/nearby
 * @desc    Get nearby classrooms based on GPS coordinates
 * @access  Private (All authenticated users)
 */
router.get(
  "/nearby",
  authenticateToken,
  query("latitude").isFloat({ min: -90, max: 90 }).withMessage("Valid latitude is required"),
  query("longitude").isFloat({ min: -180, max: 180 }).withMessage("Valid longitude is required"),
  query("radius").optional().isFloat({ min: 10, max: 5000 }).toFloat(),
  query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  validate,
  classroomController.getNearbyClassrooms.bind(classroomController)
);

/**
 * @route   GET /api/v1/classrooms/utilization
 * @desc    Get classroom utilization statistics
 * @access  Private (All authenticated users)
 */
router.get(
  "/utilization",
  authenticateToken,
  query("period").optional().isIn(["week", "month", "semester", "year"]),
  query("startDate").optional().isISO8601(),
  query("endDate").optional().isISO8601(),
  validate,
  classroomController.getClassroomUtilization.bind(classroomController)
);

/**
 * @route   GET /api/v1/classrooms/:classroomId
 * @desc    Get classroom by ID with details
 * @access  Private (All authenticated users)
 */
router.get(
  "/:classroomId",
  authenticateToken,
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  validate,
  classroomController.getClassroomById.bind(classroomController)
);

/**
 * @route   GET /api/v1/classrooms/:classroomId/schedule
 * @desc    Get classroom schedule for a specific date
 * @access  Private (All authenticated users)
 */
router.get(
  "/:classroomId/schedule",
  authenticateToken,
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  query("date").optional().isISO8601(),
  validate,
  classroomController.getClassroomSchedule.bind(classroomController)
);

/**
 * @route   POST /api/v1/classrooms/:classroomId/verify-geofence
 * @desc    Verify geofence for a classroom
 * @access  Private (All authenticated users)
 */
router.post(
  "/:classroomId/verify-geofence",
  authenticateToken,
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  body("latitude").isFloat({ min: -90, max: 90 }).withMessage("Valid latitude is required"),
  body("longitude").isFloat({ min: -180, max: 180 }).withMessage("Valid longitude is required"),
  validate,
  classroomController.verifyGeofence.bind(classroomController)
);

// =====================================================
// ADMIN ONLY CLASSROOM MANAGEMENT ROUTES
// =====================================================

/**
 * @route   POST /api/v1/classrooms
 * @desc    Create new classroom (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/",
  authenticateToken,
  requireRole("admin"),
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
    .withMessage("Classroom code can only contain letters, numbers, hyphens, and underscores"),
  body("building").optional().isString().trim(),
  body("capacity").optional().isInt({ min: 1 }).withMessage("Capacity must be at least 1"),
  body("latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("Valid latitude is required (-90 to 90)"),
  body("longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("Valid longitude is required (-180 to 180)"),
  body("radiusM")
    .isInt({ min: 1, max: 500 })
    .withMessage("Radius must be between 1 and 500 meters"),
  validate,
  classroomController.createClassroom.bind(classroomController)
);

/**
 * @route   PUT /api/v1/classrooms/:classroomId
 * @desc    Update classroom (Admin only)
 * @access  Private (Admin only)
 */
router.put(
  "/:classroomId",
  authenticateToken,
  requireRole("admin"),
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  body("name").optional().isString().trim().isLength({ min: 2, max: 100 }),
  body("code")
    .optional()
    .isString()
    .trim()
    .matches(/^[A-Za-z0-9\-_]+$/)
    .withMessage("Classroom code can only contain letters, numbers, hyphens, and underscores"),
  body("building").optional().isString().trim(),
  body("capacity").optional().isInt({ min: 1 }),
  body("latitude").optional().isFloat({ min: -90, max: 90 }),
  body("longitude").optional().isFloat({ min: -180, max: 180 }),
  body("radiusM").optional().isInt({ min: 1, max: 500 }),
  body("isActive").optional().isBoolean(),
  validate,
  classroomController.updateClassroom.bind(classroomController)
);

/**
 * @route   DELETE /api/v1/classrooms/:classroomId
 * @desc    Delete/Deactivate classroom (Admin only)
 * @access  Private (Admin only)
 */
router.delete(
  "/:classroomId",
  authenticateToken,
  requireRole("admin"),
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  query("force").optional().isBoolean().toBoolean(),
  validate,
  classroomController.deleteClassroom.bind(classroomController)
);

// =====================================================
// CLASSROOM STATISTICS ROUTES
// =====================================================

/**
 * @route   GET /api/v1/classrooms/statistics/overview
 * @desc    Get classroom statistics overview
 * @access  Private (Admin only)
 */
router.get(
  "/statistics/overview",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const [totalClassrooms, activeClassrooms, totalCapacity, totalSessions, totalCheckins] = await Promise.all([
        prisma.classroom.count(),
        prisma.classroom.count({ where: { isActive: true } }),
        prisma.classroom.aggregate({ _sum: { capacity: true } }),
        prisma.session.count(),
        prisma.roomCheckin.count(),
      ]);

      // Get most used classrooms
      const mostUsedClassrooms = await prisma.classroom.findMany({
        where: { isActive: true },
        include: {
          _count: {
            select: { sessions: true },
          },
        },
        orderBy: { sessions: { _count: "desc" } },
        take: 5,
      });

      res.json({
        success: true,
        data: {
          totalClassrooms,
          activeClassrooms,
          totalCapacity: totalCapacity._sum.capacity || 0,
          totalSessions,
          totalCheckins,
          averageUtilization: activeClassrooms > 0 
            ? ((totalSessions / activeClassrooms) * 100).toFixed(1)
            : 0,
          mostUsedClassrooms: mostUsedClassrooms.map(c => ({
            id: c.id,
            name: c.name,
            building: c.building,
            sessionCount: c._count.sessions,
          })),
        },
      });
    } catch (error) {
      logger.error("Get classroom statistics overview error:", error);
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/classrooms/statistics/peak-hours
 * @desc    Get classroom peak usage hours
 * @access  Private (Admin only)
 */
router.get(
  "/statistics/peak-hours",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const peakHours = await prisma.$queryRaw`
        SELECT 
          EXTRACT(HOUR FROM started_at) as hour,
          COUNT(*) as session_count,
          AVG(checkins_count) as avg_checkins
        FROM sessions
        WHERE status = 'closed'
        GROUP BY EXTRACT(HOUR FROM started_at)
        ORDER BY hour ASC
      `;

      res.json({
        success: true,
        data: peakHours,
      });
    } catch (error) {
      logger.error("Get peak hours error:", error);
      next(error);
    }
  }
);

// =====================================================
// CLASSROOM MAINTENANCE ROUTES
// =====================================================

/**
 * @route   POST /api/v1/classrooms/:classroomId/maintenance
 * @desc    Mark classroom as under maintenance (Admin only)
 * @access  Private (Admin only)
 */
router.post(
  "/:classroomId/maintenance",
  authenticateToken,
  requireRole("admin"),
  param("classroomId").isUUID().withMessage("Invalid classroom ID format"),
  body("maintenanceMode").isBoolean().withMessage("maintenanceMode is required"),
  body("reason").optional().isString().trim().isLength({ max: 500 }),
  validate,
  async (req, res, next) => {
    try {
      const { classroomId } = req.params;
      const { maintenanceMode, reason } = req.body;

      const classroom = await prisma.classroom.findUnique({
        where: { id: classroomId },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      const updated = await prisma.classroom.update({
        where: { id: classroomId },
        data: {
          isActive: !maintenanceMode,
          maintenanceReason: maintenanceMode ? reason : null,
          maintenanceUpdatedAt: maintenanceMode ? new Date() : null,
        },
      });

      // If enabling maintenance, end all active sessions
      if (maintenanceMode) {
        await prisma.session.updateMany({
          where: {
            classroomId,
            status: "active",
          },
          data: {
            status: "expired",
            checkinOpen: false,
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: maintenanceMode ? "CLASSROOM_MAINTENANCE_START" : "CLASSROOM_MAINTENANCE_END",
          entity: "Classroom",
          entityId: classroomId,
          newValues: { maintenanceMode, reason },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Classroom ${classroom.name} maintenance mode: ${maintenanceMode ? "enabled" : "disabled"} by ${req.user.email}`);

      res.json({
        success: true,
        data: updated,
        message: maintenanceMode 
          ? "Classroom marked as under maintenance. Active sessions have been ended."
          : "Classroom maintenance mode disabled.",
      });
    } catch (error) {
      logger.error("Toggle classroom maintenance error:", error);
      next(error);
    }
  }
);

// =====================================================
// CLASSROOM EXPORT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/classrooms/export
 * @desc    Export classrooms to CSV
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

      const classrooms = await prisma.classroom.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
      });

      if (format === "json") {
        return res.json({
          success: true,
          data: classrooms,
          total: classrooms.length,
        });
      }

      const csvRows = [
        ["Name", "Building", "Code", "Capacity", "Latitude", "Longitude", "Radius (m)", "Created At"],
      ];

      for (const classroom of classrooms) {
        csvRows.push([
          `"${classroom.name}"`,
          classroom.building || "",
          classroom.code || "",
          classroom.capacity || "",
          classroom.latitude,
          classroom.longitude,
          classroom.radiusM,
          classroom.createdAt.toISOString(),
        ]);
      }

      const csvContent = csvRows.map(row => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=classrooms_export_${Date.now()}.csv`);
      res.send(csvContent);
    } catch (error) {
      logger.error("Export classrooms error:", error);
      next(error);
    }
  }
);

module.exports = router;