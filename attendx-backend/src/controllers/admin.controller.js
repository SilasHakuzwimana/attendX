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

  /**
   * List all courses with filtering
   * GET /api/v1/admin/courses
   */
  async listCourses(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        search,
        lecturerId,
        semester,
        academicYear,
        isActive,
        sortBy = "createdAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = {};
      if (search) {
        where.OR = [
          { code: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ];
      }
      if (lecturerId) where.lecturerId = lecturerId;
      if (semester) where.semester = semester;
      if (academicYear) where.academicYear = academicYear;
      if (isActive !== undefined) where.isActive = isActive === "true";

      const [courses, total] = await Promise.all([
        prisma.course.findMany({
          where,
          include: {
            lecturer: {
              select: {
                id: true,
                fullName: true,
                email: true,
                staffNumber: true,
              },
            },
            _count: {
              select: {
                enrollments: {
                  where: { isActive: true },
                },
                sessions: true,
              },
            },
          },
          orderBy: { [sortBy]: sortOrder },
          skip,
          take,
        }),
        prisma.course.count({ where }),
      ]);

      // Add statistics to each course
      const coursesWithStats = await Promise.all(
        courses.map(async (course) => {
          const totalCheckins = await prisma.roomCheckin.count({
            where: { session: { courseId: course.id } },
          });

          const totalEnrolled = course._count.enrollments;
          const totalSessions = course._count.sessions;
          const expectedAttendances = totalEnrolled * totalSessions;
          const attendanceRate =
            expectedAttendances > 0
              ? (totalCheckins / expectedAttendances) * 100
              : 0;

          return {
            ...course,
            statistics: {
              totalEnrolled,
              totalSessions,
              totalCheckins,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
            },
          };
        }),
      );

      res.json({
        success: true,
        data: coursesWithStats,
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
      logger.error("List courses error:", error);
      next(error);
    }
  }

  /**
   * Create new course
   * POST /api/v1/admin/courses
   */
  async createCourse(req, res, next) {
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

      const {
        code,
        name,
        description,
        credits = 3,
        semester,
        academicYear,
        lecturerId,
      } = req.body;

      // Check if course code already exists
      const existingCourse = await prisma.course.findUnique({
        where: { code: code.toUpperCase() },
      });

      if (existingCourse) {
        return res.status(409).json({
          success: false,
          error: {
            code: "CONFLICT",
            message: "Course code already exists",
          },
        });
      }

      // Verify lecturer exists
      if (lecturerId) {
        const lecturer = await prisma.user.findFirst({
          where: {
            id: lecturerId,
            role: "lecturer",
            isActive: true,
          },
        });

        if (!lecturer) {
          return res.status(404).json({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: "Lecturer not found or inactive",
            },
          });
        }
      }

      const course = await prisma.course.create({
        data: {
          code: code.toUpperCase(),
          name,
          description,
          credits,
          semester: semester || new Date().getFullYear().toString(),
          academicYear:
            academicYear ||
            `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
          lecturerId,
          isActive: true,
        },
        include: {
          lecturer: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CREATE_COURSE",
          entity: "Course",
          entityId: course.id,
          newValues: { code, name, credits, lecturerId },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Course created by ${req.user.email}: ${code} - ${name}`);

      res.status(201).json({
        success: true,
        data: course,
        message: "Course created successfully",
      });
    } catch (error) {
      logger.error("Create course error:", error);
      next(error);
    }
  }

  /**
   * Update course
   * PATCH /api/v1/admin/courses/:courseId
   */
  async updateCourse(req, res, next) {
    try {
      const { courseId } = req.params;
      const {
        name,
        lecturerId,
        credits,
        description,
        isActive,
        semester,
        academicYear,
      } = req.body;

      const existingCourse = await prisma.course.findUnique({
        where: { id: courseId },
      });

      if (!existingCourse) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      if (lecturerId && lecturerId !== existingCourse.lecturerId) {
        const lecturer = await prisma.user.findFirst({
          where: {
            id: lecturerId,
            role: "lecturer",
            isActive: true,
          },
        });

        if (!lecturer) {
          return res.status(404).json({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: "Lecturer not found or inactive",
            },
          });
        }
      }

      const course = await prisma.course.update({
        where: { id: courseId },
        data: {
          ...(name && { name }),
          ...(lecturerId && { lecturerId }),
          ...(credits && { credits }),
          ...(description !== undefined && { description }),
          ...(isActive !== undefined && { isActive }),
          ...(semester && { semester }),
          ...(academicYear && { academicYear }),
        },
        include: {
          lecturer: {
            select: {
              id: true,
              fullName: true,
              email: true,
            },
          },
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_COURSE",
          entity: "Course",
          entityId: courseId,
          oldValues: {
            name: existingCourse.name,
            lecturerId: existingCourse.lecturerId,
            isActive: existingCourse.isActive,
          },
          newValues: { name, lecturerId, isActive },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`course:${courseId}`);
      }

      logger.info(
        `Course updated by ${req.user.email}: ${existingCourse.code}`,
      );

      res.json({
        success: true,
        data: course,
        message: "Course updated successfully",
      });
    } catch (error) {
      logger.error("Update course error:", error);
      next(error);
    }
  }

  /**
   * Deactivate course
   * DELETE /api/v1/admin/courses/:courseId
   */
  async deactivateCourse(req, res, next) {
    try {
      const { courseId } = req.params;

      const course = await prisma.course.findUnique({
        where: { id: courseId },
        include: {
          sessions: {
            where: { status: "active" },
          },
        },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      if (course.sessions.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ACTIVE_SESSIONS",
            message: "Cannot deactivate course with active sessions",
          },
        });
      }

      const updatedCourse = await prisma.course.update({
        where: { id: courseId },
        data: { isActive: false },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "DEACTIVATE_COURSE",
          entity: "Course",
          entityId: courseId,
          oldValues: { isActive: true },
          newValues: { isActive: false },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Course deactivated by ${req.user.email}: ${course.code}`);

      res.json({
        success: true,
        data: {
          id: courseId,
          code: course.code,
          name: course.name,
          isActive: false,
        },
        message: "Course deactivated successfully",
      });
    } catch (error) {
      logger.error("Deactivate course error:", error);
      next(error);
    }
  }

  /**
   * Enroll students in course
   * POST /api/v1/admin/courses/:courseId/enrollments
   */
  async enrollStudents(req, res, next) {
    try {
      const { courseId } = req.params;
      const { studentIds } = req.body;

      const course = await prisma.course.findUnique({
        where: { id: courseId, isActive: true },
        select: { id: true, code: true, name: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      const students = await prisma.user.findMany({
        where: {
          id: { in: studentIds },
          role: "student",
          isActive: true,
        },
        select: { id: true, fullName: true, email: true },
      });

      let enrolled = 0;
      let alreadyEnrolled = 0;

      for (const student of students) {
        try {
          await prisma.enrollment.create({
            data: {
              studentId: student.id,
              courseId,
              isActive: true,
            },
          });
          enrolled++;
        } catch (error) {
          if (error.code === "P2002") {
            alreadyEnrolled++;
          } else {
            throw error;
          }
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "ENROLL_STUDENTS",
          entity: "Course",
          entityId: courseId,
          newValues: { enrolled, alreadyEnrolled },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `${enrolled} students enrolled in course ${course.code} by ${req.user.email}`,
      );

      res.json({
        success: true,
        data: {
          course,
          enrolled,
          alreadyEnrolled,
          message: `${enrolled} students enrolled successfully`,
        },
      });
    } catch (error) {
      logger.error("Enroll students error:", error);
      next(error);
    }
  }

  /**
   * Remove student from course
   * DELETE /api/v1/admin/courses/:courseId/enrollments/:studentId
   */
  async removeStudent(req, res, next) {
    try {
      const { courseId, studentId } = req.params;

      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true,
        },
      });

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Enrollment not found" },
        });
      }

      await prisma.enrollment.update({
        where: { id: enrollment.id },
        data: {
          isActive: false,
          droppedAt: new Date(),
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "REMOVE_STUDENT",
          entity: "Enrollment",
          entityId: enrollment.id,
          newValues: { studentId, courseId, isActive: false },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Student removed from course by ${req.user.email}`);

      res.json({
        success: true,
        data: { message: "Student removed from course successfully" },
      });
    } catch (error) {
      logger.error("Remove student error:", error);
      next(error);
    }
  }

  // Add these methods to your AdminController class in admin.controller.js

  // ==================== CLASSROOM MANAGEMENT METHODS ====================

  /**
   * List all classrooms
   * GET /api/v1/admin/classrooms
   */
  async listClassrooms(req, res, next) {
    try {
      const { page = 1, limit = 20, building, isActive = true } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = { isActive: isActive === "true" };
      if (building) {
        where.building = { contains: building, mode: "insensitive" };
      }

      const [classrooms, total] = await Promise.all([
        prisma.classroom.findMany({
          where,
          include: {
            _count: {
              select: {
                sessions: {
                  where: { status: "active" },
                },
              },
            },
          },
          orderBy: { name: "asc" },
          skip,
          take,
        }),
        prisma.classroom.count({ where }),
      ]);

      // Add additional statistics
      const classroomsWithStats = await Promise.all(
        classrooms.map(async (classroom) => {
          const totalSessions = await prisma.session.count({
            where: { classroomId: classroom.id },
          });

          const activeSessions = await prisma.session.count({
            where: {
              classroomId: classroom.id,
              status: "active",
            },
          });

          const totalCheckins = await prisma.roomCheckin.count({
            where: {
              session: { classroomId: classroom.id },
            },
          });

          const lastUsed = await prisma.session.findFirst({
            where: { classroomId: classroom.id },
            orderBy: { startedAt: "desc" },
            select: { startedAt: true },
          });

          return {
            ...classroom,
            statistics: {
              totalSessions,
              activeSessions,
              totalCheckins,
              lastUsed: lastUsed?.startedAt || null,
              utilizationRate:
                totalSessions > 0 ? (activeSessions / totalSessions) * 100 : 0,
            },
          };
        }),
      );

      res.json({
        success: true,
        data: classroomsWithStats,
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
      logger.error("List classrooms error:", error);
      next(error);
    }
  }

  /**
   * Create new classroom
   * POST /api/v1/admin/classrooms
   */
  async createClassroom(req, res, next) {
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

      const {
        name,
        building,
        code,
        capacity,
        latitude,
        longitude,
        radiusM = 50,
      } = req.body;

      // Check if classroom code already exists
      if (code) {
        const existingClassroom = await prisma.classroom.findUnique({
          where: { code: code.toUpperCase() },
        });

        if (existingClassroom) {
          return res.status(409).json({
            success: false,
            error: {
              code: "CONFLICT",
              message: "Classroom code already exists",
            },
          });
        }
      }

      const classroom = await prisma.classroom.create({
        data: {
          name,
          building,
          code: code ? code.toUpperCase() : null,
          capacity: capacity || null,
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          radiusM: parseInt(radiusM),
          isActive: true,
        },
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CREATE_CLASSROOM",
          entity: "Classroom",
          entityId: classroom.id,
          newValues: {
            name,
            building,
            code,
            capacity,
            latitude,
            longitude,
            radiusM,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del("admin:classrooms:list");
      }

      logger.info(`Classroom created by ${req.user.email}: ${name}`);

      res.status(201).json({
        success: true,
        data: classroom,
        message: "Classroom created successfully",
      });
    } catch (error) {
      logger.error("Create classroom error:", error);
      next(error);
    }
  }

  /**
   * Update classroom
   * PATCH /api/v1/admin/classrooms/:classroomId
   */
  async updateClassroom(req, res, next) {
    try {
      const { classroomId } = req.params;
      const {
        name,
        building,
        code,
        capacity,
        latitude,
        longitude,
        radiusM,
        isActive,
      } = req.body;

      const existingClassroom = await prisma.classroom.findUnique({
        where: { id: classroomId },
      });

      if (!existingClassroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      // Check code uniqueness if changing
      if (code && code !== existingClassroom.code) {
        const codeExists = await prisma.classroom.findUnique({
          where: { code: code.toUpperCase() },
        });

        if (codeExists) {
          return res.status(409).json({
            success: false,
            error: {
              code: "CONFLICT",
              message: "Classroom code already exists",
            },
          });
        }
      }

      const classroom = await prisma.classroom.update({
        where: { id: classroomId },
        data: {
          ...(name && { name }),
          ...(building !== undefined && { building }),
          ...(code && { code: code.toUpperCase() }),
          ...(capacity !== undefined && { capacity: capacity || null }),
          ...(latitude !== undefined && { latitude: parseFloat(latitude) }),
          ...(longitude !== undefined && { longitude: parseFloat(longitude) }),
          ...(radiusM && { radiusM: parseInt(radiusM) }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_CLASSROOM",
          entity: "Classroom",
          entityId: classroomId,
          oldValues: {
            name: existingClassroom.name,
            building: existingClassroom.building,
            code: existingClassroom.code,
            capacity: existingClassroom.capacity,
            isActive: existingClassroom.isActive,
          },
          newValues: { name, building, code, capacity, isActive },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`classroom:${classroomId}`);
        await redisClient.del("admin:classrooms:list");
      }

      logger.info(`Classroom updated by ${req.user.email}: ${classroom.name}`);

      res.json({
        success: true,
        data: classroom,
        message: "Classroom updated successfully",
      });
    } catch (error) {
      logger.error("Update classroom error:", error);
      next(error);
    }
  }

  /**
   * Delete/Deactivate classroom
   * DELETE /api/v1/admin/classrooms/:classroomId
   */
  async deleteClassroom(req, res, next) {
    try {
      const { classroomId } = req.params;
      const { force = false } = req.query;

      const classroom = await prisma.classroom.findUnique({
        where: { id: classroomId },
        include: {
          sessions: {
            where: { status: "active" },
            include: { course: true },
          },
        },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      // Check for active sessions
      if (classroom.sessions.length > 0 && !force) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ACTIVE_SESSIONS",
            message: "Cannot delete classroom with active sessions",
            data: {
              activeSessions: classroom.sessions.map((s) => ({
                id: s.id,
                sessionCode: s.sessionCode,
                courseName: s.course.name,
              })),
            },
          },
        });
      }

      // Soft delete - deactivate classroom
      const updatedClassroom = await prisma.classroom.update({
        where: { id: classroomId },
        data: { isActive: false },
      });

      // If force delete, also deactivate all active sessions
      if (force && classroom.sessions.length > 0) {
        await prisma.session.updateMany({
          where: { classroomId, status: "active" },
          data: {
            status: "expired",
            checkinOpen: false,
          },
        });
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "DELETE_CLASSROOM",
          entity: "Classroom",
          entityId: classroomId,
          oldValues: { isActive: true },
          newValues: { isActive: false },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      if (redisClient && redisClient.isReady) {
        await redisClient.del(`classroom:${classroomId}`);
        await redisClient.del("admin:classrooms:list");
      }

      logger.info(
        `Classroom deactivated by ${req.user.email}: ${classroom.name}`,
      );

      res.json({
        success: true,
        data: {
          id: classroomId,
          name: classroom.name,
          isActive: false,
          ...(force &&
            classroom.sessions.length > 0 && {
              deactivatedSessions: classroom.sessions.length,
            }),
        },
        message: force
          ? "Classroom deactivated and associated sessions closed"
          : "Classroom deactivated successfully",
      });
    } catch (error) {
      logger.error("Delete classroom error:", error);
      next(error);
    }
  }
}

module.exports = new AdminController();
