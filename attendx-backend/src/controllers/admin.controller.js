const bcrypt = require("bcryptjs");
const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const config = require("../config");
const csv = require("csv-parser");
const { Readable } = require("stream");

class AdminController {
  /**
   * List all users
   * GET /api/admin/users
   */
  async listUsers(req, res, next) {
    try {
      const { page = 1, limit = 20, role, search, isActive } = req.query;
      const skip = (page - 1) * limit;

      const where = {};
      if (role) where.role = role;
      if (isActive !== undefined) where.isActive = isActive === "true";
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { regNumber: { contains: search, mode: "insensitive" } },
        ];
      }

      const [users, total] = await Promise.all([
        global.prisma.user.findMany({
          where,
          skip: parseInt(skip),
          take: parseInt(limit),
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
            regNumber: true,
            isActive: true,
            createdAt: true,
          },
        }),
        global.prisma.user.count({ where }),
      ]);

      res.json({
        success: true,
        data: users,
        meta: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create new user
   * POST /api/admin/users
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
            fields: errors.array(),
          },
        });
      }

      const { fullName, email, phone, role, regNumber, password } = req.body;

      const existingUser = await global.prisma.user.findFirst({
        where: {
          OR: [
            { email },
            { regNumber: regNumber || undefined },
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
        password,
        config.security.bcryptRounds,
      );
      const user = await global.prisma.user.create({
        data: {
          fullName,
          email,
          phone,
          role,
          regNumber,
          password: hashedPassword,
          isActive: true,
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          isActive: true,
          createdAt: true,
        },
      });

      // Create default notification preferences
      await global.prisma.notificationPreference.create({
        data: { userId: user.id },
      });

      logger.info(`User created by ${req.user.email}: ${email} (${role})`);

      res.status(201).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Bulk import users from CSV
   * POST /api/admin/users/bulk-import
   */
  async bulkImportUsers(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "CSV file required" },
        });
      }

      const { role } = req.body;
      const results = [];
      const errors = [];

      const csvString = req.file.buffer.toString("utf-8");
      const lines = csvString.split("\n").slice(1); // Skip header

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const [fullName, email, phone, regNumber, password] = line
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""));

        try {
          const existingUser = await global.prisma.user.findFirst({
            where: { OR: [{ email }, { regNumber }] },
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
            config.security.bcryptRounds,
          );
          const user = await global.prisma.user.create({
            data: {
              fullName,
              email,
              phone,
              role,
              regNumber,
              password: hashedPassword,
              isActive: true,
            },
          });

          await global.prisma.notificationPreference.create({
            data: { userId: user.id },
          });

          results.push(user);
        } catch (error) {
          errors.push({ row: i + 2, message: error.message });
        }
      }

      logger.info(
        `Bulk import completed by ${req.user.email}: ${results.length} imported, ${errors.length} failed`,
      );

      res.json({
        success: true,
        data: {
          imported: results.length,
          skipped: errors.length,
          errors,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user by ID
   * GET /api/admin/users/:userId
   */
  async getUser(req, res, next) {
    try {
      const { userId } = req.params;

      const user = await global.prisma.user.findUnique({
        where: { id: userId },
        include: {
          notificationPref: true,
          devices: true,
        },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      const { password, ...userWithoutPassword } = user;

      res.json({ success: true, data: userWithoutPassword });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update user
   * PATCH /api/admin/users/:userId
   */
  async updateUser(req, res, next) {
    try {
      const { userId } = req.params;
      const { fullName, phone, isActive } = req.body;

      const user = await global.prisma.user.update({
        where: { id: userId },
        data: {
          ...(fullName && { fullName }),
          ...(phone && { phone }),
          ...(isActive !== undefined && { isActive }),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          isActive: true,
          createdAt: true,
        },
      });

      logger.info(`User updated by ${req.user.email}: ${user.email}`);

      res.json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Deactivate user
   * DELETE /api/admin/users/:userId
   */
  async deactivateUser(req, res, next) {
    try {
      const { userId } = req.params;

      const user = await global.prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
      });

      // Invalidate all refresh tokens
      await global.redis.del(`refresh:${userId}`);

      logger.info(`User deactivated by ${req.user.email}: ${user.email}`);

      res.json({
        success: true,
        data: {
          message: "User deactivated. All historical records preserved.",
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List all courses
   * GET /api/admin/courses
   */
  async listCourses(req, res, next) {
    try {
      const { page = 1, limit = 20, search, lecturerId } = req.query;
      const skip = (page - 1) * limit;

      const where = {};
      if (search) {
        where.OR = [
          { code: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
        ];
      }
      if (lecturerId) where.lecturerId = lecturerId;

      const [courses, total] = await Promise.all([
        global.prisma.course.findMany({
          where,
          skip: parseInt(skip),
          take: parseInt(limit),
          include: {
            lecturer: {
              select: { id: true, fullName: true, email: true },
            },
          },
          orderBy: { createdAt: "desc" },
        }),
        global.prisma.course.count({ where }),
      ]);

      // Add enrollment count
      const coursesWithCount = await Promise.all(
        courses.map(async (course) => {
          const enrollmentCount = await global.prisma.enrollment.count({
            where: { courseId: course.id },
          });
          return { ...course, enrollmentCount };
        }),
      );

      res.json({
        success: true,
        data: coursesWithCount,
        meta: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create course
   * POST /api/admin/courses
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
            fields: errors.array(),
          },
        });
      }

      const { code, name, description, credits, semester, lecturerId } =
        req.body;

      const existingCourse = await global.prisma.course.findUnique({
        where: { code },
      });

      if (existingCourse) {
        return res.status(409).json({
          success: false,
          error: { code: "CONFLICT", message: "Course code already exists" },
        });
      }

      const course = await global.prisma.course.create({
        data: {
          code,
          name,
          description,
          credits: credits || 3,
          semester: semester || new Date().getFullYear().toString(),
          lecturerId,
        },
        include: {
          lecturer: {
            select: { id: true, fullName: true, email: true },
          },
        },
      });

      logger.info(`Course created by ${req.user.email}: ${code} - ${name}`);

      res.status(201).json({ success: true, data: course });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update course
   * PATCH /api/admin/courses/:courseId
   */
  async updateCourse(req, res, next) {
    try {
      const { courseId } = req.params;
      const { name, lecturerId, credits, isActive } = req.body;

      const course = await global.prisma.course.update({
        where: { id: courseId },
        data: {
          ...(name && { name }),
          ...(lecturerId && { lecturerId }),
          ...(credits && { credits }),
          ...(isActive !== undefined && { isActive }),
        },
        include: {
          lecturer: {
            select: { id: true, fullName: true, email: true },
          },
        },
      });

      logger.info(`Course updated by ${req.user.email}: ${course.code}`);

      res.json({ success: true, data: course });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Deactivate course
   * DELETE /api/admin/courses/:courseId
   */
  async deactivateCourse(req, res, next) {
    try {
      const { courseId } = req.params;

      const course = await global.prisma.course.update({
        where: { id: courseId },
        data: { isActive: false },
      });

      logger.info(`Course deactivated by ${req.user.email}: ${course.code}`);

      res.json({ success: true, data: { message: "Course deactivated" } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Enroll students in course
   * POST /api/admin/courses/:courseId/enroll
   */
  async enrollStudents(req, res, next) {
    try {
      const { courseId } = req.params;
      const { studentIds } = req.body;

      const course = await global.prisma.course.findUnique({
        where: { id: courseId },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      let enrolled = 0;
      let alreadyEnrolled = 0;

      for (const studentId of studentIds) {
        try {
          await global.prisma.enrollment.create({
            data: { studentId, courseId },
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

      logger.info(
        `Students enrolled by ${req.user.email}: ${enrolled} in course ${course.code}`,
      );

      res.json({
        success: true,
        data: {
          enrolled,
          alreadyEnrolled,
          message: `${enrolled} students enrolled successfully`,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Remove student from course
   * DELETE /api/admin/courses/:courseId/enroll/:studentId
   */
  async removeStudent(req, res, next) {
    try {
      const { courseId, studentId } = req.params;

      await global.prisma.enrollment.delete({
        where: {
          studentId_courseId: {
            studentId,
            courseId,
          },
        },
      });

      logger.info(
        `Student removed from course by ${req.user.email}: ${studentId} from ${courseId}`,
      );

      res.json({
        success: true,
        data: { message: "Student removed from course" },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List classrooms
   * GET /api/admin/classrooms
   */
  async listClassrooms(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const skip = (page - 1) * limit;

      const [classrooms, total] = await Promise.all([
        global.prisma.classroom.findMany({
          skip: parseInt(skip),
          take: parseInt(limit),
          orderBy: { createdAt: "desc" },
        }),
        global.prisma.classroom.count(),
      ]);

      res.json({
        success: true,
        data: classrooms,
        meta: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create classroom
   * POST /api/admin/classrooms
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
            fields: errors.array(),
          },
        });
      }

      const { name, building, capacity, latitude, longitude, radiusM } =
        req.body;

      const classroom = await global.prisma.classroom.create({
        data: {
          name,
          building,
          capacity,
          latitude,
          longitude,
          radiusM,
        },
      });

      logger.info(`Classroom created by ${req.user.email}: ${name}`);

      res.status(201).json({ success: true, data: classroom });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update classroom
   * PATCH /api/admin/classrooms/:classroomId
   */
  async updateClassroom(req, res, next) {
    try {
      const { classroomId } = req.params;
      const { name, building, capacity, latitude, longitude, radiusM } =
        req.body;

      const classroom = await global.prisma.classroom.update({
        where: { id: classroomId },
        data: {
          ...(name && { name }),
          ...(building && { building }),
          ...(capacity && { capacity }),
          ...(latitude && { latitude }),
          ...(longitude && { longitude }),
          ...(radiusM && { radiusM }),
        },
      });

      logger.info(`Classroom updated by ${req.user.email}: ${classroom.name}`);

      res.json({ success: true, data: classroom });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get system configuration
   * GET /api/admin/system/config
   */
  async getSystemConfig(req, res, next) {
    try {
      let config = await global.prisma.systemConfig.findUnique({
        where: { id: "singleton" },
      });

      if (!config) {
        config = await global.prisma.systemConfig.create({
          data: { id: "singleton" },
        });
      }

      res.json({ success: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update system configuration
   * PUT /api/admin/system/config
   */
  async updateSystemConfig(req, res, next) {
    try {
      const config = await global.prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: req.body,
        create: { id: "singleton", ...req.body },
      });

      logger.info(`System config updated by ${req.user.email}`);

      res.json({ success: true, data: config });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get system stats
   * GET /api/admin/system/stats
   */
  async getSystemStats(req, res, next) {
    try {
      const [activeSessions, redisConnected, dbPoolStatus, lastEmailLog] =
        await Promise.all([
          global.prisma.session.count({
            where: { status: "active", checkinOpen: true },
          }),
          global.redis
            .ping()
            .then(() => true)
            .catch(() => false),
          global.prisma
            .$queryRaw`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()`,
          global.prisma.attendanceRecord.findFirst({
            orderBy: { markedAt: "desc" },
            select: { markedAt: true },
          }),
        ]);

      res.json({
        success: true,
        data: {
          activeSessions,
          redisConnected,
          dbPoolSize: dbPoolStatus?.[0]?.count || 0,
          lastAttendanceRecord: lastEmailLog?.markedAt || null,
          uptime: process.uptime(),
          timestamp: new Date(),
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AdminController();
