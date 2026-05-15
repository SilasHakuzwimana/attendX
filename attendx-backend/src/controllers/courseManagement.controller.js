const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");

class CourseManagementController {
  /**
   * Get all courses with advanced filtering (Admin view)
   * GET /api/v1/admin/courses
   */
  async getAllCourses(req, res, next) {
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
      if (semester) where.semester = parseInt(semester);
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
                phone: true,
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

          // Get recent sessions
          const recentSessions = await prisma.session.findMany({
            where: { courseId: course.id },
            orderBy: { startedAt: "desc" },
            take: 3,
            include: {
              _count: { select: { roomCheckins: true } },
            },
          });

          return {
            ...course,
            statistics: {
              totalEnrolled,
              totalSessions,
              totalCheckins,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
              averagePerSession:
                totalSessions > 0
                  ? parseFloat((totalCheckins / totalSessions).toFixed(1))
                  : 0,
            },
            recentSessions: recentSessions.map((s) => ({
              id: s.id,
              sessionCode: s.sessionCode,
              startedAt: s.startedAt,
              checkins: s._count.roomCheckins,
            })),
            _count: undefined,
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
      logger.error("Get all courses error:", error);
      next(error);
    }
  }

  /**
   * Get course by ID with full details (Admin view)
   * GET /api/v1/admin/courses/:courseId
   */
  async getCourseById(req, res, next) {
    try {
      const { courseId } = req.params;

      const course = await prisma.course.findUnique({
        where: { id: courseId },
        include: {
          lecturer: {
            select: {
              id: true,
              fullName: true,
              email: true,
              staffNumber: true,
              phone: true,
            },
          },
          enrollments: {
            where: { isActive: true },
            include: {
              student: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  regNumber: true,
                  phone: true,
                },
              },
            },
          },
          sessions: {
            orderBy: { startedAt: "desc" },
            include: {
              classroom: true,
              _count: { select: { roomCheckins: true } },
            },
          },
        },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Calculate detailed statistics
      const totalEnrolled = course.enrollments.length;
      const totalSessions = course.sessions.length;
      const totalCheckins = course.sessions.reduce(
        (sum, s) => sum + s._count.roomCheckins,
        0,
      );
      const expectedAttendances = totalEnrolled * totalSessions;
      const overallAttendanceRate =
        expectedAttendances > 0
          ? (totalCheckins / expectedAttendances) * 100
          : 0;

      // Per-student statistics
      const studentsWithStats = await Promise.all(
        course.enrollments.map(async (enrollment) => {
          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId },
            },
            select: { status: true, markedAt: true },
          });

          const totalRecords = attendanceRecords.length;
          const presentCount = attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          const lateCount = attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          const absentCount = attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length;
          const excusedCount = attendanceRecords.filter(
            (r) => r.status === "excused",
          ).length;

          const attendanceRate =
            totalRecords > 0
              ? ((presentCount + lateCount) / totalRecords) * 100
              : 100;

          const lastAttendance =
            attendanceRecords.length > 0
              ? attendanceRecords[attendanceRecords.length - 1].markedAt
              : null;

          return {
            ...enrollment.student,
            enrolledAt: enrollment.enrolledAt,
            statistics: {
              totalSessions: totalRecords,
              present: presentCount,
              late: lateCount,
              absent: absentCount,
              excused: excusedCount,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
              lastAttendance,
            },
          };
        }),
      );

      // Attendance distribution
      const attendanceDistribution = {
        excellent: studentsWithStats.filter(
          (s) => s.statistics.attendanceRate >= 90,
        ).length,
        good: studentsWithStats.filter(
          (s) =>
            s.statistics.attendanceRate >= 75 &&
            s.statistics.attendanceRate < 90,
        ).length,
        atRisk: studentsWithStats.filter(
          (s) =>
            s.statistics.attendanceRate >= 50 &&
            s.statistics.attendanceRate < 75,
        ).length,
        critical: studentsWithStats.filter(
          (s) => s.statistics.attendanceRate < 50,
        ).length,
      };

      // Session breakdown
      const sessionBreakdown = course.sessions.map((session) => ({
        id: session.id,
        sessionCode: session.sessionCode,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        status: session.status,
        classroom: session.classroom?.name,
        totalCheckins: session._count.roomCheckins,
        checkinRate:
          totalEnrolled > 0
            ? (session._count.roomCheckins / totalEnrolled) * 100
            : 0,
      }));

      res.json({
        success: true,
        data: {
          course: {
            id: course.id,
            code: course.code,
            name: course.name,
            description: course.description,
            credits: course.credits,
            semester: course.semester,
            academicYear: course.academicYear,
            isActive: course.isActive,
            createdAt: course.createdAt,
            updatedAt: course.updatedAt,
            lecturer: course.lecturer,
          },
          statistics: {
            totalEnrolled,
            totalSessions,
            totalCheckins,
            overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
            averagePerSession:
              totalSessions > 0
                ? parseFloat((totalCheckins / totalSessions).toFixed(1))
                : 0,
            attendanceDistribution,
          },
          students: studentsWithStats.sort(
            (a, b) => a.statistics.attendanceRate - b.statistics.attendanceRate,
          ),
          sessions: sessionBreakdown,
          recentActivity: sessionBreakdown.slice(0, 5),
        },
      });
    } catch (error) {
      logger.error("Get course by ID error:", error);
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

      // Verify lecturer exists if provided
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

      // Create audit log
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

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del("admin:courses:list");
      }

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
   * PUT /api/v1/admin/courses/:courseId
   */
  async updateCourse(req, res, next) {
    try {
      const { courseId } = req.params;
      const {
        code,
        name,
        description,
        credits,
        semester,
        academicYear,
        lecturerId,
        isActive,
      } = req.body;

      // Check if course exists
      const existingCourse = await prisma.course.findUnique({
        where: { id: courseId },
      });

      if (!existingCourse) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Check code uniqueness if changing
      if (code && code !== existingCourse.code) {
        const codeExists = await prisma.course.findUnique({
          where: { code: code.toUpperCase() },
        });

        if (codeExists) {
          return res.status(409).json({
            success: false,
            error: { code: "CONFLICT", message: "Course code already exists" },
          });
        }
      }

      // Verify lecturer exists if changing
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
          ...(code && { code: code.toUpperCase() }),
          ...(name && { name }),
          ...(description !== undefined && { description }),
          ...(credits && { credits }),
          ...(semester && { semester }),
          ...(academicYear && { academicYear }),
          ...(lecturerId && { lecturerId }),
          ...(isActive !== undefined && { isActive }),
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

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_COURSE",
          entity: "Course",
          entityId: courseId,
          oldValues: {
            code: existingCourse.code,
            name: existingCourse.name,
            lecturerId: existingCourse.lecturerId,
            isActive: existingCourse.isActive,
          },
          newValues: { code, name, lecturerId, isActive },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`course:${courseId}`);
        await redisClient.del("admin:courses:list");
      }

      logger.info(`Course updated by ${req.user.email}: ${course.code}`);

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
   * Delete/Deactivate course
   * DELETE /api/v1/admin/courses/:courseId
   */
  async deleteCourse(req, res, next) {
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

      // Check for active sessions
      if (course.sessions.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ACTIVE_SESSIONS",
            message:
              "Cannot delete course with active sessions. Close all sessions first.",
          },
        });
      }

      // Soft delete - deactivate course
      const updatedCourse = await prisma.course.update({
        where: { id: courseId },
        data: { isActive: false },
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "DELETE_COURSE",
          entity: "Course",
          entityId: courseId,
          oldValues: { isActive: true },
          newValues: { isActive: false },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`course:${courseId}`);
        await redisClient.del("admin:courses:list");
      }

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
      logger.error("Delete course error:", error);
      next(error);
    }
  }

  /**
   * Reactivate course
   * POST /api/v1/admin/courses/:courseId/activate
   */
  async reactivateCourse(req, res, next) {
    try {
      const { courseId } = req.params;

      const course = await prisma.course.findUnique({
        where: { id: courseId },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      if (course.isActive) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ALREADY_ACTIVE",
            message: "Course is already active",
          },
        });
      }

      const updatedCourse = await prisma.course.update({
        where: { id: courseId },
        data: { isActive: true },
      });

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "REACTIVATE_COURSE",
          entity: "Course",
          entityId: courseId,
          newValues: { isActive: true },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      if (redisClient && redisClient.isReady) {
        await redisClient.del(`course:${courseId}`);
        await redisClient.del("admin:courses:list");
      }

      logger.info(`Course reactivated by ${req.user.email}: ${course.code}`);

      res.json({
        success: true,
        data: updatedCourse,
        message: "Course reactivated successfully",
      });
    } catch (error) {
      logger.error("Reactivate course error:", error);
      next(error);
    }
  }

  /**
   * Get course statistics
   * GET /api/v1/admin/courses/:courseId/statistics
   */
  async getCourseStatistics(req, res, next) {
    try {
      const { courseId } = req.params;
      const { period = "monthly" } = req.query;

      const course = await prisma.course.findUnique({
        where: { id: courseId },
        select: { id: true, code: true, name: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      const sessions = await prisma.session.findMany({
        where: { courseId, status: "closed" },
        include: {
          _count: { select: { roomCheckins: true } },
          classroom: true,
        },
        orderBy: { startedAt: "asc" },
      });

      const totalEnrolled = await prisma.enrollment.count({
        where: { courseId, isActive: true },
      });

      let trends = [];
      if (period === "daily") {
        const dailyData = new Map();
        sessions.forEach((session) => {
          const date = session.startedAt.toISOString().split("T")[0];
          if (!dailyData.has(date)) {
            dailyData.set(date, { date, checkins: 0, sessions: 0 });
          }
          const day = dailyData.get(date);
          day.sessions++;
          day.checkins += session._count.roomCheckins;
        });
        trends = Array.from(dailyData.values());
      } else if (period === "weekly") {
        const weeklyData = new Map();
        sessions.forEach((session) => {
          const weekNumber = this.getWeekNumber(session.startedAt);
          const year = session.startedAt.getFullYear();
          const weekKey = `${year}-W${weekNumber}`;
          if (!weeklyData.has(weekKey)) {
            weeklyData.set(weekKey, {
              week: weekKey,
              checkins: 0,
              sessions: 0,
            });
          }
          const week = weeklyData.get(weekKey);
          week.sessions++;
          week.checkins += session._count.roomCheckins;
        });
        trends = Array.from(weeklyData.values());
      } else {
        const monthlyData = new Map();
        sessions.forEach((session) => {
          const monthKey = session.startedAt.toISOString().substring(0, 7);
          if (!monthlyData.has(monthKey)) {
            monthlyData.set(monthKey, {
              month: monthKey,
              checkins: 0,
              sessions: 0,
            });
          }
          const month = monthlyData.get(monthKey);
          month.sessions++;
          month.checkins += session._count.roomCheckins;
        });
        trends = Array.from(monthlyData.values());
      }

      const totalSessions = sessions.length;
      const totalCheckins = sessions.reduce(
        (sum, s) => sum + s._count.roomCheckins,
        0,
      );
      const expectedAttendances = totalEnrolled * totalSessions;
      const overallAttendanceRate =
        expectedAttendances > 0
          ? (totalCheckins / expectedAttendances) * 100
          : 0;

      const successfulSessions = sessions.filter(
        (s) => (s._count.roomCheckins / totalEnrolled) * 100 > 50,
      ).length;

      res.json({
        success: true,
        data: {
          course,
          summary: {
            totalEnrolled,
            totalSessions,
            totalCheckins,
            overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
            averagePerSession:
              totalSessions > 0
                ? parseFloat((totalCheckins / totalSessions).toFixed(1))
                : 0,
            sessionSuccessRate:
              totalSessions > 0
                ? parseFloat(
                    ((successfulSessions / totalSessions) * 100).toFixed(1),
                  )
                : 0,
          },
          trends,
          sessions: sessions.map((s) => ({
            id: s.id,
            sessionCode: s.sessionCode,
            date: s.startedAt,
            checkins: s._count.roomCheckins,
            checkinRate:
              totalEnrolled > 0
                ? parseFloat(
                    ((s._count.roomCheckins / totalEnrolled) * 100).toFixed(1),
                  )
                : 0,
            classroom: s.classroom?.name,
            status: s.status,
          })),
        },
      });
    } catch (error) {
      logger.error("Get course statistics error:", error);
      next(error);
    }
  }

  /**
   * Get courses for dropdown/select inputs
   * GET /api/v1/admin/courses/list
   */
  async getCourseList(req, res, next) {
    try {
      const { isActive = true } = req.query;

      const courses = await prisma.course.findMany({
        where: { isActive: isActive === "true" },
        select: {
          id: true,
          code: true,
          name: true,
          credits: true,
          semester: true,
          academicYear: true,
          lecturer: {
            select: {
              id: true,
              fullName: true,
            },
          },
        },
        orderBy: { code: "asc" },
      });

      res.json({
        success: true,
        data: courses,
      });
    } catch (error) {
      logger.error("Get course list error:", error);
      next(error);
    }
  }

  /**
   * Bulk create courses
   * POST /api/v1/admin/courses/bulk
   */
  async bulkCreateCourses(req, res, next) {
    try {
      const { courses } = req.body;

      if (!courses || !Array.isArray(courses) || courses.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Courses array is required",
          },
        });
      }

      const results = {
        successful: [],
        failed: [],
      };

      for (const courseData of courses) {
        try {
          // Check if course code already exists
          const existingCourse = await prisma.course.findUnique({
            where: { code: courseData.code.toUpperCase() },
          });

          if (existingCourse) {
            results.failed.push({
              code: courseData.code,
              error: "Course code already exists",
            });
            continue;
          }

          // Verify lecturer exists if provided
          if (courseData.lecturerId) {
            const lecturer = await prisma.user.findFirst({
              where: {
                id: courseData.lecturerId,
                role: "lecturer",
                isActive: true,
              },
            });

            if (!lecturer) {
              results.failed.push({
                code: courseData.code,
                error: "Lecturer not found or inactive",
              });
              continue;
            }
          }

          const course = await prisma.course.create({
            data: {
              code: courseData.code.toUpperCase(),
              name: courseData.name,
              description: courseData.description || null,
              credits: courseData.credits || 3,
              semester:
                courseData.semester || new Date().getFullYear().toString(),
              academicYear:
                courseData.academicYear ||
                `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
              lecturerId: courseData.lecturerId || null,
              isActive: true,
            },
          });

          results.successful.push(course);
        } catch (error) {
          results.failed.push({
            code: courseData.code,
            error: error.message,
          });
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_CREATE_COURSES",
          entity: "Course",
          newValues: {
            total: courses.length,
            successful: results.successful.length,
            failed: results.failed.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Bulk course creation: ${results.successful.length} created, ${results.failed.length} failed by ${req.user.email}`,
      );

      res.json({
        success: true,
        data: {
          total: courses.length,
          successful: results.successful.length,
          failed: results.failed.length,
          details: {
            successful: results.successful.slice(0, 20),
            failed: results.failed.slice(0, 20),
          },
        },
        message: `${results.successful.length} courses created successfully`,
      });
    } catch (error) {
      logger.error("Bulk create courses error:", error);
      next(error);
    }
  }

  /**
   * Helper function to get week number
   */
  getWeekNumber(date) {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }
}

module.exports = new CourseManagementController();
