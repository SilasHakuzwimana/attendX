const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const { calculateDistance } = require("../services/geofence.service");

class ClassroomController {
  /**
   * Get all classrooms with pagination and filtering
   * GET /api/v1/classrooms
   */
  async getClassrooms(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        search,
        building,
        minCapacity,
        isActive = true,
        sortBy = "name",
        sortOrder = "asc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = { isActive: isActive === "true" };

      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { building: { contains: search, mode: "insensitive" } },
          { code: { contains: search, mode: "insensitive" } },
        ];
      }

      if (building) {
        where.building = { contains: building, mode: "insensitive" };
      }

      if (minCapacity) {
        where.capacity = { gte: parseInt(minCapacity) };
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
          orderBy: { [sortBy]: sortOrder },
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
      logger.error("Get classrooms error:", error);
      next(error);
    }
  }

  /**
   * Get classroom by ID with details
   * GET /api/v1/classrooms/:classroomId
   */
  async getClassroomById(req, res, next) {
    try {
      const { classroomId } = req.params;

      const classroom = await prisma.classroom.findUnique({
        where: { id: classroomId },
        include: {
          sessions: {
            orderBy: { startedAt: "desc" },
            take: 10,
            include: {
              course: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                },
              },
              _count: {
                select: { roomCheckins: true },
              },
            },
          },
        },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      // Get comprehensive statistics
      const totalSessions = await prisma.session.count({
        where: { classroomId },
      });

      const activeSessions = await prisma.session.count({
        where: {
          classroomId,
          status: "active",
        },
      });

      const totalCheckins = await prisma.roomCheckin.count({
        where: {
          session: { classroomId },
        },
      });

      const uniqueStudents = await prisma.roomCheckin.groupBy({
        by: ["studentId"],
        where: {
          session: { classroomId },
        },
        _count: true,
      });

      const sessionsByDay = await prisma.$queryRaw`
        SELECT 
          DATE(started_at) as date,
          COUNT(*) as session_count,
          SUM(checkins_count) as total_checkins
        FROM sessions
        WHERE classroom_id = ${classroomId}
        GROUP BY DATE(started_at)
        ORDER BY date DESC
        LIMIT 30
      `;

      // Get upcoming sessions
      const upcomingSessions = await prisma.session.findMany({
        where: {
          classroomId,
          status: "active",
          startedAt: { gt: new Date() },
        },
        include: {
          course: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
        orderBy: { startedAt: "asc" },
        take: 5,
      });

      res.json({
        success: true,
        data: {
          ...classroom,
          statistics: {
            totalSessions,
            activeSessions,
            totalCheckins,
            uniqueStudentsCount: uniqueStudents.length,
            averageCheckinsPerSession:
              totalSessions > 0
                ? parseFloat((totalCheckins / totalSessions).toFixed(1))
                : 0,
            utilizationRate:
              totalSessions > 0
                ? parseFloat(
                    ((activeSessions / totalSessions) * 100).toFixed(1),
                  )
                : 0,
          },
          upcomingSessions,
          recentSessions: classroom.sessions,
          sessionsByDay,
        },
      });
    } catch (error) {
      logger.error("Get classroom by ID error:", error);
      next(error);
    }
  }

  /**
   * Create new classroom (Admin only)
   * POST /api/v1/classrooms
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

      // Validate coordinates
      if (latitude && (latitude < -90 || latitude > 90)) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Latitude must be between -90 and 90",
          },
        });
      }

      if (longitude && (longitude < -180 || longitude > 180)) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Longitude must be between -180 and 180",
          },
        });
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
        await redisClient.del("classrooms:list");
      }

      logger.info(
        `Classroom created by ${req.user.email}: ${name} (${code || "no code"})`,
      );

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
   * Update classroom (Admin only)
   * PUT /api/v1/classrooms/:classroomId
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

      // Check if classroom exists
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

      // Validate coordinates if provided
      if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Latitude must be between -90 and 90",
          },
        });
      }

      if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Longitude must be between -180 and 180",
          },
        });
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

      // Create audit log
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
        const cacheKeys = [
          `classroom:${classroomId}`,
          "admin:classrooms:list",
          "classrooms:list",
          "geofence:classrooms",
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
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
   * Delete/Deactivate classroom (Admin only)
   * DELETE /api/v1/classrooms/:classroomId
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
            include: {
              course: true,
            },
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

      // Create audit log
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

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `classroom:${classroomId}`,
          "admin:classrooms:list",
          "classrooms:list",
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
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

  /**
   * Get classrooms for dropdown/select inputs
   * GET /api/v1/classrooms/list
   */
  async getClassroomList(req, res, next) {
    try {
      const cacheKey = "classrooms:list";

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

      const classrooms = await prisma.classroom.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          building: true,
          code: true,
          capacity: true,
          latitude: true,
          longitude: true,
          radiusM: true,
        },
        orderBy: { name: "asc" },
      });

      // Cache for 1 hour
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(classrooms));
      }

      res.json({
        success: true,
        data: classrooms,
      });
    } catch (error) {
      logger.error("Get classroom list error:", error);
      next(error);
    }
  }

  /**
   * Get classrooms by building
   * GET /api/v1/classrooms/buildings
   */
  async getBuildings(req, res, next) {
    try {
      const buildings = await prisma.classroom.groupBy({
        by: ["building"],
        where: { isActive: true },
        _count: {
          _all: true,
        },
        orderBy: { building: "asc" },
      });

      // Get classroom counts per building
      const buildingsWithDetails = await Promise.all(
        buildings.map(async (b) => {
          const classrooms = await prisma.classroom.findMany({
            where: {
              building: b.building,
              isActive: true,
            },
            select: {
              id: true,
              name: true,
              code: true,
              capacity: true,
            },
          });

          const totalCapacity = classrooms.reduce(
            (sum, c) => sum + (c.capacity || 0),
            0,
          );

          return {
            building: b.building || "Uncategorized",
            classroomCount: b._count._all,
            totalCapacity,
            classrooms,
          };
        }),
      );

      res.json({
        success: true,
        data: buildingsWithDetails,
      });
    } catch (error) {
      logger.error("Get buildings error:", error);
      next(error);
    }
  }

  /**
   * Get available classrooms for a given time slot
   * GET /api/v1/classrooms/available
   */
  async getAvailableClassrooms(req, res, next) {
    try {
      const { date, startTime, endTime, minCapacity, building } = req.query;

      if (!date || !startTime || !endTime) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Date, startTime, and endTime are required",
          },
        });
      }

      const targetDate = new Date(date);
      const startDateTime = new Date(`${date}T${startTime}`);
      const endDateTime = new Date(`${date}T${endTime}`);

      // Get all active classrooms
      const where = { isActive: true };
      if (minCapacity) where.capacity = { gte: parseInt(minCapacity) };
      if (building)
        where.building = { contains: building, mode: "insensitive" };

      const allClassrooms = await prisma.classroom.findMany({
        where,
        select: {
          id: true,
          name: true,
          building: true,
          code: true,
          capacity: true,
          latitude: true,
          longitude: true,
          radiusM: true,
        },
      });

      // Get occupied classrooms during the time slot
      const occupiedSessions = await prisma.session.findMany({
        where: {
          classroomId: { in: allClassrooms.map((c) => c.id) },
          startedAt: { lt: endDateTime },
          expiresAt: { gt: startDateTime },
          status: { in: ["active", "scheduled"] },
        },
        select: {
          classroomId: true,
          id: true,
          sessionCode: true,
          startedAt: true,
          expiresAt: true,
          course: {
            select: {
              code: true,
              name: true,
            },
          },
        },
      });

      const occupiedClassroomIds = new Set(
        occupiedSessions.map((s) => s.classroomId),
      );

      const availableClassrooms = allClassrooms
        .filter((c) => !occupiedClassroomIds.has(c.id))
        .map((c) => ({
          ...c,
          isAvailable: true,
        }));

      const occupiedClassrooms = allClassrooms
        .filter((c) => occupiedClassroomIds.has(c.id))
        .map((c) => ({
          ...c,
          isAvailable: false,
          currentSession: occupiedSessions.find((s) => s.classroomId === c.id),
        }));

      res.json({
        success: true,
        data: {
          date: targetDate,
          timeSlot: {
            start: startDateTime,
            end: endDateTime,
          },
          summary: {
            total: allClassrooms.length,
            available: availableClassrooms.length,
            occupied: occupiedClassrooms.length,
          },
          available: availableClassrooms,
          occupied: occupiedClassrooms,
        },
      });
    } catch (error) {
      logger.error("Get available classrooms error:", error);
      next(error);
    }
  }

  /**
   * Get classroom utilization statistics
   * GET /api/v1/classrooms/utilization
   */
  async getClassroomUtilization(req, res, next) {
    try {
      const { period = "month", startDate, endDate } = req.query;

      let start = startDate ? new Date(startDate) : new Date();
      let end = endDate ? new Date(endDate) : new Date();

      switch (period) {
        case "week":
          start.setDate(start.getDate() - 7);
          break;
        case "month":
          start.setMonth(start.getMonth() - 1);
          break;
        case "semester":
          start.setMonth(start.getMonth() - 6);
          break;
        case "year":
          start.setFullYear(start.getFullYear() - 1);
          break;
        default:
          start.setMonth(start.getMonth() - 1);
      }

      const classrooms = await prisma.classroom.findMany({
        where: { isActive: true },
        include: {
          sessions: {
            where: {
              startedAt: { gte: start, lte: end },
            },
            include: {
              _count: {
                select: { roomCheckins: true },
              },
            },
          },
        },
      });

      const utilizationData = classrooms.map((classroom) => {
        const totalSessions = classroom.sessions.length;
        const totalHours = classroom.sessions.reduce((sum, s) => {
          const duration =
            (new Date(s.expiresAt) - new Date(s.startedAt)) / (1000 * 60 * 60);
          return sum + duration;
        }, 0);

        const totalCheckins = classroom.sessions.reduce(
          (sum, s) => sum + s._count.roomCheckins,
          0,
        );

        const availableHours = 8 * 5 * 4; // 8 hours/day, 5 days/week, 4 weeks (simplified)
        const utilizationRate =
          availableHours > 0 ? (totalHours / availableHours) * 100 : 0;

        return {
          id: classroom.id,
          name: classroom.name,
          building: classroom.building,
          code: classroom.code,
          capacity: classroom.capacity,
          statistics: {
            totalSessions,
            totalHours: parseFloat(totalHours.toFixed(1)),
            totalCheckins,
            averageCheckinsPerSession:
              totalSessions > 0
                ? parseFloat((totalCheckins / totalSessions).toFixed(1))
                : 0,
            utilizationRate: parseFloat(utilizationRate.toFixed(1)),
          },
        };
      });

      // Sort by utilization rate
      utilizationData.sort(
        (a, b) => b.statistics.utilizationRate - a.statistics.utilizationRate,
      );

      res.json({
        success: true,
        data: {
          period,
          dateRange: { start, end },
          totalClassrooms: utilizationData.length,
          averageUtilization:
            utilizationData.length > 0
              ? parseFloat(
                  (
                    utilizationData.reduce(
                      (sum, c) => sum + c.statistics.utilizationRate,
                      0,
                    ) / utilizationData.length
                  ).toFixed(1),
                )
              : 0,
          classrooms: utilizationData,
        },
      });
    } catch (error) {
      logger.error("Get classroom utilization error:", error);
      next(error);
    }
  }

  /**
   * Verify geofence for a classroom
   * POST /api/v1/classrooms/:classroomId/verify-geofence
   */
  async verifyGeofence(req, res, next) {
    try {
      const { classroomId } = req.params;
      const { latitude, longitude } = req.body;

      if (!latitude || !longitude) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Latitude and longitude are required",
          },
        });
      }

      const classroom = await prisma.classroom.findUnique({
        where: { id: classroomId, isActive: true },
        select: {
          id: true,
          name: true,
          building: true,
          latitude: true,
          longitude: true,
          radiusM: true,
        },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      // Calculate distance
      const distance = calculateDistance(
        parseFloat(latitude),
        parseFloat(longitude),
        parseFloat(classroom.latitude),
        parseFloat(classroom.longitude),
      );

      const isWithinGeofence = distance <= classroom.radiusM;

      res.json({
        success: true,
        data: {
          classroom: {
            id: classroom.id,
            name: classroom.name,
            building: classroom.building,
          },
          userLocation: { latitude, longitude },
          classroomLocation: {
            latitude: classroom.latitude,
            longitude: classroom.longitude,
            radiusM: classroom.radiusM,
          },
          distanceM: Math.round(distance),
          isWithinGeofence,
          message: isWithinGeofence
            ? `You are within the geofence (${Math.round(distance)}m / ${classroom.radiusM}m)`
            : `You are ${Math.round(distance)}m away. Must be within ${classroom.radiusM}m`,
        },
      });
    } catch (error) {
      logger.error("Verify geofence error:", error);
      next(error);
    }
  }

  /**
   * Get nearby classrooms based on GPS coordinates
   * GET /api/v1/classrooms/nearby
   */
  async getNearbyClassrooms(req, res, next) {
    try {
      const { latitude, longitude, radius = 500, limit = 10 } = req.query;

      if (!latitude || !longitude) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Latitude and longitude are required",
          },
        });
      }

      const classrooms = await prisma.classroom.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          building: true,
          code: true,
          capacity: true,
          latitude: true,
          longitude: true,
          radiusM: true,
        },
      });

      // Calculate distances and filter
      const classroomsWithDistance = classrooms
        .map((classroom) => ({
          ...classroom,
          distanceM: calculateDistance(
            parseFloat(latitude),
            parseFloat(longitude),
            parseFloat(classroom.latitude),
            parseFloat(classroom.longitude),
          ),
        }))
        .filter((c) => c.distanceM <= parseFloat(radius))
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, parseInt(limit));

      res.json({
        success: true,
        data: {
          userLocation: { latitude, longitude },
          radius: parseFloat(radius),
          totalFound: classroomsWithDistance.length,
          classrooms: classroomsWithDistance.map((c) => ({
            ...c,
            distanceM: Math.round(c.distanceM),
            isWithinGeofence: c.distanceM <= c.radiusM,
          })),
        },
      });
    } catch (error) {
      logger.error("Get nearby classrooms error:", error);
      next(error);
    }
  }

  /**
   * Get classroom schedule for a specific date
   * GET /api/v1/classrooms/:classroomId/schedule
   */
  async getClassroomSchedule(req, res, next) {
    try {
      const { classroomId } = req.params;
      const { date } = req.query;

      const targetDate = date ? new Date(date) : new Date();
      targetDate.setHours(0, 0, 0, 0);
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);

      const classroom = await prisma.classroom.findUnique({
        where: { id: classroomId },
        select: {
          id: true,
          name: true,
          building: true,
          code: true,
          capacity: true,
        },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Classroom not found" },
        });
      }

      const sessions = await prisma.session.findMany({
        where: {
          classroomId,
          startedAt: { gte: targetDate, lt: nextDay },
        },
        include: {
          course: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
          lecturer: {
            select: {
              id: true,
              fullName: true,
            },
          },
          _count: {
            select: { roomCheckins: true },
          },
        },
        orderBy: { startedAt: "asc" },
      });

      const schedule = sessions.map((session) => ({
        id: session.id,
        sessionCode: session.sessionCode,
        startTime: session.startedAt,
        endTime: session.expiresAt,
        course: session.course,
        lecturer: session.lecturer,
        status: session.status,
        checkins: session._count.roomCheckins,
        duration: Math.floor(
          (new Date(session.expiresAt) - new Date(session.startedAt)) / 60000,
        ),
      }));

      res.json({
        success: true,
        data: {
          classroom,
          date: targetDate,
          schedule,
          summary: {
            totalSessions: schedule.length,
            activeSessions: schedule.filter((s) => s.status === "active")
              .length,
            totalCheckins: schedule.reduce((sum, s) => sum + s.checkins, 0),
          },
        },
      });
    } catch (error) {
      logger.error("Get classroom schedule error:", error);
      next(error);
    }
  }
}

module.exports = new ClassroomController();
