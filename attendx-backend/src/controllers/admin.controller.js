const bcrypt = require("bcryptjs");
const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const config = require("../config");
const csv = require("csv-parser");
const { Readable } = require("stream");
const { prisma, redisClient } = require("../index");

class AdminController {
  /**
   * List all users with advanced filtering
   * GET /api/v1/admin/users
   */
  async listUsers(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        role,
        search,
        isActive,
        sortBy = "createdAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = {};
      if (role) where.role = role;
      if (isActive !== undefined) where.isActive = isActive === "true";
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { regNumber: { contains: search, mode: "insensitive" } },
          { staffNumber: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } },
        ];
      }

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take,
          orderBy: { [sortBy]: sortOrder },
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
            regNumber: true,
            staffNumber: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: {
                devices: true,
                enrollments: true,
                taughtCourses: true,
                sessions: true,
              },
            },
          },
        }),
        prisma.user.count({ where }),
      ]);

      res.json({
        success: true,
        data: users,
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
      logger.error("List users error:", error);
      next(error);
    }
  }

  /**
   * Create new user
   * POST /api/v1/admin/users
   */
  async createUser(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid input",
            details: errors.array(),
          },
        });
      }

      const { fullName, email, phone, role, regNumber, staffNumber, password } =
        req.body;

      // Check for existing user
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            { email: email.toLowerCase() },
            { regNumber: regNumber || undefined },
            { staffNumber: staffNumber || undefined },
            { phone: phone || undefined },
          ],
        },
      });

      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: {
            code: "CONFLICT",
            message:
              "User with this email, phone, or registration number already exists",
          },
        });
      }

      const hashedPassword = await bcrypt.hash(
        password || "Temp@1234",
        parseInt(config.security?.bcryptRounds) || 10,
      );

      const user = await prisma.user.create({
        data: {
          fullName,
          email: email.toLowerCase(),
          phone,
          role,
          regNumber,
          staffNumber,
          passwordHash: hashedPassword,
          isActive: true,
        },
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
        },
      });

      // Create default notification preferences
      await prisma.notificationPreference.create({
        data: { userId: user.id },
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CREATE",
          entity: "User",
          entityId: user.id,
          newValues: { email: user.email, role: user.role },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`User created by ${req.user.email}: ${email} (${role})`);

      res.status(201).json({ success: true, data: user });
    } catch (error) {
      logger.error("Create user error:", error);
      next(error);
    }
  }

  /**
   * Bulk import users from CSV
   * POST /api/v1/admin/users/bulk-import
   */
  async bulkImportUsers(req, res, next) {
    let importJob = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "CSV file required" },
        });
      }

      const { role } = req.body;

      // Create import job record
      importJob = await prisma.bulkImportJob.create({
        data: {
          type: "users",
          status: "processing",
          totalRecords: 0,
          createdBy: req.user.id,
        },
      });

      const results = [];
      const errors = [];
      const csvString = req.file.buffer.toString("utf-8");
      const lines = csvString.split("\n").slice(1); // Skip header

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const [fullName, email, phone, regNumber, staffNumber, password] = line
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""));

        try {
          // Validate required fields
          if (!fullName || !email) {
            errors.push({
              row: i + 2,
              message: "Full name and email are required",
            });
            continue;
          }

          const existingUser = await prisma.user.findFirst({
            where: {
              OR: [
                { email: email.toLowerCase() },
                { regNumber: regNumber || undefined },
                { staffNumber: staffNumber || undefined },
              ],
            },
          });

          if (existingUser) {
            errors.push({
              row: i + 2,
              message: "Email or registration number already exists",
            });
            continue;
          }

          const hashedPassword = await bcrypt.hash(
            password || "Temp@1234",
            parseInt(config.security?.bcryptRounds) || 10,
          );

          const user = await prisma.user.create({
            data: {
              fullName,
              email: email.toLowerCase(),
              phone,
              role,
              regNumber,
              staffNumber,
              passwordHash: hashedPassword,
              isActive: true,
            },
          });

          await prisma.notificationPreference.create({
            data: { userId: user.id },
          });

          results.push(user);
        } catch (error) {
          logger.error(`Bulk import row ${i + 2} error:`, error);
          errors.push({ row: i + 2, message: error.message });
        }
      }

      // Update import job
      await prisma.bulkImportJob.update({
        where: { id: importJob.id },
        data: {
          status: "completed",
          totalRecords: lines.length,
          processedRecords: results.length,
          failedRecords: errors.length,
          errors: errors,
          completedAt: new Date(),
        },
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_IMPORT",
          entity: "User",
          newValues: { imported: results.length, failed: errors.length },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Bulk import completed by ${req.user.email}: ${results.length} imported, ${errors.length} failed`,
      );

      res.json({
        success: true,
        data: {
          jobId: importJob.id,
          imported: results.length,
          failed: errors.length,
          errors: errors.slice(0, 100), // Limit error response size
        },
      });
    } catch (error) {
      logger.error("Bulk import error:", error);

      // Update import job as failed
      if (importJob) {
        await prisma.bulkImportJob.update({
          where: { id: importJob.id },
          data: {
            status: "failed",
            errors: [{ message: error.message }],
            completedAt: new Date(),
          },
        });
      }

      next(error);
    }
  }

  /**
   * Get user by ID with full details
   * GET /api/v1/admin/users/:userId
   */
  async getUser(req, res, next) {
    try {
      const { userId } = req.params;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          notificationPref: true,
          devices: {
            where: { isActive: true },
            select: {
              id: true,
              deviceName: true,
              platform: true,
              lastSeenAt: true,
              isActive: true,
              isTrusted: true,
            },
          },
          enrollments: {
            where: { isActive: true },
            include: {
              course: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  credits: true,
                },
              },
            },
          },
          taughtCourses: {
            where: { isActive: true },
            select: {
              id: true,
              code: true,
              name: true,
              credits: true,
              _count: {
                select: { enrollments: true },
              },
            },
          },
          attendanceRecords: {
            take: 10,
            orderBy: { markedAt: "desc" },
            include: {
              session: {
                include: {
                  course: true,
                },
              },
            },
          },
        },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      // Remove sensitive data
      const {
        passwordHash,
        resetToken,
        resetTokenExpires,
        ...userWithoutPassword
      } = user;

      res.json({ success: true, data: userWithoutPassword });
    } catch (error) {
      logger.error("Get user error:", error);
      next(error);
    }
  }

  /**
   * Update user
   * PATCH /api/v1/admin/users/:userId
   */
  async updateUser(req, res, next) {
    try {
      const { userId } = req.params;
      const { fullName, phone, role, regNumber, staffNumber, isActive } =
        req.body;

      // Get old values for audit
      const oldUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, phone: true, role: true, isActive: true },
      });

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          ...(fullName && { fullName }),
          ...(phone && { phone }),
          ...(role && { role }),
          ...(regNumber && { regNumber }),
          ...(staffNumber && { staffNumber }),
          ...(isActive !== undefined && { isActive }),
        },
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
          updatedAt: true,
        },
      });

      // If deactivating, revoke all refresh tokens
      if (isActive === false) {
        await prisma.refreshToken.updateMany({
          where: { userId, revoked: false },
          data: { revoked: true },
        });

        if (redisClient && redisClient.isReady) {
          const keys = await redisClient.keys(`refresh:${userId}:*`);
          if (keys.length > 0) {
            await redisClient.del(keys);
          }
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE",
          entity: "User",
          entityId: userId,
          oldValues: oldUser,
          newValues: { fullName, phone, role, isActive },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate user cache
      if (redisClient && redisClient.isReady) {
        const cacheKeys = await redisClient.keys(`*${userId}*`);
        if (cacheKeys.length > 0) {
          await redisClient.del(cacheKeys);
        }
      }

      logger.info(`User updated by ${req.user.email}: ${user.email}`);

      res.json({ success: true, data: user });
    } catch (error) {
      logger.error("Update user error:", error);
      next(error);
    }
  }

  /**
   * Deactivate user (soft delete)
   * DELETE /api/v1/admin/users/:userId
   */
  async deactivateUser(req, res, next) {
    try {
      const { userId } = req.params;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, role: true, isActive: true },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      if (!user.isActive) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ALREADY_INACTIVE",
            message: "User is already deactivated",
          },
        });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
      });

      // Revoke all refresh tokens
      await prisma.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });

      // Clear Redis cache
      if (redisClient && redisClient.isReady) {
        const keys = await redisClient.keys(`refresh:${userId}:*`);
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
        const cacheKeys = await redisClient.keys(`*${userId}*`);
        if (cacheKeys.length > 0) {
          await redisClient.del(cacheKeys);
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "DEACTIVATE",
          entity: "User",
          entityId: userId,
          oldValues: { isActive: true },
          newValues: { isActive: false },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`User deactivated by ${req.user.email}: ${user.email}`);

      res.json({
        success: true,
        data: {
          message:
            "User deactivated successfully. All historical records preserved.",
        },
      });
    } catch (error) {
      logger.error("Deactivate user error:", error);
      next(error);
    }
  }

  /**
   * Force reset user password
   * POST /api/v1/admin/users/:userId/reset-password
   */
  async forceResetPassword(req, res, next) {
    try {
      const { userId } = req.params;
      const { newPassword } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, fullName: true },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      const hashedPassword = await bcrypt.hash(
        newPassword || crypto.randomBytes(8).toString("hex"),
        parseInt(config.security?.bcryptRounds) || 10,
      );

      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: hashedPassword },
      });

      // Revoke all refresh tokens for security
      await prisma.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "FORCE_RESET_PASSWORD",
          entity: "User",
          entityId: userId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Password force reset by ${req.user.email} for user: ${user.email}`,
      );

      res.json({
        success: true,
        data: {
          message: "Password reset successfully. User must login again.",
        },
      });
    } catch (error) {
      logger.error("Force reset password error:", error);
      next(error);
    }
  }

  /**
   * Get system-wide analytics overview
   * GET /api/v1/admin/analytics/overview
   */
  async getSystemOverview(req, res, next) {
    try {
      const cacheKey = "admin:system:overview";

      // Check cache
      let cachedData = null;
      if (redisClient && redisClient.isReady) {
        cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json({
            success: true,
            data: JSON.parse(cachedData),
            meta: { cached: true },
          });
        }
      }

      const [
        totalUsers,
        activeUsers,
        totalStudents,
        totalLecturers,
        totalAdmins,
        totalCourses,
        activeCourses,
        totalSessions,
        activeSessions,
        totalAttendance,
        presentAttendance,
        totalClassrooms,
        todaysCheckins,
        weeklyActiveUsers,
      ] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { isActive: true } }),
        prisma.user.count({ where: { role: "student", isActive: true } }),
        prisma.user.count({ where: { role: "lecturer", isActive: true } }),
        prisma.user.count({ where: { role: "admin", isActive: true } }),
        prisma.course.count(),
        prisma.course.count({ where: { isActive: true } }),
        prisma.session.count(),
        prisma.session.count({ where: { status: "active" } }),
        prisma.attendanceRecord.count(),
        prisma.attendanceRecord.count({ where: { status: "present" } }),
        prisma.classroom.count({ where: { isActive: true } }),
        prisma.roomCheckin.count({
          where: {
            checkedInAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
        }),
        prisma.user.count({
          where: {
            lastLoginAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
        }),
      ]);

      const responseData = {
        users: {
          total: totalUsers,
          active: activeUsers,
          students: totalStudents,
          lecturers: totalLecturers,
          admins: totalAdmins,
          weeklyActive: weeklyActiveUsers,
        },
        academics: {
          totalCourses,
          activeCourses,
          totalSessions,
          activeSessions,
          totalClassrooms,
        },
        attendance: {
          totalRecords: totalAttendance,
          presentCount: presentAttendance,
          attendanceRate:
            totalAttendance > 0
              ? parseFloat(
                  ((presentAttendance / totalAttendance) * 100).toFixed(2),
                )
              : 0,
          todaysCheckins,
        },
        timestamp: new Date(),
      };

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(responseData));
      }

      res.json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      logger.error("Get system overview error:", error);
      next(error);
    }
  }

  /**
   * Get system configuration
   * GET /api/v1/admin/config
   */
  async getSystemConfig(req, res, next) {
    try {
      let config = await prisma.systemConfig.findUnique({
        where: { id: "singleton" },
      });

      if (!config) {
        config = await prisma.systemConfig.create({
          data: { id: "singleton" },
        });
      }

      res.json({ success: true, data: config });
    } catch (error) {
      logger.error("Get system config error:", error);
      next(error);
    }
  }

  /**
   * Update system configuration
   * PUT /api/v1/admin/config
   */
  async updateSystemConfig(req, res, next) {
    try {
      const config = await prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: {
          ...req.body,
          updatedBy: req.user.id,
          updatedAt: new Date(),
        },
        create: {
          id: "singleton",
          ...req.body,
          updatedBy: req.user.id,
        },
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_CONFIG",
          entity: "SystemConfig",
          newValues: req.body,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Clear system config cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del("admin:system:overview");
      }

      logger.info(`System config updated by ${req.user.email}`);

      res.json({ success: true, data: config });
    } catch (error) {
      logger.error("Update system config error:", error);
      next(error);
    }
  }

  /**
   * Get system health and stats
   * GET /api/v1/admin/system/stats
   */
  async getSystemStats(req, res, next) {
    try {
      const [
        activeSessions,
        redisConnected,
        dbStats,
        lastAttendance,
        uploadDirSize,
      ] = await Promise.all([
        prisma.session.count({
          where: { status: "active", checkinOpen: true },
        }),
        redisClient && redisClient.isReady
          ? redisClient
              .ping()
              .then(() => true)
              .catch(() => false)
          : false,
        prisma.$queryRaw`SELECT 
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as connections,
          (SELECT pg_database_size(current_database()) / 1024 / 1024 as size_mb) as db_size_mb`,
        prisma.attendanceRecord.findFirst({
          orderBy: { markedAt: "desc" },
          select: { markedAt: true },
        }),
        Promise.resolve(0), // Placeholder for upload dir size calculation
      ]);

      res.json({
        success: true,
        data: {
          activeSessions,
          redis: {
            connected: redisConnected,
            latency: redisConnected ? "< 1ms" : "N/A",
          },
          database: {
            connections: dbStats[0]?.connections || 0,
            sizeMB: dbStats[0]?.db_size_mb || 0,
            lastAttendanceRecord: lastAttendance?.markedAt || null,
          },
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          timestamp: new Date(),
          version: process.env.npm_package_version || "1.0.0",
        },
      });
    } catch (error) {
      logger.error("Get system stats error:", error);
      next(error);
    }
  }

  /**
   * Get audit logs
   * GET /api/v1/admin/audit-logs
   */
  async getAuditLogs(req, res, next) {
    try {
      const {
        page = 1,
        limit = 50,
        action,
        entity,
        userId,
        from,
        to,
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const where = {};

      if (action) where.action = action;
      if (entity) where.entity = entity;
      if (userId) where.userId = userId;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt.gte = new Date(from);
        if (to) where.createdAt.lte = new Date(to);
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
        },
      });
    } catch (error) {
      logger.error("Get audit logs error:", error);
      next(error);
    }
  }
}

module.exports = new AdminController();
