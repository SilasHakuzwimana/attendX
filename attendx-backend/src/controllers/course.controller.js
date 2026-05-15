const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");

class CourseController {
  /**
   * Get all courses (filtered by role)
   * GET /api/v1/courses
   */
  async getCourses(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        search,
        semester,
        academicYear,
        isActive = true,
        sortBy = "createdAt",
        sortOrder = "desc"
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      // Build where clause based on user role
      const where = { isActive: isActive === "true" };

      if (search) {
        where.OR = [
          { code: { contains: search, mode: "insensitive" } },
          { name: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } }
        ];
      }

      if (semester) where.semester = parseInt(semester);
      if (academicYear) where.academicYear = academicYear;

      // Role-based filtering
      if (req.user.role === "lecturer") {
        where.lecturerId = req.user.id;
      }

      const [courses, total] = await Promise.all([
        prisma.course.findMany({
          where,
          include: {
            lecturer: {
              select: {
                id: true,
                fullName: true,
                email: true,
                staffNumber: true
              }
            },
            _count: {
              select: {
                enrollments: {
                  where: { isActive: true }
                },
                sessions: true
              }
            }
          },
          orderBy: { [sortBy]: sortOrder },
          skip,
          take
        }),
        prisma.course.count({ where })
      ]);

      // Add additional statistics
      const coursesWithStats = await Promise.all(
        courses.map(async (course) => {
          const recentSessions = await prisma.session.findMany({
            where: { courseId: course.id },
            orderBy: { startedAt: "desc" },
            take: 3,
            include: {
              _count: {
                select: { roomCheckins: true }
              }
            }
          });

          const totalCheckins = await prisma.roomCheckin.count({
            where: { session: { courseId: course.id } }
          });

          const totalEnrolled = course._count.enrollments;
          const totalSessions = course._count.sessions;
          const expectedAttendances = totalEnrolled * totalSessions;
          const attendanceRate = expectedAttendances > 0
            ? (totalCheckins / expectedAttendances) * 100
            : 0;

          return {
            ...course,
            statistics: {
              totalEnrolled,
              totalSessions,
              totalCheckins,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
              recentSessions: recentSessions.map(s => ({
                id: s.id,
                sessionCode: s.sessionCode,
                startedAt: s.startedAt,
                checkins: s._count.roomCheckins
              }))
            },
            _count: undefined
          };
        })
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
          hasPrevPage: page > 1
        }
      });
    } catch (error) {
      logger.error("Get courses error:", error);
      next(error);
    }
  }

  /**
   * Get single course by ID with full details
   * GET /api/v1/courses/:courseId
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
              phone: true
            }
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
                  phone: true
                }
              }
            }
          },
          sessions: {
            orderBy: { startedAt: "desc" },
            include: {
              classroom: true,
              _count: {
                select: { roomCheckins: true }
              }
            }
          }
        }
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" }
        });
      }

      // Check access permission
      if (req.user.role === "lecturer" && course.lecturerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "You don't have access to this course" }
        });
      }

      // Calculate detailed statistics
      const totalEnrolled = course.enrollments.length;
      const totalSessions = course.sessions.length;
      
      const totalCheckins = course.sessions.reduce(
        (sum, s) => sum + s._count.roomCheckins, 0
      );
      
      const expectedAttendances = totalEnrolled * totalSessions;
      const overallAttendanceRate = expectedAttendances > 0
        ? (totalCheckins / expectedAttendances) * 100
        : 0;

      // Per-student statistics
      const studentsWithStats = await Promise.all(
        course.enrollments.map(async (enrollment) => {
          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId }
            },
            select: { status: true, markedAt: true }
          });

          const totalRecords = attendanceRecords.length;
          const presentCount = attendanceRecords.filter(r => r.status === "present").length;
          const lateCount = attendanceRecords.filter(r => r.status === "late").length;
          const absentCount = attendanceRecords.filter(r => r.status === "absent").length;
          const excusedCount = attendanceRecords.filter(r => r.status === "excused").length;

          const attendanceRate = totalRecords > 0
            ? ((presentCount + lateCount) / totalRecords) * 100
            : 100;

          const lastAttendance = attendanceRecords.length > 0
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
              lastAttendance
            }
          };
        })
      );

      // Calculate attendance distribution
      const attendanceDistribution = {
        excellent: studentsWithStats.filter(s => s.statistics.attendanceRate >= 90).length,
        good: studentsWithStats.filter(s => s.statistics.attendanceRate >= 75 && s.statistics.attendanceRate < 90).length,
        atRisk: studentsWithStats.filter(s => s.statistics.attendanceRate >= 50 && s.statistics.attendanceRate < 75).length,
        critical: studentsWithStats.filter(s => s.statistics.attendanceRate < 50).length
      };

      // Session attendance breakdown
      const sessionBreakdown = course.sessions.map(session => ({
        id: session.id,
        sessionCode: session.sessionCode,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        status: session.status,
        classroom: session.classroom?.name,
        totalCheckins: session._count.roomCheckins,
        checkinRate: totalEnrolled > 0
          ? (session._count.roomCheckins / totalEnrolled) * 100
          : 0
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
            lecturer: course.lecturer
          },
          statistics: {
            totalEnrolled,
            totalSessions,
            totalCheckins,
            overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
            averagePerSession: totalSessions > 0
              ? parseFloat((totalCheckins / totalSessions).toFixed(1))
              : 0,
            attendanceDistribution
          },
          students: studentsWithStats.sort((a, b) => 
            a.statistics.attendanceRate - b.statistics.attendanceRate
          ),
          sessions: sessionBreakdown,
          recentActivity: sessionBreakdown.slice(0, 5)
        }
      });
    } catch (error) {
      logger.error("Get course by ID error:", error);
      next(error);
    }
  }

  /**
   * Create new course (Admin only)
   * POST /api/v1/courses
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
            details: errors.array()
          }
        });
      }

      const {
        code,
        name,
        description,
        credits = 3,
        semester,
        academicYear,
        lecturerId
      } = req.body;

      // Check if course code already exists
      const existingCourse = await prisma.course.findUnique({
        where: { code: code.toUpperCase() }
      });

      if (existingCourse) {
        return res.status(409).json({
          success: false,
          error: {
            code: "CONFLICT",
            message: "Course code already exists"
          }
        });
      }

      // Verify lecturer exists if provided
      if (lecturerId) {
        const lecturer = await prisma.user.findFirst({
          where: {
            id: lecturerId,
            role: "lecturer",
            isActive: true
          }
        });

        if (!lecturer) {
          return res.status(404).json({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: "Lecturer not found or inactive"
            }
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
          academicYear: academicYear || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
          lecturerId,
          isActive: true
        },
        include: {
          lecturer: {
            select: {
              id: true,
              fullName: true,
              email: true
            }
          }
        }
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
          userAgent: req.get("user-agent")
        }
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        const keys = await redisClient.keys("lecturer:dashboard:*");
        if (keys.length > 0) await redisClient.del(keys);
      }

      logger.info(`Course created by ${req.user.email}: ${code} - ${name}`);

      res.status(201).json({
        success: true,
        data: course,
        message: "Course created successfully"
      });
    } catch (error) {
      logger.error("Create course error:", error);
      next(error);
    }
  }

  /**
   * Update course (Admin only)
   * PUT /api/v1/courses/:courseId
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
        isActive
      } = req.body;

      // Check if course exists
      const existingCourse = await prisma.course.findUnique({
        where: { id: courseId }
      });

      if (!existingCourse) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" }
        });
      }

      // Check code uniqueness if changing
      if (code && code !== existingCourse.code) {
        const codeExists = await prisma.course.findUnique({
          where: { code: code.toUpperCase() }
        });
        
        if (codeExists) {
          return res.status(409).json({
            success: false,
            error: { code: "CONFLICT", message: "Course code already exists" }
          });
        }
      }

      // Verify lecturer exists if changing
      if (lecturerId && lecturerId !== existingCourse.lecturerId) {
        const lecturer = await prisma.user.findFirst({
          where: {
            id: lecturerId,
            role: "lecturer",
            isActive: true
          }
        });

        if (!lecturer) {
          return res.status(404).json({
            success: false,
            error: { code: "NOT_FOUND", message: "Lecturer not found or inactive" }
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
          ...(isActive !== undefined && { isActive })
        },
        include: {
          lecturer: {
            select: {
              id: true,
              fullName: true,
              email: true
            }
          }
        }
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
            isActive: existingCourse.isActive
          },
          newValues: { code, name, lecturerId, isActive },
          ipAddress: req.ip,
          userAgent: req.get("user-agent")
        }
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `course:${courseId}`,
          "lecturer:dashboard:*",
          `student:enrolled-courses:*`
        ];
        for (const pattern of cacheKeys) {
          const keys = await redisClient.keys(pattern);
          if (keys.length > 0) await redisClient.del(keys);
        }
      }

      logger.info(`Course updated by ${req.user.email}: ${course.code}`);

      res.json({
        success: true,
        data: course,
        message: "Course updated successfully"
      });
    } catch (error) {
      logger.error("Update course error:", error);
      next(error);
    }
  }

  /**
   * Delete/Deactivate course (Admin only)
   * DELETE /api/v1/courses/:courseId
   */
  async deleteCourse(req, res, next) {
    try {
      const { courseId } = req.params;

      const course = await prisma.course.findUnique({
        where: { id: courseId },
        include: {
          sessions: {
            where: { status: "active" }
          }
        }
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" }
        });
      }

      // Check for active sessions
      if (course.sessions.length > 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ACTIVE_SESSIONS",
            message: "Cannot delete course with active sessions. Close all sessions first."
          }
        });
      }

      // Soft delete - deactivate course
      const updatedCourse = await prisma.course.update({
        where: { id: courseId },
        data: { isActive: false }
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
          userAgent: req.get("user-agent")
        }
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `course:${courseId}`,
          "lecturer:dashboard:*",
          "admin:system:overview"
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
      }

      logger.info(`Course deactivated by ${req.user.email}: ${course.code}`);

      res.json({
        success: true,
        data: {
          id: courseId,
          code: course.code,
          name: course.name,
          isActive: false
        },
        message: "Course deactivated successfully"
      });
    } catch (error) {
      logger.error("Delete course error:", error);
      next(error);
    }
  }

  /**
   * Get course enrollments
   * GET /api/v1/courses/:courseId/enrollments
   */
  async getCourseEnrollments(req, res, next) {
    try {
      const { courseId } = req.params;
      const {
        page = 1,
        limit = 50,
        search,
        attendanceBelow,
        attendanceAbove,
        sortBy = "fullName",
        sortOrder = "asc"
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const lecturerId = req.user.id;

      // Verify access
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          ...(req.user.role !== "admin" && { lecturerId })
        },
        select: { id: true, name: true, code: true }
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found or access denied" }
        });
      }

      // Get enrollments
      const enrollments = await prisma.enrollment.findMany({
        where: {
          courseId,
          isActive: true
        },
        include: {
          student: {
            select: {
              id: true,
              fullName: true,
              email: true,
              regNumber: true,
              phone: true,
              isActive: true
            }
          }
        },
        skip,
        take: parseInt(limit),
        orderBy: { student: { [sortBy]: sortOrder } }
      });

      // Calculate attendance for each student
      let studentsWithStats = await Promise.all(
        enrollments.map(async (enrollment) => {
          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId }
            },
            select: { status: true, markedAt: true }
          });

          const totalSessions = attendanceRecords.length;
          const presentCount = attendanceRecords.filter(r => r.status === "present").length;
          const lateCount = attendanceRecords.filter(r => r.status === "late").length;
          const absentCount = attendanceRecords.filter(r => r.status === "absent").length;
          const excusedCount = attendanceRecords.filter(r => r.status === "excused").length;

          const attendanceRate = totalSessions > 0
            ? ((presentCount + lateCount) / totalSessions) * 100
            : 100;

          const lastAttendance = attendanceRecords.length > 0
            ? attendanceRecords[attendanceRecords.length - 1].markedAt
            : null;

          return {
            ...enrollment.student,
            enrolledAt: enrollment.enrolledAt,
            statistics: {
              totalSessions,
              present: presentCount,
              late: lateCount,
              absent: absentCount,
              excused: excusedCount,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
              lastAttendance
            }
          };
        })
      );

      // Apply filters
      if (search) {
        const searchLower = search.toLowerCase();
        studentsWithStats = studentsWithStats.filter(s =>
          s.fullName.toLowerCase().includes(searchLower) ||
          s.email.toLowerCase().includes(searchLower) ||
          s.regNumber?.toLowerCase().includes(searchLower)
        );
      }

      if (attendanceBelow) {
        studentsWithStats = studentsWithStats.filter(
          s => s.statistics.attendanceRate < parseFloat(attendanceBelow)
        );
      }

      if (attendanceAbove) {
        studentsWithStats = studentsWithStats.filter(
          s => s.statistics.attendanceRate > parseFloat(attendanceAbove)
        );
      }

      // Calculate summary
      const totalStudents = studentsWithStats.length;
      const averageAttendance = totalStudents > 0
        ? studentsWithStats.reduce((sum, s) => sum + s.statistics.attendanceRate, 0) / totalStudents
        : 0;
      const totalPresent = studentsWithStats.reduce((sum, s) => sum + s.statistics.present, 0);
      const totalLate = studentsWithStats.reduce((sum, s) => sum + s.statistics.late, 0);
      const totalAbsent = studentsWithStats.reduce((sum, s) => sum + s.statistics.absent, 0);

      res.json({
        success: true,
        data: {
          course,
          summary: {
            totalEnrolled: studentsWithStats.length,
            averageAttendance: parseFloat(averageAttendance.toFixed(1)),
            totalPresent,
            totalLate,
            totalAbsent,
            atRiskCount: studentsWithStats.filter(s => s.statistics.attendanceRate < 75).length
          },
          students: studentsWithStats,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: studentsWithStats.length,
            totalPages: Math.ceil(studentsWithStats.length / parseInt(limit))
          }
        }
      });
    } catch (error) {
      logger.error("Get course enrollments error:", error);
      next(error);
    }
  }

  /**
   * Enroll students in course (Admin only)
   * POST /api/v1/courses/:courseId/enrollments
   */
  async enrollStudents(req, res, next) {
    try {
      const { courseId } = req.params;
      const { studentIds } = req.body;

      if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "studentIds array is required"
          }
        });
      }

      // Verify course exists
      const course = await prisma.course.findUnique({
        where: { id: courseId, isActive: true },
        select: { id: true, code: true, name: true }
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" }
        });
      }

      // Verify students exist and are students
      const students = await prisma.user.findMany({
        where: {
          id: { in: studentIds },
          role: "student",
          isActive: true
        },
        select: { id: true, fullName: true, email: true }
      });

      const foundStudentIds = new Set(students.map(s => s.id));
      const notFoundIds = studentIds.filter(id => !foundStudentIds.has(id));

      if (notFoundIds.length > 0) {
        return res.status(404).json({
          success: false,
          error: {
            code: "STUDENTS_NOT_FOUND",
            message: `Students not found: ${notFoundIds.join(", ")}`
          }
        });
      }

      let enrolled = 0;
      let alreadyEnrolled = 0;
      const enrolledStudents = [];

      for (const student of students) {
        try {
          const enrollment = await prisma.enrollment.create({
            data: {
              studentId: student.id,
              courseId,
              isActive: true
            },
            include: {
              student: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  regNumber: true
                }
              }
            }
          });
          enrolled++;
          enrolledStudents.push(enrollment.student);
        } catch (error) {
          if (error.code === "P2002") {
            alreadyEnrolled++;
          } else {
            throw error;
          }
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "ENROLL_STUDENTS",
          entity: "Course",
          entityId: courseId,
          newValues: { enrolled: enrolledStudents.map(s => s.id), count: enrolled },
          ipAddress: req.ip,
          userAgent: req.get("user-agent")
        }
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `course:${courseId}`,
          "lecturer:dashboard:*",
          "admin:system:overview"
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
        for (const student of enrolledStudents) {
          await redisClient.del(`student:dashboard:${student.id}`);
          await redisClient.del(`student:courses:${student.id}`);
        }
      }

      logger.info(`${enrolled} students enrolled in course ${course.code} by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          course,
          enrolled: enrolledStudents,
          statistics: {
            enrolled: enrolled,
            alreadyEnrolled,
            totalProcessed: studentIds.length
          }
        },
        message: `${enrolled} students enrolled successfully`
      });
    } catch (error) {
      logger.error("Enroll students error:", error);
      next(error);
    }
  }

  /**
   * Remove student from course (Admin only)
   * DELETE /api/v1/courses/:courseId/enrollments/:studentId
   */
  async removeStudent(req, res, next) {
    try {
      const { courseId, studentId } = req.params;

      // Verify enrollment exists
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true
        },
        include: {
          student: {
            select: { id: true, fullName: true, email: true }
          },
          course: {
            select: { id: true, code: true, name: true }
          }
        }
      });

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Enrollment not found" }
        });
      }

      // Soft delete - deactivate enrollment
      await prisma.enrollment.update({
        where: { id: enrollment.id },
        data: {
          isActive: false,
          droppedAt: new Date()
        }
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "REMOVE_STUDENT",
          entity: "Enrollment",
          entityId: enrollment.id,
          newValues: { studentId, courseId, isActive: false },
          ipAddress: req.ip,
          userAgent: req.get("user-agent")
        }
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`course:${courseId}`);
        await redisClient.del(`student:dashboard:${studentId}`);
        await redisClient.del(`student:courses:${studentId}`);
      }

      logger.info(`Student ${enrollment.student.email} removed from course ${enrollment.course.code} by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          student: enrollment.student,
          course: enrollment.course,
          droppedAt: new Date()
        },
        message: "Student removed from course successfully"
      });
    } catch (error) {
      logger.error("Remove student error:", error);
      next(error);
    }
  }

  /**
   * Get course statistics (attendance trends)
   * GET /api/v1/courses/:courseId/statistics
   */
  async getCourseStatistics(req, res, next) {
    try {
      const { courseId } = req.params;
      const { period = "monthly" } = req.query;

      // Verify access
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id })
        },
        select: { id: true, code: true, name: true }
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found or access denied" }
        });
      }

      // Get all sessions with checkins
      const sessions = await prisma.session.findMany({
        where: { courseId },
        include: {
          classroom: true,
          _count: {
            select: { roomCheckins: true }
          }
        },
        orderBy: { startedAt: "asc" }
      });

      // Get total enrolled students
      const totalEnrolled = await prisma.enrollment.count({
        where: { courseId, isActive: true }
      });

      // Prepare trend data
      let trends = [];
      if (period === "daily") {
        const dailyData = new Map();
        sessions.forEach(session => {
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
        sessions.forEach(session => {
          const weekNumber = this.getWeekNumber(session.startedAt);
          const year = session.startedAt.getFullYear();
          const weekKey = `${year}-W${weekNumber}`;
          if (!weeklyData.has(weekKey)) {
            weeklyData.set(weekKey, { week: weekKey, checkins: 0, sessions: 0 });
          }
          const week = weeklyData.get(weekKey);
          week.sessions++;
          week.checkins += session._count.roomCheckins;
        });
        trends = Array.from(weeklyData.values());
      } else {
        // Monthly
        const monthlyData = new Map();
        sessions.forEach(session => {
          const monthKey = session.startedAt.toISOString().substring(0, 7);
          if (!monthlyData.has(monthKey)) {
            monthlyData.set(monthKey, { month: monthKey, checkins: 0, sessions: 0 });
          }
          const month = monthlyData.get(monthKey);
          month.sessions++;
          month.checkins += session._count.roomCheckins;
        });
        trends = Array.from(monthlyData.values());
      }

      // Calculate overall statistics
      const totalSessions = sessions.length;
      const totalCheckins = sessions.reduce((sum, s) => sum + s._count.roomCheckins, 0);
      const expectedAttendances = totalEnrolled * totalSessions;
      const overallAttendanceRate = expectedAttendances > 0
        ? (totalCheckins / expectedAttendances) * 100
        : 0;

      // Session success rate (sessions with >50% attendance)
      const successfulSessions = sessions.filter(
        s => (s._count.roomCheckins / totalEnrolled) * 100 > 50
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
            averagePerSession: totalSessions > 0
              ? parseFloat((totalCheckins / totalSessions).toFixed(1))
              : 0,
            sessionSuccessRate: totalSessions > 0
              ? parseFloat((successfulSessions / totalSessions * 100).toFixed(1))
              : 0
          },
          trends,
          sessions: sessions.map(s => ({
            id: s.id,
            sessionCode: s.sessionCode,
            date: s.startedAt,
            checkins: s._count.roomCheckins,
            checkinRate: totalEnrolled > 0
              ? parseFloat((s._count.roomCheckins / totalEnrolled * 100).toFixed(1))
              : 0,
            classroom: s.classroom?.name,
            status: s.status
          }))
        }
      });
    } catch (error) {
      logger.error("Get course statistics error:", error);
      next(error);
    }
  }

  /**
   * Get courses for dropdown/select inputs
   * GET /api/v1/courses/list
   */
  async getCourseList(req, res, next) {
    try {
      const where = { isActive: true };
      
      if (req.user.role === "lecturer") {
        where.lecturerId = req.user.id;
      }

      const courses = await prisma.course.findMany({
        where,
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
              fullName: true
            }
          }
        },
        orderBy: { code: "asc" }
      });

      res.json({
        success: true,
        data: courses
      });
    } catch (error) {
      logger.error("Get course list error:", error);
      next(error);
    }
  }

  /**
   * Helper function to get week number
   */
  getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }
}

module.exports = new CourseController();