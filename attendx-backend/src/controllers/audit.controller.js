const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const { Parser } = require("json2csv");

class AuditController {
  constructor() {
    this.auditActions = {
      // Authentication Actions
      LOGIN: "LOGIN",
      LOGOUT: "LOGOUT",
      LOGIN_FAILED: "LOGIN_FAILED",
      PASSWORD_CHANGED: "PASSWORD_CHANGED",
      PASSWORD_RESET: "PASSWORD_RESET",
      TOKEN_REFRESHED: "TOKEN_REFRESHED",

      // User Management Actions
      USER_CREATED: "USER_CREATED",
      USER_UPDATED: "USER_UPDATED",
      USER_DELETED: "USER_DELETED",
      USER_DEACTIVATED: "USER_DEACTIVATED",
      USER_REACTIVATED: "USER_REACTIVATED",
      ROLE_CHANGED: "ROLE_CHANGED",

      // Course Management Actions
      COURSE_CREATED: "COURSE_CREATED",
      COURSE_UPDATED: "COURSE_UPDATED",
      COURSE_DELETED: "COURSE_DELETED",
      COURSE_ARCHIVED: "COURSE_ARCHIVED",

      // Enrollment Actions
      ENROLLMENT_CREATED: "ENROLLMENT_CREATED",
      ENROLLMENT_UPDATED: "ENROLLMENT_UPDATED",
      ENROLLMENT_DELETED: "ENROLLMENT_DELETED",
      BULK_ENROLLMENT: "BULK_ENROLLMENT",

      // Session Actions
      SESSION_CREATED: "SESSION_CREATED",
      SESSION_STARTED: "SESSION_STARTED",
      SESSION_CLOSED: "SESSION_CLOSED",
      SESSION_EXTENDED: "SESSION_EXTENDED",

      // Attendance Actions
      CHECKIN_APP: "CHECKIN_APP",
      CHECKIN_SMS: "CHECKIN_SMS",
      CHECKIN_MANUAL: "CHECKIN_MANUAL",
      ATTENDANCE_OVERRIDDEN: "ATTENDANCE_OVERRIDDEN",
      ATTENDANCE_MARKED: "ATTENDANCE_MARKED",

      // Classroom Actions
      CLASSROOM_CREATED: "CLASSROOM_CREATED",
      CLASSROOM_UPDATED: "CLASSROOM_UPDATED",
      CLASSROOM_DELETED: "CLASSROOM_DELETED",

      // Device Actions
      DEVICE_REGISTERED: "DEVICE_REGISTERED",
      DEVICE_REVOKED: "DEVICE_REVOKED",
      DEVICE_TRUST_CHANGED: "DEVICE_TRUST_CHANGED",

      // System Actions
      CONFIG_UPDATED: "CONFIG_UPDATED",
      CONFIG_RESET: "CONFIG_RESET",
      MAINTENANCE_MODE_TOGGLED: "MAINTENANCE_MODE_TOGGLED",
      SYSTEM_BACKUP: "SYSTEM_BACKUP",
      SYSTEM_RESTORE: "SYSTEM_RESTORE",

      // Notification Actions
      NOTIFICATION_SENT: "NOTIFICATION_SENT",
      BROADCAST_SENT: "BROADCAST_SENT",

      // Report Actions
      REPORT_GENERATED: "REPORT_GENERATED",
      REPORT_EXPORTED: "REPORT_EXPORTED",
      REPORT_SENT: "REPORT_SENT",

      // Bulk Operations
      BULK_IMPORT: "BULK_IMPORT",
      BULK_EXPORT: "BULK_EXPORT",
      BULK_UPDATE: "BULK_UPDATE",
      BULK_DELETE: "BULK_DELETE",

      // Security Actions
      SUSPICIOUS_ACTIVITY: "SUSPICIOUS_ACTIVITY",
      RATE_LIMIT_HIT: "RATE_LIMIT_HIT",
      ACCESS_DENIED: "ACCESS_DENIED",
    };
  }

  /**
   * Log an audit event
   */
  async log(
    userId,
    action,
    entity,
    entityId,
    oldValues,
    newValues,
    req = null,
  ) {
    try {
      const auditData = {
        userId,
        action,
        entity,
        entityId,
        oldValues: oldValues ? JSON.stringify(oldValues) : null,
        newValues: newValues ? JSON.stringify(newValues) : null,
        ipAddress: req?.ip || req?.connection?.remoteAddress || null,
        userAgent: req?.get("user-agent") || null,
      };

      const auditLog = await prisma.auditLog.create({
        data: auditData,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
      });

      // Also log to Redis for real-time monitoring
      if (redisClient && redisClient.isReady) {
        const key = `audit:recent`;
        await redisClient.lPush(key, JSON.stringify(auditLog));
        await redisClient.lTrim(key, 0, 999); // Keep last 1000 logs
      }

      // Log critical actions to console
      const criticalActions = [
        this.auditActions.USER_DELETED,
        this.auditActions.ROLE_CHANGED,
        this.auditActions.CONFIG_UPDATED,
        this.auditActions.SUSPICIOUS_ACTIVITY,
        this.auditActions.BULK_IMPORT,
        this.auditActions.BULK_DELETE,
      ];

      if (criticalActions.includes(action)) {
        logger.warn(
          `[AUDIT] ${action} - User: ${userId} - Entity: ${entity} - ID: ${entityId}`,
        );
      }

      return auditLog;
    } catch (error) {
      logger.error("Failed to log audit event:", error);
      // Don't throw - audit logging should not break main functionality
      return null;
    }
  }

  /**
   * Get audit logs with filters
   * GET /api/v1/audit/logs
   */
  async getAuditLogs(req, res, next) {
    try {
      const {
        page = 1,
        limit = 50,
        userId,
        action,
        entity,
        entityId,
        from,
        to,
        search,
        sortBy = "createdAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = {};

      if (userId) where.userId = userId;
      if (action) where.action = action;
      if (entity) where.entity = entity;
      if (entityId) where.entityId = entityId;

      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      if (search) {
        where.OR = [
          { action: { contains: search, mode: "insensitive" } },
          { entity: { contains: search, mode: "insensitive" } },
          { entityId: { contains: search, mode: "insensitive" } },
        ];
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
                role: true,
              },
            },
          },
          orderBy: { [sortBy]: sortOrder },
          skip,
          take,
        }),
        prisma.auditLog.count({ where }),
      ]);

      // Parse JSON fields for response
      const parsedLogs = logs.map((log) => ({
        ...log,
        oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
        newValues: log.newValues ? JSON.parse(log.newValues) : null,
      }));

      res.json({
        success: true,
        data: parsedLogs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
          hasNextPage: skip + take < total,
          hasPrevPage: page > 1,
        },
      });
    } catch (error) {
      logger.error("Get audit logs error:", error);
      next(error);
    }
  }

  /**
   * Get audit log by ID
   * GET /api/v1/audit/logs/:logId
   */
  async getAuditLogById(req, res, next) {
    try {
      const { logId } = req.params;

      const log = await prisma.auditLog.findUnique({
        where: { id: logId },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
      });

      if (!log) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Audit log not found" },
        });
      }

      // Parse JSON fields
      const parsedLog = {
        ...log,
        oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
        newValues: log.newValues ? JSON.parse(log.newValues) : null,
      };

      res.json({
        success: true,
        data: parsedLog,
      });
    } catch (error) {
      logger.error("Get audit log by ID error:", error);
      next(error);
    }
  }

  /**
   * Get audit statistics
   * GET /api/v1/audit/statistics
   */
  async getAuditStatistics(req, res, next) {
    try {
      const { days = 30 } = req.query;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));

      // Get counts by action
      const actionCounts = await prisma.auditLog.groupBy({
        by: ["action"],
        where: {
          createdAt: { gte: startDate },
        },
        _count: true,
        orderBy: { _count: "desc" },
        take: 20,
      });

      // Get counts by entity
      const entityCounts = await prisma.auditLog.groupBy({
        by: ["entity"],
        where: {
          createdAt: { gte: startDate },
        },
        _count: true,
        orderBy: { _count: "desc" },
      });

      // Get counts by user
      const userCounts = await prisma.auditLog.groupBy({
        by: ["userId"],
        where: {
          createdAt: { gte: startDate },
        },
        _count: true,
        orderBy: { _count: "desc" },
        take: 10,
      });

      // Get user details for top users
      const topUsers = await Promise.all(
        userCounts.map(async (uc) => {
          const user = await prisma.user.findUnique({
            where: { id: uc.userId },
            select: { id: true, fullName: true, email: true, role: true },
          });
          return {
            user,
            actionCount: uc._count,
          };
        }),
      );

      // Get daily activity
      const dailyActivity = await prisma.$queryRaw`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as count
        FROM audit_logs
        WHERE created_at >= ${startDate}
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `;

      // Get hourly distribution
      const hourlyDistribution = await prisma.$queryRaw`
        SELECT 
          EXTRACT(HOUR FROM created_at) as hour,
          COUNT(*) as count
        FROM audit_logs
        WHERE created_at >= ${startDate}
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY hour ASC
      `;

      res.json({
        success: true,
        data: {
          period: {
            days: parseInt(days),
            from: startDate,
            to: new Date(),
          },
          summary: {
            totalLogs: await prisma.auditLog.count({
              where: { createdAt: { gte: startDate } },
            }),
            uniqueUsers: await prisma.auditLog
              .groupBy({
                by: ["userId"],
                where: { createdAt: { gte: startDate } },
              })
              .then((g) => g.length),
            uniqueActions: actionCounts.length,
            uniqueEntities: entityCounts.length,
          },
          topActions: actionCounts,
          topEntities: entityCounts,
          topUsers,
          dailyActivity,
          hourlyDistribution,
        },
      });
    } catch (error) {
      logger.error("Get audit statistics error:", error);
      next(error);
    }
  }

  /**
   * Get user activity timeline
   * GET /api/v1/audit/users/:userId/timeline
   */
  async getUserActivityTimeline(req, res, next) {
    try {
      const { userId } = req.params;
      const { days = 30 } = req.query;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));

      const logs = await prisma.auditLog.findMany({
        where: {
          userId,
          createdAt: { gte: startDate },
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      // Parse JSON fields
      const parsedLogs = logs.map((log) => ({
        ...log,
        oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
        newValues: log.newValues ? JSON.parse(log.newValues) : null,
      }));

      // Group by date
      const groupedByDate = {};
      parsedLogs.forEach((log) => {
        const date = log.createdAt.toISOString().split("T")[0];
        if (!groupedByDate[date]) {
          groupedByDate[date] = [];
        }
        groupedByDate[date].push(log);
      });

      res.json({
        success: true,
        data: {
          user: parsedLogs[0]?.user || null,
          period: {
            days: parseInt(days),
            from: startDate,
            to: new Date(),
          },
          summary: {
            totalActions: parsedLogs.length,
            uniqueActions: new Set(parsedLogs.map((l) => l.action)).size,
            firstActivity: parsedLogs[parsedLogs.length - 1]?.createdAt,
            lastActivity: parsedLogs[0]?.createdAt,
          },
          timeline: groupedByDate,
          activities: parsedLogs,
        },
      });
    } catch (error) {
      logger.error("Get user activity timeline error:", error);
      next(error);
    }
  }

  /**
   * Get entity audit trail
   * GET /api/v1/audit/entity/:entityType/:entityId
   */
  async getEntityAuditTrail(req, res, next) {
    try {
      const { entityType, entityId } = req.params;
      const { page = 1, limit = 50 } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: {
            entity: entityType,
            entityId,
          },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
                role: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.auditLog.count({
          where: { entity: entityType, entityId },
        }),
      ]);

      // Parse JSON fields
      const parsedLogs = logs.map((log) => ({
        ...log,
        oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
        newValues: log.newValues ? JSON.parse(log.newValues) : null,
      }));

      // Calculate changes over time
      const changes = [];
      for (let i = 0; i < parsedLogs.length - 1; i++) {
        if (parsedLogs[i].oldValues && parsedLogs[i].newValues) {
          const changedFields = this.getChangedFields(
            parsedLogs[i].oldValues,
            parsedLogs[i].newValues,
          );
          if (changedFields.length > 0) {
            changes.push({
              timestamp: parsedLogs[i].createdAt,
              user: parsedLogs[i].user,
              action: parsedLogs[i].action,
              changedFields,
            });
          }
        }
      }

      res.json({
        success: true,
        data: {
          entity: {
            type: entityType,
            id: entityId,
          },
          summary: {
            totalChanges: total,
            uniqueUsers: new Set(parsedLogs.map((l) => l.userId)).size,
            firstChange: parsedLogs[parsedLogs.length - 1]?.createdAt,
            lastChange: parsedLogs[0]?.createdAt,
          },
          changes,
          logs: parsedLogs,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      logger.error("Get entity audit trail error:", error);
      next(error);
    }
  }

  /**
   * Export audit logs
   * GET /api/v1/audit/export
   */
  async exportAuditLogs(req, res, next) {
    try {
      const { format = "csv", userId, action, entity, from, to } = req.query;

      const where = {};

      if (userId) where.userId = userId;
      if (action) where.action = action;
      if (entity) where.entity = entity;

      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
      }

      const logs = await prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      if (format === "json") {
        const parsedLogs = logs.map((log) => ({
          ...log,
          oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
          newValues: log.newValues ? JSON.parse(log.newValues) : null,
          user: log.user,
        }));

        return res.json({
          success: true,
          data: parsedLogs,
          total: logs.length,
        });
      }

      // CSV format
      const csvData = logs.map((log) => ({
        ID: log.id,
        "User ID": log.userId,
        "User Name": log.user?.fullName || "System",
        "User Email": log.user?.email || "N/A",
        "User Role": log.user?.role || "N/A",
        Action: log.action,
        Entity: log.entity,
        "Entity ID": log.entityId,
        "Old Values": log.oldValues,
        "New Values": log.newValues,
        "IP Address": log.ipAddress,
        "User Agent": log.userAgent,
        "Created At": log.createdAt.toISOString(),
      }));

      const parser = new Parser();
      const csv = parser.parse(csvData);

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=audit_logs_${Date.now()}.csv`,
      );
      res.send(csv);
    } catch (error) {
      logger.error("Export audit logs error:", error);
      next(error);
    }
  }

  /**
   * Get recent alerts (suspicious activities)
   * GET /api/v1/audit/alerts
   */
  async getRecentAlerts(req, res, next) {
    try {
      const { limit = 50 } = req.query;

      const alerts = await prisma.auditLog.findMany({
        where: {
          action: {
            in: [
              this.auditActions.LOGIN_FAILED,
              this.auditActions.SUSPICIOUS_ACTIVITY,
              this.auditActions.RATE_LIMIT_HIT,
              this.auditActions.ACCESS_DENIED,
            ],
          },
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: parseInt(limit),
      });

      // Group by type
      const groupedAlerts = {};
      alerts.forEach((alert) => {
        if (!groupedAlerts[alert.action]) {
          groupedAlerts[alert.action] = [];
        }
        groupedAlerts[alert.action].push(alert);
      });

      res.json({
        success: true,
        data: {
          total: alerts.length,
          summary: {
            loginFailures:
              groupedAlerts[this.auditActions.LOGIN_FAILED]?.length || 0,
            suspiciousActivity:
              groupedAlerts[this.auditActions.SUSPICIOUS_ACTIVITY]?.length || 0,
            rateLimitHits:
              groupedAlerts[this.auditActions.RATE_LIMIT_HIT]?.length || 0,
            accessDenied:
              groupedAlerts[this.auditActions.ACCESS_DENIED]?.length || 0,
          },
          alerts: alerts.slice(0, parseInt(limit)),
        },
      });
    } catch (error) {
      logger.error("Get recent alerts error:", error);
      next(error);
    }
  }

  /**
   * Clean up old audit logs
   * DELETE /api/v1/audit/cleanup
   */
  async cleanupOldLogs(req, res, next) {
    try {
      const { days = 90, confirm } = req.body;

      if (!confirm || confirm !== "CONFIRM_CLEANUP") {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Please confirm cleanup by sending 'confirm': 'CONFIRM_CLEANUP'",
          },
        });
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));

      const deleted = await prisma.auditLog.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
          action: {
            notIn: [
              this.auditActions.USER_DELETED,
              this.auditActions.ROLE_CHANGED,
              this.auditActions.CONFIG_UPDATED,
            ],
          },
        },
      });

      // Log the cleanup action
      await this.log(
        req.user.id,
        this.auditActions.SYSTEM_BACKUP,
        "AuditLog",
        null,
        null,
        { deletedCount: deleted.count, daysRetained: days },
        req,
      );

      logger.info(
        `Cleaned up ${deleted.count} old audit logs (older than ${days} days)`,
      );

      res.json({
        success: true,
        data: {
          deletedCount: deleted.count,
          daysRetained: parseInt(days),
          message: `Successfully deleted ${deleted.count} audit logs older than ${days} days`,
        },
      });
    } catch (error) {
      logger.error("Cleanup old logs error:", error);
      next(error);
    }
  }

  /**
   * Get real-time audit stream (WebSocket)
   * This is handled by WebSocket controller
   */
  async getAuditStream(req, res, next) {
    try {
      // This endpoint just returns the WebSocket connection info
      res.json({
        success: true,
        data: {
          message: "Connect to WebSocket for real-time audit stream",
          websocketUrl: `${process.env.WS_URL || "ws://localhost:3000"}/audit`,
        },
      });
    } catch (error) {
      logger.error("Get audit stream error:", error);
      next(error);
    }
  }

  /**
   * Helper: Get changed fields between two objects
   */
  getChangedFields(oldObj, newObj) {
    const changes = [];

    if (!oldObj || !newObj) return changes;

    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

    for (const key of allKeys) {
      if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
        changes.push({
          field: key,
          oldValue: oldObj[key],
          newValue: newObj[key],
        });
      }
    }

    return changes;
  }

  /**
   * Helper: Get audit actions list
   * GET /api/v1/audit/actions
   */
  getAuditActions(req, res, next) {
    res.json({
      success: true,
      data: this.auditActions,
    });
  }
}

module.exports = new AuditController();
