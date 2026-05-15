const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const { sendEmail } = require("../services/email.service");
const { sendPushNotification } = require("../services/notification.service");

class LecturerController {
  /**
   * Get lecturer dashboard with overview statistics
   * GET /api/v1/lecturer/dashboard
   */
  async getDashboard(req, res, next) {
    try {
      const lecturerId = req.user.id;
      const cacheKey = `lecturer:dashboard:${lecturerId}`;

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

      // Get lecturer's courses
      const courses = await prisma.course.findMany({
        where: {
          lecturerId,
          isActive: true,
        },
        include: {
          enrollments: {
            where: { isActive: true },
            include: {
              student: {
                select: {
                  id: true,
                  fullName: true,
                  regNumber: true,
                  email: true,
                },
              },
            },
          },
          sessions: {
            orderBy: { startedAt: "desc" },
            take: 10,
          },
        },
      });

      // Get active sessions
      const activeSessions = await prisma.session.findMany({
        where: {
          lecturerId,
          status: "active",
          checkinOpen: true,
        },
        include: {
          course: true,
          classroom: true,
          _count: {
            select: { roomCheckins: true },
          },
        },
        orderBy: { expiresAt: "asc" },
      });

      // Get today's schedule
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todaySessions = await prisma.session.findMany({
        where: {
          lecturerId,
          startedAt: { gte: today, lt: tomorrow },
        },
        include: {
          course: true,
          classroom: true,
          _count: {
            select: { roomCheckins: true },
          },
        },
      });

      // Calculate statistics
      let totalStudents = 0;
      let totalSessions = 0;
      let totalCheckins = 0;
      let coursesWithLowAttendance = [];

      for (const course of courses) {
        const studentCount = course.enrollments.length;
        totalStudents += studentCount;

        const courseSessions = await prisma.session.findMany({
          where: { courseId: course.id },
          include: {
            _count: {
              select: { roomCheckins: true },
            },
          },
        });

        const courseTotalSessions = courseSessions.length;
        totalSessions += courseTotalSessions;

        const courseTotalCheckins = courseSessions.reduce(
          (sum, s) => sum + s._count.roomCheckins,
          0,
        );
        totalCheckins += courseTotalCheckins;

        // Calculate course attendance rate
        const expectedAttendances = studentCount * courseTotalSessions;
        const courseAttendanceRate =
          expectedAttendances > 0
            ? (courseTotalCheckins / expectedAttendances) * 100
            : 0;

        if (courseAttendanceRate < 75 && courseTotalSessions > 0) {
          coursesWithLowAttendance.push({
            courseId: course.id,
            courseCode: course.code,
            courseName: course.name,
            attendanceRate: parseFloat(courseAttendanceRate.toFixed(1)),
            studentCount,
            totalSessions: courseTotalSessions,
          });
        }
      }

      // Get recent activity
      const recentSessions = await prisma.session.findMany({
        where: { lecturerId },
        include: {
          course: true,
          classroom: true,
          _count: {
            select: { roomCheckins: true },
          },
        },
        orderBy: { startedAt: "desc" },
        take: 5,
      });

      // Get at-risk students across all courses
      const atRiskStudents =
        await this.getAtRiskStudentsAcrossCourses(lecturerId);

      const dashboardData = {
        profile: {
          id: req.user.id,
          fullName: req.user.fullName,
          email: req.user.email,
          staffNumber: req.user.staffNumber,
        },
        statistics: {
          totalCourses: courses.length,
          totalStudents,
          totalSessions,
          totalCheckins,
          averageAttendanceRate:
            totalStudents > 0 && totalSessions > 0
              ? parseFloat(
                  (
                    (totalCheckins / (totalStudents * totalSessions)) *
                    100
                  ).toFixed(1),
                )
              : 0,
          activeSessionsCount: activeSessions.length,
        },
        activeSessions: activeSessions.map((session) => ({
          id: session.id,
          sessionCode: session.sessionCode,
          courseName: session.course.name,
          courseCode: session.course.code,
          roomName: session.classroom.name,
          expiresAt: session.expiresAt,
          timeRemaining: Math.max(
            0,
            Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
          ),
          currentCheckins: session._count.roomCheckins,
          totalEnrolled: session.course.enrollments?.length || 0,
        })),
        todaySessions: todaySessions.map((session) => ({
          id: session.id,
          sessionCode: session.sessionCode,
          courseName: session.course.name,
          courseCode: session.course.code,
          startTime: session.startedAt,
          roomName: session.classroom.name,
          status: session.status,
          checkins: session._count.roomCheckins,
        })),
        recentSessions: recentSessions.map((session) => ({
          id: session.id,
          sessionCode: session.sessionCode,
          courseName: session.course.name,
          date: session.startedAt,
          checkins: session._count.roomCheckins,
          status: session.status,
        })),
        coursesWithLowAttendance,
        atRiskStudents: atRiskStudents.slice(0, 10),
        lastUpdated: new Date(),
      };

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 120, JSON.stringify(dashboardData));
      }

      res.json({ success: true, data: dashboardData });
    } catch (error) {
      logger.error("Get lecturer dashboard error:", error);
      next(error);
    }
  }

  /**
   * Get all courses taught by lecturer
   * GET /api/v1/lecturer/courses
   */
  async getCourses(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        semester,
        academicYear,
        includeStats = true,
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const lecturerId = req.user.id;

      const where = {
        lecturerId,
        isActive: true,
      };

      if (semester) where.semester = parseInt(semester);
      if (academicYear) where.academicYear = academicYear;

      const [courses, total] = await Promise.all([
        prisma.course.findMany({
          where,
          include: {
            enrollments: {
              where: { isActive: true },
              select: { id: true, studentId: true },
            },
            sessions: {
              orderBy: { startedAt: "desc" },
              take: 5,
              select: {
                id: true,
                sessionCode: true,
                status: true,
                startedAt: true,
                _count: {
                  select: { roomCheckins: true },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.course.count({ where }),
      ]);

      // Add statistics to each course
      const coursesWithStats = await Promise.all(
        courses.map(async (course) => {
          if (!includeStats || includeStats === "false") {
            return course;
          }

          const totalSessions = await prisma.session.count({
            where: { courseId: course.id },
          });

          const totalCheckins = await prisma.roomCheckin.count({
            where: {
              session: { courseId: course.id },
            },
          });

          const totalEnrolled = course.enrollments.length;
          const expectedAttendances = totalEnrolled * totalSessions;
          const attendanceRate =
            expectedAttendances > 0
              ? (totalCheckins / expectedAttendances) * 100
              : 0;

          // Get recent attendance trend
          const lastMonthStart = new Date();
          lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);

          const recentCheckins = await prisma.roomCheckin.count({
            where: {
              session: { courseId: course.id },
              checkedInAt: { gte: lastMonthStart },
            },
          });

          return {
            ...course,
            statistics: {
              totalEnrolled,
              totalSessions,
              totalCheckins,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
              recentCheckins,
              averagePerSession:
                totalSessions > 0
                  ? parseFloat((totalCheckins / totalSessions).toFixed(1))
                  : 0,
            },
            enrollments: undefined, // Remove enrollments from response
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
        },
      });
    } catch (error) {
      logger.error("Get lecturer courses error:", error);
      next(error);
    }
  }

  /**
   * Get course details with students and attendance
   * GET /api/v1/lecturer/courses/:courseId
   */
  async getCourseDetails(req, res, next) {
    try {
      const { courseId } = req.params;
      const lecturerId = req.user.id;

      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          lecturerId,
          isActive: true,
        },
        include: {
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
              _count: {
                select: { roomCheckins: true },
              },
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

      // Calculate attendance statistics for each student
      const studentsWithStats = await Promise.all(
        course.enrollments.map(async (enrollment) => {
          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId },
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
          const absentCount = attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length;
          const excusedCount = attendanceRecords.filter(
            (r) => r.status === "excused",
          ).length;

          const attendanceRate =
            totalSessions > 0
              ? ((presentCount + lateCount) / totalSessions) * 100
              : 100;

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
            },
          };
        }),
      );

      // Calculate overall course statistics
      const totalStudents = studentsWithStats.length;
      const totalSessions = course.sessions.length;
      const totalCheckins = course.sessions.reduce(
        (sum, s) => sum + s._count.roomCheckins,
        0,
      );
      const expectedAttendances = totalStudents * totalSessions;
      const overallAttendanceRate =
        expectedAttendances > 0
          ? (totalCheckins / expectedAttendances) * 100
          : 0;

      // Find at-risk students (below 75% attendance)
      const atRiskStudents = studentsWithStats
        .filter((s) => s.statistics.attendanceRate < 75)
        .sort(
          (a, b) => a.statistics.attendanceRate - b.statistics.attendanceRate,
        );

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
            createdAt: course.createdAt,
          },
          statistics: {
            totalStudents,
            totalSessions,
            totalCheckins,
            overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
            averagePerSession:
              totalSessions > 0
                ? parseFloat((totalCheckins / totalSessions).toFixed(1))
                : 0,
            atRiskCount: atRiskStudents.length,
          },
          students: studentsWithStats.sort(
            (a, b) => a.statistics.attendanceRate - b.statistics.attendanceRate,
          ),
          atRiskStudents,
          sessions: course.sessions.map((session) => ({
            id: session.id,
            sessionCode: session.sessionCode,
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            status: session.status,
            checkins: session._count.roomCheckins,
            classroom: session.classroom.name,
          })),
        },
      });
    } catch (error) {
      logger.error("Get course details error:", error);
      next(error);
    }
  }

  /**
   * Get students enrolled in a course
   * GET /api/v1/lecturer/courses/:courseId/students
   */
  async getCourseStudents(req, res, next) {
    try {
      const { courseId } = req.params;
      const {
        page = 1,
        limit = 50,
        search,
        sortBy = "fullName",
        sortOrder = "asc",
        attendanceBelow,
        attendanceAbove,
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const lecturerId = req.user.id;

      // Verify course belongs to lecturer
      const course = await prisma.course.findFirst({
        where: { id: courseId, lecturerId },
        select: { id: true, name: true, code: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Get enrollments with student details
      let enrollmentsWhere = {
        courseId,
        isActive: true,
      };

      const enrollments = await prisma.enrollment.findMany({
        where: enrollmentsWhere,
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
        },
        skip,
        take: parseInt(limit),
        orderBy: { student: { [sortBy]: sortOrder } },
      });

      // Calculate attendance for each student
      let studentsWithAttendance = await Promise.all(
        enrollments.map(async (enrollment) => {
          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId },
            },
            select: { status: true, markedAt: true },
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

          const attendanceRate =
            totalSessions > 0
              ? ((presentCount + lateCount) / totalSessions) * 100
              : 100;

          // Get last attendance date
          const lastAttendance =
            attendanceRecords.length > 0
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
              lastAttendance,
            },
          };
        }),
      );

      // Apply filters
      if (search) {
        const searchLower = search.toLowerCase();
        studentsWithAttendance = studentsWithAttendance.filter(
          (s) =>
            s.fullName.toLowerCase().includes(searchLower) ||
            s.email.toLowerCase().includes(searchLower) ||
            s.regNumber?.toLowerCase().includes(searchLower),
        );
      }

      if (attendanceBelow) {
        studentsWithAttendance = studentsWithAttendance.filter(
          (s) => s.statistics.attendanceRate < parseFloat(attendanceBelow),
        );
      }

      if (attendanceAbove) {
        studentsWithAttendance = studentsWithAttendance.filter(
          (s) => s.statistics.attendanceRate > parseFloat(attendanceAbove),
        );
      }

      // Calculate summary statistics
      const totalStudents = studentsWithAttendance.length;
      const averageAttendance =
        totalStudents > 0
          ? studentsWithAttendance.reduce(
              (sum, s) => sum + s.statistics.attendanceRate,
              0,
            ) / totalStudents
          : 0;
      const atRiskCount = studentsWithAttendance.filter(
        (s) => s.statistics.attendanceRate < 75,
      ).length;

      res.json({
        success: true,
        data: {
          course,
          summary: {
            totalStudents,
            averageAttendance: parseFloat(averageAttendance.toFixed(1)),
            atRiskCount,
            lowAttendanceThreshold: 75,
          },
          students: studentsWithAttendance,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: studentsWithAttendance.length,
            totalPages: Math.ceil(
              studentsWithAttendance.length / parseInt(limit),
            ),
          },
        },
      });
    } catch (error) {
      logger.error("Get course students error:", error);
      next(error);
    }
  }

  /**
   * Get student's detailed attendance for a course
   * GET /api/v1/lecturer/courses/:courseId/students/:studentId
   */
  async getStudentCourseAttendance(req, res, next) {
    try {
      const { courseId, studentId } = req.params;
      const lecturerId = req.user.id;

      // Verify course belongs to lecturer
      const course = await prisma.course.findFirst({
        where: { id: courseId, lecturerId },
        select: { id: true, name: true, code: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Verify student is enrolled
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true,
        },
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
      });

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Student not enrolled in this course",
          },
        });
      }

      // Get all sessions with attendance
      const sessions = await prisma.session.findMany({
        where: { courseId },
        include: {
          classroom: true,
          attendanceRecords: {
            where: { studentId },
            take: 1,
          },
          roomCheckins: {
            where: { studentId },
            take: 1,
          },
        },
        orderBy: { startedAt: "desc" },
      });

      const sessionAttendance = sessions.map((session) => ({
        id: session.id,
        sessionCode: session.sessionCode,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        status: session.status,
        classroom: session.classroom?.name,
        attendanceStatus: session.attendanceRecords[0]?.status || "absent",
        checkinTime: session.roomCheckins[0]?.checkedInAt || null,
        distanceM: session.roomCheckins[0]?.distanceM || null,
      }));

      // Calculate statistics
      const totalSessions = sessions.length;
      const presentCount = sessionAttendance.filter(
        (s) => s.attendanceStatus === "present",
      ).length;
      const lateCount = sessionAttendance.filter(
        (s) => s.attendanceStatus === "late",
      ).length;
      const absentCount = sessionAttendance.filter(
        (s) => s.attendanceStatus === "absent",
      ).length;
      const excusedCount = sessionAttendance.filter(
        (s) => s.attendanceStatus === "excused",
      ).length;

      const attendanceRate =
        totalSessions > 0
          ? ((presentCount + lateCount) / totalSessions) * 100
          : 100;

      res.json({
        success: true,
        data: {
          student: enrollment.student,
          course,
          statistics: {
            totalSessions,
            present: presentCount,
            late: lateCount,
            absent: absentCount,
            excused: excusedCount,
            attendanceRate: parseFloat(attendanceRate.toFixed(1)),
          },
          sessionAttendance,
        },
      });
    } catch (error) {
      logger.error("Get student course attendance error:", error);
      next(error);
    }
  }

  /**
   * Mark student attendance manually
   * POST /api/v1/lecturer/courses/:courseId/students/:studentId/attendance
   */
  async markStudentAttendance(req, res, next) {
    try {
      const { courseId, studentId } = req.params;
      const { sessionId, status, reason, notes } = req.body;
      const lecturerId = req.user.id;

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

      // Verify course belongs to lecturer
      const course = await prisma.course.findFirst({
        where: { id: courseId, lecturerId },
        include: {
          sessions: {
            where: { id: sessionId },
          },
        },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      const session = course.sessions[0];
      if (!session) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Session not found for this course",
          },
        });
      }

      // Verify student is enrolled
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true,
        },
        include: {
          student: true,
        },
      });

      if (!enrollment) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Student not enrolled in this course",
          },
        });
      }

      // Check if attendance already exists
      const existingAttendance = await prisma.attendanceRecord.findFirst({
        where: {
          sessionId: session.id,
          studentId,
        },
      });

      let attendance;
      if (existingAttendance) {
        // Update existing
        attendance = await prisma.attendanceRecord.update({
          where: { id: existingAttendance.id },
          data: {
            status,
            overriddenAt: new Date(),
            overriddenBy: lecturerId,
            overrideReason: reason,
            notes: notes || existingAttendance.notes,
          },
        });
      } else {
        // Create new
        attendance = await prisma.attendanceRecord.create({
          data: {
            sessionId: session.id,
            studentId,
            status,
            submissionMethod: "manual",
            markedAt: new Date(),
            overriddenBy: lecturerId,
            overrideReason: reason,
            notes,
          },
        });

        // Also create room checkin if marked present/late
        if (status === "present" || status === "late") {
          await prisma.roomCheckin.create({
            data: {
              sessionId: session.id,
              studentId,
              latitude: 0,
              longitude: 0,
              distanceM: 0,
              deviceFingerprint: "manual",
              submissionMethod: "manual",
              checkedInAt: new Date(),
            },
          });

          // Update session check-in count
          await prisma.session.update({
            where: { id: session.id },
            data: { checkinsCount: { increment: 1 } },
          });
        }
      }

      // Send email notification to student
      await sendEmail(
        enrollment.student.email,
        "📝 Attendance Record Updated - AttendX",
        this.getManualAttendanceEmail(
          enrollment.student,
          course,
          session,
          status,
          reason,
        ),
      );

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: lecturerId,
          action: "MARK_ATTENDANCE",
          entity: "AttendanceRecord",
          entityId: attendance.id,
          newValues: { studentId, sessionId: session.id, status, reason },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `lecturer:dashboard:${lecturerId}`,
          `student:dashboard:${studentId}`,
          `student:summary:${studentId}`,
        ];
        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
      }

      logger.info(
        `Lecturer ${req.user.email} marked attendance for student ${studentId} in session ${session.id} as ${status}`,
      );

      res.json({
        success: true,
        data: {
          studentId,
          studentName: enrollment.student.fullName,
          sessionId: session.id,
          sessionCode: session.sessionCode,
          status,
          reason,
          message: `Attendance marked as ${status.toUpperCase()} for ${enrollment.student.fullName}`,
        },
      });
    } catch (error) {
      logger.error("Mark student attendance error:", error);
      next(error);
    }
  }

  /**
   * Get at-risk students across all courses
   * GET /api/v1/lecturer/at-risk-students
   */
  async getAtRiskStudents(req, res, next) {
    try {
      const { threshold = 75, courseId } = req.query;
      const lecturerId = req.user.id;

      const where = { lecturerId, isActive: true };
      if (courseId) where.id = courseId;

      const courses = await prisma.course.findMany({
        where,
        include: {
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
        },
      });

      const atRiskStudents = [];

      for (const course of courses) {
        for (const enrollment of course.enrollments) {
          const attendanceRecords = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId: course.id },
            },
            select: { status: true },
          });

          const totalSessions = attendanceRecords.length;
          const attended = attendanceRecords.filter(
            (r) => r.status === "present" || r.status === "late",
          ).length;
          const attendanceRate =
            totalSessions > 0 ? (attended / totalSessions) * 100 : 100;

          if (attendanceRate < parseFloat(threshold)) {
            // Check consecutive absences
            const recentRecords = await prisma.attendanceRecord.findMany({
              where: {
                studentId: enrollment.studentId,
                session: { courseId: course.id },
                status: "absent",
              },
              orderBy: { markedAt: "desc" },
              take: 5,
            });

            let consecutiveAbsences = 0;
            for (const record of recentRecords) {
              if (record.status === "absent") consecutiveAbsences++;
              else break;
            }

            atRiskStudents.push({
              student: enrollment.student,
              course: {
                id: course.id,
                code: course.code,
                name: course.name,
              },
              statistics: {
                totalSessions,
                attended,
                attendanceRate: parseFloat(attendanceRate.toFixed(1)),
                consecutiveAbsences,
                status: attendanceRate < 50 ? "critical" : "warning",
              },
            });
          }
        }
      }

      // Sort by attendance rate (lowest first)
      atRiskStudents.sort(
        (a, b) => a.statistics.attendanceRate - b.statistics.attendanceRate,
      );

      res.json({
        success: true,
        data: {
          threshold: parseFloat(threshold),
          totalAtRisk: atRiskStudents.length,
          students: atRiskStudents,
          summary: {
            critical: atRiskStudents.filter(
              (s) => s.statistics.status === "critical",
            ).length,
            warning: atRiskStudents.filter(
              (s) => s.statistics.status === "warning",
            ).length,
          },
        },
      });
    } catch (error) {
      logger.error("Get at-risk students error:", error);
      next(error);
    }
  }

  /**
   * Send notification to all students in a course
   * POST /api/v1/lecturer/courses/:courseId/notify
   */
  async notifyCourseStudents(req, res, next) {
    try {
      const { courseId } = req.params;
      const { title, message, type = "announcement" } = req.body;
      const lecturerId = req.user.id;

      // Verify course belongs to lecturer
      const course = await prisma.course.findFirst({
        where: { id: courseId, lecturerId },
        include: {
          enrollments: {
            where: { isActive: true },
            include: {
              student: {
                include: {
                  devices: {
                    where: { isActive: true, fcmToken: { not: null } },
                  },
                  notificationPref: true,
                },
              },
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

      let emailSent = 0;
      let pushSent = 0;

      for (const enrollment of course.enrollments) {
        const student = enrollment.student;
        const preferences = student.notificationPref;

        // Send email
        if (preferences?.emailNotifications !== false) {
          await sendEmail(
            student.email,
            `📢 ${title} - ${course.code}`,
            this.getAnnouncementEmail(student, course, title, message, type),
          );
          emailSent++;
        }

        // Send push notification
        if (preferences?.pushNotifications !== false) {
          for (const device of student.devices) {
            if (device.fcmToken) {
              await sendPushNotification(device.fcmToken, {
                title,
                body: message,
                data: {
                  type,
                  courseId,
                  courseCode: course.code,
                  timestamp: new Date().toISOString(),
                },
              });
              pushSent++;
            }
          }
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: lecturerId,
          action: "COURSE_ANNOUNCEMENT",
          entity: "Course",
          entityId: courseId,
          newValues: {
            title,
            message,
            type,
            recipients: course.enrollments.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Announcement sent to ${course.enrollments.length} students in course ${course.code}`,
      );

      res.json({
        success: true,
        data: {
          courseId,
          courseName: course.name,
          title,
          message,
          type,
          recipients: {
            total: course.enrollments.length,
            emailSent,
            pushSent,
          },
        },
      });
    } catch (error) {
      logger.error("Notify course students error:", error);
      next(error);
    }
  }

  /**
   * Helper method to get at-risk students across courses
   */
  async getAtRiskStudentsAcrossCourses(lecturerId) {
    const courses = await prisma.course.findMany({
      where: { lecturerId, isActive: true },
      include: {
        enrollments: {
          where: { isActive: true },
          include: {
            student: {
              select: {
                id: true,
                fullName: true,
                email: true,
                regNumber: true,
              },
            },
          },
        },
      },
    });

    const atRisk = [];

    for (const course of courses) {
      for (const enrollment of course.enrollments) {
        const attendanceRecords = await prisma.attendanceRecord.findMany({
          where: {
            studentId: enrollment.studentId,
            session: { courseId: course.id },
          },
        });

        const totalSessions = attendanceRecords.length;
        const attended = attendanceRecords.filter(
          (r) => r.status === "present" || r.status === "late",
        ).length;
        const attendanceRate =
          totalSessions > 0 ? (attended / totalSessions) * 100 : 100;

        if (attendanceRate < 75 && totalSessions > 0) {
          atRisk.push({
            student: enrollment.student,
            course: {
              id: course.id,
              code: course.code,
              name: course.name,
            },
            attendanceRate: parseFloat(attendanceRate.toFixed(1)),
            totalSessions,
          });
        }
      }
    }

    return atRisk.sort((a, b) => a.attendanceRate - b.attendanceRate);
  }

  /**
   * Email template for manual attendance marking
   */
  getManualAttendanceEmail(student, course, session, status, reason) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #2196F3; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333;">Attendance Record Updated</h2>
          <p>Dear ${student.fullName},</p>
          <p>Your attendance has been manually updated by your lecturer.</p>
          <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Details:</strong></p>
            <ul>
              <li>Course: ${course.name} (${course.code})</li>
              <li>Session: ${session.sessionCode}</li>
              <li>Status: <strong style="color: ${status === "present" ? "#4CAF50" : status === "late" ? "#FF9800" : "#F44346"}">${status.toUpperCase()}</strong></li>
              ${reason ? `<li>Reason: ${reason}</li>` : ""}
            </ul>
          </div>
          <p>If you have questions, please contact your lecturer.</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }

  /**
   * Email template for course announcements
   */
  getAnnouncementEmail(student, course, title, message, type) {
    const colors = {
      announcement: "#2196F3",
      reminder: "#FF9800",
      warning: "#F44336",
      info: "#4CAF50",
    };

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: ${colors[type] || colors.announcement}; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333;">${title}</h2>
          <p>Dear ${student.fullName},</p>
          <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Course:</strong> ${course.name} (${course.code})</p>
            <p><strong>Message:</strong></p>
            <p>${message}</p>
          </div>
          <p>Please check the AttendX app for more details.</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }
}

module.exports = new LecturerController();
