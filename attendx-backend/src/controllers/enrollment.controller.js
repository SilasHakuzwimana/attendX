const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const { sendEmail } = require("../services/email.service");
const { sendPushNotification } = require("../services/notification.service");

class EnrollmentController {
  /**
   * Get all enrollments with filtering
   * GET /api/v1/enrollments
   */
  async getEnrollments(req, res, next) {
    try {
      const {
        page = 1,
        limit = 50,
        courseId,
        studentId,
        isActive = true,
        semester,
        academicYear,
        sortBy = "enrolledAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      // Build where clause based on role
      const where = { isActive: isActive === "true" };

      if (courseId) where.courseId = courseId;
      if (studentId) where.studentId = studentId;

      // Role-based filtering
      if (req.user.role === "student") {
        where.studentId = req.user.id;
      } else if (req.user.role === "lecturer") {
        const courses = await prisma.course.findMany({
          where: { lecturerId: req.user.id },
          select: { id: true },
        });
        const courseIds = courses.map((c) => c.id);
        if (courseIds.length > 0) {
          where.courseId = { in: courseIds };
        } else {
          return res.json({
            success: true,
            data: [],
            pagination: { page: 1, limit, total: 0, totalPages: 0 },
          });
        }
      }

      // Add semester/academic year filtering
      if (semester || academicYear) {
        where.course = {};
        if (semester) where.course.semester = parseInt(semester);
        if (academicYear) where.course.academicYear = academicYear;
      }

      const [enrollments, total] = await Promise.all([
        prisma.enrollment.findMany({
          where,
          include: {
            student: {
              select: {
                id: true,
                fullName: true,
                email: true,
                regNumber: true,
                phone: true,
                isActive: true,
              },
            },
            course: {
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
                    email: true,
                  },
                },
              },
            },
          },
          orderBy: { [sortBy]: sortOrder },
          skip,
          take,
        }),
        prisma.enrollment.count({ where }),
      ]);

      // Add attendance statistics for each enrollment
      const enrollmentsWithStats = await Promise.all(
        enrollments.map(async (enrollment) => {
          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId: enrollment.courseId },
            },
            select: { status: true },
          });

          const totalSessions = attendanceRecords.length;
          const presentCount = attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          const lateCount = attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          const attendanceRate =
            totalSessions > 0
              ? ((presentCount + lateCount) / totalSessions) * 100
              : 100;

          return {
            ...enrollment,
            statistics: {
              totalSessions,
              presentCount,
              lateCount,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
            },
          };
        }),
      );

      res.json({
        success: true,
        data: enrollmentsWithStats,
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
      logger.error("Get enrollments error:", error);
      next(error);
    }
  }

  /**
   * Get single enrollment by ID
   * GET /api/v1/enrollments/:enrollmentId
   */
  async getEnrollmentById(req, res, next) {
    try {
      const { enrollmentId } = req.params;

      const enrollment = await prisma.enrollment.findUnique({
        where: { id: enrollmentId },
        include: {
          student: {
            select: {
              id: true,
              fullName: true,
              email: true,
              regNumber: true,
              phone: true,
              isActive: true,
            },
          },
          course: {
            select: {
              id: true,
              code: true,
              name: true,
              credits: true,
              description: true,
              semester: true,
              academicYear: true,
              lecturer: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  staffNumber: true,
                },
              },
            },
          },
        },
      });

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Enrollment not found" },
        });
      }

      // Check access permission
      if (req.user.role === "student" && enrollment.studentId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You don't have access to this enrollment",
          },
        });
      }

      if (
        req.user.role === "lecturer" &&
        enrollment.course.lecturer.id !== req.user.id
      ) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You don't have access to this enrollment",
          },
        });
      }

      // Get detailed attendance statistics
      const attendanceRecords = await prisma.attendanceRecord.findMany({
        where: {
          studentId: enrollment.studentId,
          session: { courseId: enrollment.courseId },
        },
        include: {
          session: {
            include: {
              classroom: true,
            },
          },
        },
        orderBy: { markedAt: "desc" },
      });

      const totalSessions = attendanceRecords.length;
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

      // Calculate streaks
      let currentStreak = 0;
      let longestStreak = 0;
      let streak = 0;

      const sortedRecords = [...attendanceRecords].sort(
        (a, b) => a.markedAt - b.markedAt,
      );
      for (const record of sortedRecords) {
        if (record.status === "present" || record.status === "late") {
          streak++;
          longestStreak = Math.max(longestStreak, streak);
          currentStreak = streak;
        } else {
          streak = 0;
        }
      }

      // Get upcoming sessions
      const upcomingSessions = await prisma.session.findMany({
        where: {
          courseId: enrollment.courseId,
          status: "active",
          startedAt: { gt: new Date() },
        },
        include: {
          classroom: true,
        },
        orderBy: { startedAt: "asc" },
        take: 5,
      });

      res.json({
        success: true,
        data: {
          ...enrollment,
          statistics: {
            totalSessions,
            present: presentCount,
            late: lateCount,
            absent: absentCount,
            excused: excusedCount,
            attendanceRate:
              totalSessions > 0
                ? parseFloat(
                    (
                      ((presentCount + lateCount) / totalSessions) *
                      100
                    ).toFixed(1),
                  )
                : 100,
            currentStreak,
            longestStreak,
          },
          attendanceHistory: attendanceRecords.map((record) => ({
            id: record.id,
            status: record.status,
            date: record.markedAt,
            sessionCode: record.session.sessionCode,
            classroom: record.session.classroom?.name,
            distanceM: record.distanceM,
            submissionMethod: record.submissionMethod,
          })),
          upcomingSessions: upcomingSessions.map((session) => ({
            id: session.id,
            sessionCode: session.sessionCode,
            startTime: session.startedAt,
            endTime: session.expiresAt,
            classroom: session.classroom?.name,
            duration: Math.floor(
              (new Date(session.expiresAt) - new Date(session.startedAt)) /
                60000,
            ),
          })),
        },
      });
    } catch (error) {
      logger.error("Get enrollment by ID error:", error);
      next(error);
    }
  }

  /**
   * Enroll student in course (Admin/Lecturer)
   * POST /api/v1/enrollments
   */
  async createEnrollment(req, res, next) {
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

      const { studentId, courseId } = req.body;

      // Verify course exists
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
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

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Check permission (admin or course lecturer)
      if (req.user.role !== "admin" && course.lecturerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message:
              "You don't have permission to enroll students in this course",
          },
        });
      }

      // Verify student exists and is a student
      const student = await prisma.user.findFirst({
        where: {
          id: studentId,
          role: "student",
          isActive: true,
        },
      });

      if (!student) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Student not found or inactive",
          },
        });
      }

      // Check if already enrolled
      const existingEnrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true,
        },
      });

      if (existingEnrollment) {
        return res.status(409).json({
          success: false,
          error: {
            code: "ALREADY_ENROLLED",
            message: "Student is already enrolled in this course",
          },
        });
      }

      // Check if previously enrolled (inactive) - reactivate
      const inactiveEnrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: false,
        },
      });

      let enrollment;
      if (inactiveEnrollment) {
        enrollment = await prisma.enrollment.update({
          where: { id: inactiveEnrollment.id },
          data: {
            isActive: true,
            droppedAt: null,
          },
          include: {
            student: true,
            course: true,
          },
        });
      } else {
        enrollment = await prisma.enrollment.create({
          data: {
            studentId,
            courseId,
            isActive: true,
          },
          include: {
            student: true,
            course: true,
          },
        });
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CREATE_ENROLLMENT",
          entity: "Enrollment",
          entityId: enrollment.id,
          newValues: { studentId, courseId },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Send notification to student
      await this.sendEnrollmentNotification(student, course, "enrolled");

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `student:courses:${studentId}`,
          `student:dashboard:${studentId}`,
          `course:${courseId}`,
          `lecturer:dashboard:${course.lecturerId}`,
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
      }

      logger.info(
        `Student ${student.email} enrolled in course ${course.code} by ${req.user.email}`,
      );

      res.status(201).json({
        success: true,
        data: {
          id: enrollment.id,
          student: {
            id: student.id,
            fullName: student.fullName,
            email: student.email,
            regNumber: student.regNumber,
          },
          course: {
            id: course.id,
            code: course.code,
            name: course.name,
            credits: course.credits,
          },
          enrolledAt: enrollment.enrolledAt,
        },
        message: "Student enrolled successfully",
      });
    } catch (error) {
      logger.error("Create enrollment error:", error);
      next(error);
    }
  }

  /**
   * Bulk enroll students in course
   * POST /api/v1/enrollments/bulk
   */
  async bulkEnroll(req, res, next) {
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

      const { courseId, studentIds } = req.body;

      if (
        !studentIds ||
        !Array.isArray(studentIds) ||
        studentIds.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "studentIds array is required",
          },
        });
      }

      // Verify course exists
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          isActive: true,
        },
        include: {
          lecturer: true,
        },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Check permission
      if (req.user.role !== "admin" && course.lecturerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message:
              "You don't have permission to enroll students in this course",
          },
        });
      }

      // Verify students exist
      const students = await prisma.user.findMany({
        where: {
          id: { in: studentIds },
          role: "student",
          isActive: true,
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          regNumber: true,
        },
      });

      const foundStudentIds = new Set(students.map((s) => s.id));
      const notFoundIds = studentIds.filter((id) => !foundStudentIds.has(id));

      if (notFoundIds.length > 0) {
        return res.status(404).json({
          success: false,
          error: {
            code: "STUDENTS_NOT_FOUND",
            message: `Students not found: ${notFoundIds.join(", ")}`,
          },
        });
      }

      let enrolled = 0;
      let alreadyEnrolled = 0;
      let reactivated = 0;
      const enrolledStudents = [];

      for (const student of students) {
        try {
          // Check if already active enrolled
          const existingEnrollment = await prisma.enrollment.findFirst({
            where: {
              studentId: student.id,
              courseId,
              isActive: true,
            },
          });

          if (existingEnrollment) {
            alreadyEnrolled++;
            continue;
          }

          // Check if inactive enrollment exists
          const inactiveEnrollment = await prisma.enrollment.findFirst({
            where: {
              studentId: student.id,
              courseId,
              isActive: false,
            },
          });

          if (inactiveEnrollment) {
            await prisma.enrollment.update({
              where: { id: inactiveEnrollment.id },
              data: {
                isActive: true,
                droppedAt: null,
              },
            });
            reactivated++;
          } else {
            await prisma.enrollment.create({
              data: {
                studentId: student.id,
                courseId,
                isActive: true,
              },
            });
          }

          enrolled++;
          enrolledStudents.push(student);

          // Send notification
          await this.sendEnrollmentNotification(student, course, "enrolled");
        } catch (error) {
          logger.error(
            `Bulk enrollment error for student ${student.id}:`,
            error,
          );
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "BULK_ENROLLMENT",
          entity: "Course",
          entityId: courseId,
          newValues: {
            enrolledCount: enrolled,
            studentIds: enrolledStudents.map((s) => s.id),
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `course:${courseId}`,
          `lecturer:dashboard:${course.lecturerId}`,
        ];
        for (const student of enrolledStudents) {
          cacheKeys.push(`student:courses:${student.id}`);
          cacheKeys.push(`student:dashboard:${student.id}`);
        }
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
      }

      logger.info(
        `Bulk enrollment: ${enrolled} students enrolled in course ${course.code} by ${req.user.email}`,
      );

      res.json({
        success: true,
        data: {
          course: {
            id: course.id,
            code: course.code,
            name: course.name,
          },
          statistics: {
            requested: studentIds.length,
            enrolled,
            alreadyEnrolled,
            reactivated,
          },
          enrolledStudents: enrolledStudents.map((s) => ({
            id: s.id,
            fullName: s.fullName,
            email: s.email,
            regNumber: s.regNumber,
          })),
        },
        message: `${enrolled} students enrolled successfully`,
      });
    } catch (error) {
      logger.error("Bulk enroll error:", error);
      next(error);
    }
  }

  /**
   * Update enrollment (Admin/Lecturer)
   * PUT /api/v1/enrollments/:enrollmentId
   */
  async updateEnrollment(req, res, next) {
    try {
      const { enrollmentId } = req.params;
      const { isActive, notes } = req.body;

      const enrollment = await prisma.enrollment.findUnique({
        where: { id: enrollmentId },
        include: {
          student: true,
          course: {
            include: {
              lecturer: true,
            },
          },
        },
      });

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Enrollment not found" },
        });
      }

      // Check permission
      if (
        req.user.role !== "admin" &&
        enrollment.course.lecturerId !== req.user.id
      ) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You don't have permission to update this enrollment",
          },
        });
      }

      const updatedEnrollment = await prisma.enrollment.update({
        where: { id: enrollmentId },
        data: {
          ...(isActive !== undefined && { isActive }),
          ...(isActive === false && { droppedAt: new Date() }),
          ...(isActive === true && { droppedAt: null }),
        },
        include: {
          student: {
            select: {
              id: true,
              fullName: true,
              email: true,
              regNumber: true,
            },
          },
          course: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      });

      // Send notification if status changed
      if (isActive === false) {
        await this.sendEnrollmentNotification(
          enrollment.student,
          enrollment.course,
          "dropped",
        );
      } else if (isActive === true && !enrollment.isActive) {
        await this.sendEnrollmentNotification(
          enrollment.student,
          enrollment.course,
          "reactivated",
        );
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_ENROLLMENT",
          entity: "Enrollment",
          entityId: enrollmentId,
          oldValues: { isActive: enrollment.isActive },
          newValues: { isActive },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `enrollment:${enrollmentId}`,
          `student:courses:${enrollment.studentId}`,
          `student:dashboard:${enrollment.studentId}`,
          `course:${enrollment.courseId}`,
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
      }

      logger.info(
        `Enrollment ${enrollmentId} updated by ${req.user.email}: isActive=${isActive}`,
      );

      res.json({
        success: true,
        data: updatedEnrollment,
        message:
          isActive === false
            ? "Student dropped from course successfully"
            : "Enrollment updated successfully",
      });
    } catch (error) {
      logger.error("Update enrollment error:", error);
      next(error);
    }
  }

  /**
   * Delete/Drop enrollment (Admin/Lecturer or Student self-drop)
   * DELETE /api/v1/enrollments/:enrollmentId
   */
  async deleteEnrollment(req, res, next) {
    try {
      const { enrollmentId } = req.params;

      const enrollment = await prisma.enrollment.findUnique({
        where: { id: enrollmentId },
        include: {
          student: true,
          course: {
            include: {
              lecturer: true,
            },
          },
        },
      });

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Enrollment not found" },
        });
      }

      // Check permission (admin, lecturer, or student self-drop)
      const isSelfDrop =
        req.user.role === "student" && enrollment.studentId === req.user.id;
      const isAuthorized =
        req.user.role === "admin" ||
        enrollment.course.lecturerId === req.user.id ||
        isSelfDrop;

      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You don't have permission to delete this enrollment",
          },
        });
      }

      // Soft delete - deactivate enrollment
      const deletedEnrollment = await prisma.enrollment.update({
        where: { id: enrollmentId },
        data: {
          isActive: false,
          droppedAt: new Date(),
        },
        include: {
          student: {
            select: {
              id: true,
              fullName: true,
              email: true,
              regNumber: true,
            },
          },
          course: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      });

      // Send notification
      await this.sendEnrollmentNotification(
        enrollment.student,
        enrollment.course,
        "dropped",
      );

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "DELETE_ENROLLMENT",
          entity: "Enrollment",
          entityId: enrollmentId,
          newValues: { isActive: false, droppedAt: new Date() },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `enrollment:${enrollmentId}`,
          `student:courses:${enrollment.studentId}`,
          `student:dashboard:${enrollment.studentId}`,
          `course:${enrollment.courseId}`,
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
      }

      logger.info(`Enrollment ${enrollmentId} deleted by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          enrollment: deletedEnrollment,
          message: isSelfDrop
            ? "You have successfully dropped the course"
            : "Student dropped from course successfully",
        },
      });
    } catch (error) {
      logger.error("Delete enrollment error:", error);
      next(error);
    }
  }

  /**
   * Get enrollment statistics for a course
   * GET /api/v1/enrollments/statistics/course/:courseId
   */
  async getCourseEnrollmentStats(req, res, next) {
    try {
      const { courseId } = req.params;

      // Verify access
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        select: {
          id: true,
          code: true,
          name: true,
          lecturerId: true,
        },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Course not found or access denied",
          },
        });
      }

      const [activeEnrollments, droppedEnrollments, totalEnrollmentsOverTime] =
        await Promise.all([
          prisma.enrollment.count({
            where: { courseId, isActive: true },
          }),
          prisma.enrollment.count({
            where: { courseId, isActive: false },
          }),
          prisma.enrollment.groupBy({
            by: ["enrolledAt"],
            where: { courseId },
            _count: true,
            orderBy: { enrolledAt: "asc" },
          }),
        ]);

      // Get enrollment trend by month
      const enrollmentTrend = await prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', enrolled_at) as month,
          COUNT(*) as count
        FROM enrollments
        WHERE course_id = ${courseId}
        GROUP BY DATE_TRUNC('month', enrolled_at)
        ORDER BY month DESC
        LIMIT 12
      `;

      // Get student demographics
      const studentDemographics = await prisma.enrollment.groupBy({
        by: ["studentId"],
        where: { courseId, isActive: true },
        _count: true,
      });

      const uniqueStudents = studentDemographics.length;

      res.json({
        success: true,
        data: {
          course: {
            id: course.id,
            code: course.code,
            name: course.name,
          },
          statistics: {
            activeEnrollments,
            droppedEnrollments,
            totalEnrollments: activeEnrollments + droppedEnrollments,
            retentionRate:
              (activeEnrollments / (activeEnrollments + droppedEnrollments)) *
                100 || 0,
            uniqueStudents,
          },
          enrollmentTrend,
          enrollmentHistory: totalEnrollmentsOverTime.slice(0, 20),
        },
      });
    } catch (error) {
      logger.error("Get course enrollment stats error:", error);
      next(error);
    }
  }

  /**
   * Get student's enrollment summary
   * GET /api/v1/enrollments/student/:studentId/summary
   */
  async getStudentEnrollmentSummary(req, res, next) {
    try {
      const { studentId } = req.params;

      // Check permission
      if (req.user.role === "student" && req.user.id !== studentId) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only view your own enrollments",
          },
        });
      }

      const student = await prisma.user.findFirst({
        where: {
          id: studentId,
          role: "student",
          isActive: true,
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          regNumber: true,
        },
      });

      if (!student) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Student not found" },
        });
      }

      const enrollments = await prisma.enrollment.findMany({
        where: {
          studentId,
          isActive: true,
        },
        include: {
          course: {
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
          },
        },
      });

      // Calculate total credits and attendance
      let totalCredits = 0;
      const coursesWithAttendance = await Promise.all(
        enrollments.map(async (enrollment) => {
          totalCredits += enrollment.course.credits;

          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId,
              session: { courseId: enrollment.courseId },
            },
            select: { status: true },
          });

          const totalSessions = attendanceRecords.length;
          const presentCount = attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          const lateCount = attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          const attendanceRate =
            totalSessions > 0
              ? ((presentCount + lateCount) / totalSessions) * 100
              : 100;

          return {
            ...enrollment.course,
            enrolledAt: enrollment.enrolledAt,
            statistics: {
              totalSessions,
              presentCount,
              lateCount,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
            },
          };
        }),
      );

      res.json({
        success: true,
        data: {
          student,
          summary: {
            totalCourses: enrollments.length,
            totalCredits,
            averageAttendance:
              coursesWithAttendance.length > 0
                ? parseFloat(
                    (
                      coursesWithAttendance.reduce(
                        (sum, c) => sum + c.statistics.attendanceRate,
                        0,
                      ) / coursesWithAttendance.length
                    ).toFixed(1),
                  )
                : 0,
          },
          courses: coursesWithAttendance,
        },
      });
    } catch (error) {
      logger.error("Get student enrollment summary error:", error);
      next(error);
    }
  }

  /**
   * Check if student is enrolled in course
   * GET /api/v1/enrollments/check
   */
  async checkEnrollment(req, res, next) {
    try {
      const { studentId, courseId } = req.query;

      if (!studentId || !courseId) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "studentId and courseId are required",
          },
        });
      }

      // Check permission
      if (req.user.role === "student" && req.user.id !== studentId) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only check your own enrollment",
          },
        });
      }

      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true,
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
      });

      res.json({
        success: true,
        data: {
          isEnrolled: !!enrollment,
          enrollment: enrollment
            ? {
                id: enrollment.id,
                enrolledAt: enrollment.enrolledAt,
                course: enrollment.course,
              }
            : null,
        },
      });
    } catch (error) {
      logger.error("Check enrollment error:", error);
      next(error);
    }
  }

  /**
   * Send enrollment notification to student
   */
  async sendEnrollmentNotification(student, course, action) {
    try {
      const messages = {
        enrolled: {
          subject: "✅ Course Enrollment Confirmation - AttendX",
          title: "Enrollment Confirmed",
          body: `You have been successfully enrolled in ${course.name} (${course.code})`,
          color: "#4CAF50",
        },
        dropped: {
          subject: "⚠️ Course Drop Confirmation - AttendX",
          title: "Course Drop Confirmed",
          body: `You have been dropped from ${course.name} (${course.code})`,
          color: "#FF9800",
        },
        reactivated: {
          subject: "🔄 Course Re-enrollment - AttendX",
          title: "Re-enrollment Confirmed",
          body: `You have been re-enrolled in ${course.name} (${course.code})`,
          color: "#2196F3",
        },
      };

      const msg = messages[action];

      if (!msg) return;

      // Send email
      await sendEmail(
        student.email,
        msg.subject,
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: ${msg.color}; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">AttendX</h1>
          </div>
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333;">${msg.title}</h2>
            <p>Dear ${student.fullName},</p>
            <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p><strong>Course Details:</strong></p>
              <ul>
                <li>Course: ${course.name} (${course.code})</li>
                <li>Action: ${action.toUpperCase()}</li>
                <li>Date: ${new Date().toLocaleString()}</li>
              </ul>
            </div>
            <p>If you have questions, please contact your course lecturer.</p>
            <hr style="margin: 20px 0;" />
            <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
          </div>
        </div>
        `,
      );

      // Send push notification
      const devices = await prisma.device.findMany({
        where: {
          userId: student.id,
          isActive: true,
          fcmToken: { not: null },
        },
      });

      for (const device of devices) {
        await sendPushNotification(device.fcmToken, {
          title: msg.title,
          body: msg.body,
          data: {
            type: "enrollment_update",
            action,
            courseId: course.id,
            courseCode: course.code,
            timestamp: new Date().toISOString(),
          },
        });
      }
    } catch (error) {
      logger.error("Send enrollment notification error:", error);
    }
  }
}

module.exports = new EnrollmentController();
