const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");

class AnalyticsController {
  /**
   * Get lecturer dashboard analytics
   * GET /api/v1/analytics/lecturer/dashboard
   */
  async getLecturerDashboard(req, res, next) {
    try {
      const lecturerId = req.user.id;
      const cacheKey = `analytics:lecturer:dashboard:${lecturerId}`;

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

      // Get all courses for the lecturer
      const courses = await prisma.course.findMany({
        where: { lecturerId, isActive: true },
        include: {
          enrollments: {
            where: { isActive: true },
            select: { id: true, studentId: true },
          },
          sessions: {
            where: { status: "closed" },
            include: {
              attendanceRecords: true,
              roomCheckins: true,
            },
          },
        },
      });

      let totalCourses = courses.length;
      let totalSessions = 0;
      let totalPresent = 0;
      let totalLate = 0;
      let totalAbsent = 0;
      let totalEnrolledStudents = 0;
      let totalPossibleAttendances = 0;
      const courseSummaries = [];
      let atRiskCount = 0;

      for (const course of courses) {
        let coursePresent = 0;
        let courseLate = 0;
        let courseAbsent = 0;
        let coursePossible = 0;
        const courseSessions = course.sessions.length;
        const courseEnrolled = course.enrollments.length;

        totalEnrolledStudents += courseEnrolled;
        totalSessions += courseSessions;

        for (const session of course.sessions) {
          const present = session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          const late = session.attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          const absent = session.attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length;

          coursePresent += present;
          courseLate += late;
          courseAbsent += absent;
          coursePossible += session.attendanceRecords.length;

          totalPresent += present;
          totalLate += late;
          totalAbsent += absent;
          totalPossibleAttendances += session.attendanceRecords.length;
        }

        // Calculate course attendance rate
        const courseAttendanceRate =
          coursePossible > 0
            ? ((coursePresent + courseLate) / coursePossible) * 100
            : 0;

        // Count at-risk students in this course
        const courseAtRisk = await this.getCourseAtRiskCount(course.id, 75);
        atRiskCount += courseAtRisk;

        courseSummaries.push({
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          credits: course.credits,
          totalSessions: courseSessions,
          totalEnrollments: courseEnrolled,
          attendanceRate: parseFloat(courseAttendanceRate.toFixed(1)),
          presentCount: coursePresent,
          lateCount: courseLate,
          absentCount: courseAbsent,
          atRiskCount: courseAtRisk,
        });
      }

      // Calculate overall averages
      const overallAttendanceRate =
        totalPossibleAttendances > 0
          ? ((totalPresent + totalLate) / totalPossibleAttendances) * 100
          : 0;

      // Get recent activity (last 7 days)
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const recentSessions = await prisma.session.findMany({
        where: {
          lecturerId,
          startedAt: { gte: weekAgo },
          status: "closed",
        },
        include: {
          course: { select: { code: true, name: true } },
          _count: { select: { roomCheckins: true } },
        },
        orderBy: { startedAt: "desc" },
        take: 10,
      });

      const dashboardData = {
        summary: {
          totalCourses,
          totalSessions,
          totalEnrolledStudents,
          totalPresent,
          totalLate,
          totalAbsent,
          overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
          atRiskCount,
        },
        courseSummaries,
        recentActivity: recentSessions.map((session) => ({
          id: session.id,
          sessionCode: session.sessionCode,
          courseName: session.course.name,
          date: session.startedAt,
          checkins: session._count.roomCheckins,
          status: session.status,
        })),
        lastUpdated: new Date(),
      };

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(dashboardData));
      }

      res.json({ success: true, data: dashboardData });
    } catch (error) {
      logger.error("Get lecturer dashboard error:", error);
      next(error);
    }
  }

  /**
   * Get course attendance summary with detailed analytics
   * GET /api/v1/analytics/courses/:courseId/summary
   */
  async getCourseSummary(req, res, next) {
    try {
      const { courseId } = req.params;
      const { from, to, period = "all" } = req.query;

      // Verify course access
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        include: {
          lecturer: {
            select: { id: true, fullName: true, email: true },
          },
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

      const cacheKey = `analytics:course:${courseId}:${period}:${from || ""}:${to || ""}`;

      // Check cache
      let cachedData = null;
      if (redisClient && redisClient.isReady && !from && !to) {
        cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json({
            success: true,
            data: JSON.parse(cachedData),
            meta: { cached: true },
          });
        }
      }

      // Build date filter
      const whereSession = { courseId, status: "closed" };
      if (from || to) {
        whereSession.startedAt = {};
        if (from) whereSession.startedAt.gte = new Date(from);
        if (to) whereSession.startedAt.lte = new Date(to);
      }

      // Get all sessions with attendance
      const sessions = await prisma.session.findMany({
        where: whereSession,
        include: {
          attendanceRecords: true,
          roomCheckins: {
            include: {
              student: {
                select: { id: true, fullName: true, regNumber: true },
              },
            },
          },
          classroom: true,
        },
        orderBy: { startedAt: "asc" },
      });

      // Get total enrolled students
      const totalEnrolled = await prisma.enrollment.count({
        where: { courseId, isActive: true },
      });

      // Calculate statistics
      let totalPresent = 0;
      let totalLate = 0;
      let totalAbsent = 0;
      let totalExcused = 0;
      let totalCheckins = 0;
      let totalPossibleAttendances = 0;

      const sessionBreakdown = sessions.map((session) => {
        const present = session.attendanceRecords.filter(
          (r) => r.status === "present",
        ).length;
        const late = session.attendanceRecords.filter(
          (r) => r.status === "late",
        ).length;
        const absent = session.attendanceRecords.filter(
          (r) => r.status === "absent",
        ).length;
        const excused = session.attendanceRecords.filter(
          (r) => r.status === "excused",
        ).length;
        const checkins = session.roomCheckins.length;

        totalPresent += present;
        totalLate += late;
        totalAbsent += absent;
        totalExcused += excused;
        totalCheckins += checkins;
        totalPossibleAttendances += session.attendanceRecords.length;

        return {
          sessionId: session.id,
          sessionCode: session.sessionCode,
          date: session.startedAt,
          present,
          late,
          absent,
          excused,
          checkins,
          attendanceRate:
            totalEnrolled > 0 ? (checkins / totalEnrolled) * 100 : 0,
          classroom: session.classroom?.name,
        };
      });

      const totalSessions = sessions.length;
      const overallAttendanceRate =
        totalPossibleAttendances > 0
          ? ((totalPresent + totalLate) / totalPossibleAttendances) * 100
          : 0;

      // Calculate trends
      const trends = this.calculateTrends(sessions, totalEnrolled);

      const responseData = {
        course: {
          id: course.id,
          code: course.code,
          name: course.name,
          credits: course.credits,
          semester: course.semester,
          academicYear: course.academicYear,
          lecturer: course.lecturer,
        },
        summary: {
          totalSessions,
          totalEnrolled,
          totalCheckins,
          totalPresent,
          totalLate,
          totalAbsent,
          totalExcused,
          overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
          averageCheckinsPerSession:
            totalSessions > 0
              ? parseFloat((totalCheckins / totalSessions).toFixed(1))
              : 0,
        },
        sessionBreakdown,
        trends,
        dateRange: {
          from: from || sessions[0]?.startedAt || null,
          to: to || sessions[sessions.length - 1]?.startedAt || null,
        },
      };

      // Cache for 10 minutes
      if (redisClient && redisClient.isReady && !from && !to) {
        await redisClient.setEx(cacheKey, 600, JSON.stringify(responseData));
      }

      res.json({ success: true, data: responseData });
    } catch (error) {
      logger.error("Get course summary error:", error);
      next(error);
    }
  }

  /**
   * Get per-student attendance breakdown for a course
   * GET /api/v1/analytics/courses/:courseId/students
   */
  async getStudentBreakdown(req, res, next) {
    try {
      const { courseId } = req.params;
      const {
        page = 1,
        limit = 20,
        sortBy = "attendanceRate",
        sortOrder = "desc",
        search,
        status,
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      // Verify course access
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        select: { id: true, code: true, name: true, lecturerId: true },
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

      // Get all enrollments with student details
      const enrollments = await prisma.enrollment.findMany({
        where: { courseId, isActive: true },
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

      // Get total sessions count
      const totalSessions = await prisma.session.count({
        where: { courseId, status: "closed" },
      });

      // Calculate attendance for each student
      let studentSummaries = [];

      for (const enrollment of enrollments) {
        const attendanceRecords = await prisma.attendanceRecord.findMany({
          where: {
            studentId: enrollment.studentId,
            session: { courseId },
          },
          select: { status: true, markedAt: true },
        });

        const present = attendanceRecords.filter(
          (a) => a.status === "present",
        ).length;
        const late = attendanceRecords.filter(
          (a) => a.status === "late",
        ).length;
        const absent = attendanceRecords.filter(
          (a) => a.status === "absent",
        ).length;
        const excused = attendanceRecords.filter(
          (a) => a.status === "excused",
        ).length;
        const attended = present + late;

        // Calculate consecutive absences
        let consecutiveAbsences = 0;
        const recentRecords = await prisma.attendanceRecord.findMany({
          where: {
            studentId: enrollment.studentId,
            session: { courseId },
          },
          orderBy: { markedAt: "desc" },
          take: 5,
        });

        for (const record of recentRecords) {
          if (record.status === "absent") consecutiveAbsences++;
          else break;
        }

        const attendanceRate =
          totalSessions > 0 ? (attended / totalSessions) * 100 : 100;
        const riskStatus =
          attendanceRate < 50
            ? "critical"
            : attendanceRate < 75
              ? "warning"
              : "good";

        studentSummaries.push({
          student: enrollment.student,
          enrolledAt: enrollment.enrolledAt,
          statistics: {
            totalSessions,
            present,
            late,
            absent,
            excused,
            attended,
            attendanceRate: parseFloat(attendanceRate.toFixed(1)),
            consecutiveAbsences,
            riskStatus,
            lastAttendance: recentRecords[0]?.markedAt || null,
          },
        });
      }

      // Apply filters
      if (search) {
        const searchLower = search.toLowerCase();
        studentSummaries = studentSummaries.filter(
          (s) =>
            s.student.fullName.toLowerCase().includes(searchLower) ||
            s.student.email.toLowerCase().includes(searchLower) ||
            s.student.regNumber?.toLowerCase().includes(searchLower),
        );
      }

      if (status) {
        studentSummaries = studentSummaries.filter(
          (s) => s.statistics.riskStatus === status,
        );
      }

      // Sort
      const sortField =
        sortBy === "fullName" ? "student.fullName" : `statistics.${sortBy}`;
      studentSummaries.sort((a, b) => {
        let aVal, bVal;
        if (sortBy === "fullName") {
          aVal = a.student.fullName;
          bVal = b.student.fullName;
        } else {
          aVal = a.statistics[sortBy];
          bVal = b.statistics[sortBy];
        }
        if (sortOrder === "asc") {
          return aVal > bVal ? 1 : -1;
        } else {
          return aVal < bVal ? 1 : -1;
        }
      });

      const total = studentSummaries.length;
      const paginated = studentSummaries.slice(skip, skip + take);

      // Calculate summary statistics
      const averageAttendance =
        total > 0
          ? studentSummaries.reduce(
              (sum, s) => sum + s.statistics.attendanceRate,
              0,
            ) / total
          : 0;
      const atRiskCount = studentSummaries.filter(
        (s) => s.statistics.riskStatus !== "good",
      ).length;

      res.json({
        success: true,
        data: {
          course: {
            id: course.id,
            code: course.code,
            name: course.name,
          },
          summary: {
            totalStudents: total,
            averageAttendance: parseFloat(averageAttendance.toFixed(1)),
            atRiskCount,
            criticalCount: studentSummaries.filter(
              (s) => s.statistics.riskStatus === "critical",
            ).length,
            warningCount: studentSummaries.filter(
              (s) => s.statistics.riskStatus === "warning",
            ).length,
            goodCount: studentSummaries.filter(
              (s) => s.statistics.riskStatus === "good",
            ).length,
          },
          students: paginated,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
            hasNextPage: skip + take < total,
            hasPrevPage: page > 1,
          },
        },
      });
    } catch (error) {
      logger.error("Get student breakdown error:", error);
      next(error);
    }
  }

  /**
   * Get at-risk students across courses
   * GET /api/v1/analytics/at-risk
   */
  async getAtRiskStudents(req, res, next) {
    try {
      const {
        courseId,
        threshold = 75,
        consecutiveAbsences = 2,
        limit = 50,
      } = req.query;

      // Build course filter based on role
      const courseFilter = {};
      if (courseId) {
        courseFilter.id = courseId;
      } else if (req.user.role === "lecturer") {
        courseFilter.lecturerId = req.user.id;
      }

      const courses = await prisma.course.findMany({
        where: { ...courseFilter, isActive: true },
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
          const student = enrollment.student;

          // Get attendance records
          const records = await prisma.attendanceRecord.findMany({
            where: {
              studentId: student.id,
              session: { courseId: course.id },
            },
            select: { status: true, markedAt: true },
            orderBy: { markedAt: "desc" },
          });

          const totalSessions = records.length;
          const attended = records.filter(
            (r) => r.status === "present" || r.status === "late",
          ).length;
          const attendanceRate =
            totalSessions > 0 ? (attended / totalSessions) * 100 : 100;

          // Count consecutive absences
          let consecutiveAbsenceCount = 0;
          for (const record of records) {
            if (record.status === "absent") consecutiveAbsenceCount++;
            else break;
          }

          // Check if student is at-risk
          const isLowAttendance = attendanceRate < parseFloat(threshold);
          const hasConsecutiveAbsences =
            consecutiveAbsenceCount >= parseInt(consecutiveAbsences);
          const isAtRisk = isLowAttendance || hasConsecutiveAbsences;

          if (isAtRisk && totalSessions > 0) {
            // Check if warning was sent recently
            let warningSentAt = null;
            if (redisClient && redisClient.isReady) {
              const warningKey = `warning:${student.id}:${course.id}`;
              warningSentAt = await redisClient.get(warningKey);
            }

            atRiskStudents.push({
              student: {
                id: student.id,
                fullName: student.fullName,
                email: student.email,
                regNumber: student.regNumber,
                phone: student.phone,
              },
              course: {
                id: course.id,
                code: course.code,
                name: course.name,
              },
              statistics: {
                totalSessions,
                attended,
                attendanceRate: parseFloat(attendanceRate.toFixed(1)),
                consecutiveAbsences: consecutiveAbsenceCount,
                missedSessions: totalSessions - attended,
              },
              reasons: {
                lowAttendance: isLowAttendance,
                consecutiveAbsences: hasConsecutiveAbsences,
              },
              warningSentAt: warningSentAt
                ? new Date(parseInt(warningSentAt))
                : null,
              riskLevel: attendanceRate < 50 ? "critical" : "warning",
            });
          }
        }
      }

      // Sort by risk level and attendance rate
      atRiskStudents.sort((a, b) => {
        if (a.riskLevel !== b.riskLevel) {
          return a.riskLevel === "critical" ? -1 : 1;
        }
        return a.statistics.attendanceRate - b.statistics.attendanceRate;
      });

      const limitedResults = atRiskStudents.slice(0, parseInt(limit));

      res.json({
        success: true,
        data: {
          threshold: parseFloat(threshold),
          consecutiveAbsencesThreshold: parseInt(consecutiveAbsences),
          totalAtRisk: atRiskStudents.length,
          criticalCount: atRiskStudents.filter(
            (s) => s.riskLevel === "critical",
          ).length,
          warningCount: atRiskStudents.filter((s) => s.riskLevel === "warning")
            .length,
          students: limitedResults,
        },
      });
    } catch (error) {
      logger.error("Get at-risk students error:", error);
      next(error);
    }
  }

  /**
   * Get admin system overview analytics
   * GET /api/v1/analytics/admin/overview
   */
  async getAdminOverview(req, res, next) {
    try {
      const cacheKey = "analytics:admin:overview";

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

      // Get all statistics in parallel
      const [
        totalStudents,
        activeStudents,
        totalLecturers,
        activeLecturers,
        totalAdmins,
        totalCourses,
        activeCourses,
        totalSessions,
        activeSessions,
        totalAttendanceRecords,
        presentRecords,
        lateRecords,
        absentRecords,
        totalClassrooms,
        activeClassrooms,
        totalDevices,
        thisWeekSessions,
        lastWeekSessions,
      ] = await Promise.all([
        prisma.user.count({ where: { role: "student" } }),
        prisma.user.count({ where: { role: "student", isActive: true } }),
        prisma.user.count({ where: { role: "lecturer" } }),
        prisma.user.count({ where: { role: "lecturer", isActive: true } }),
        prisma.user.count({ where: { role: "admin", isActive: true } }),
        prisma.course.count(),
        prisma.course.count({ where: { isActive: true } }),
        prisma.session.count(),
        prisma.session.count({ where: { status: "active" } }),
        prisma.attendanceRecord.count(),
        prisma.attendanceRecord.count({ where: { status: "present" } }),
        prisma.attendanceRecord.count({ where: { status: "late" } }),
        prisma.attendanceRecord.count({ where: { status: "absent" } }),
        prisma.classroom.count(),
        prisma.classroom.count({ where: { isActive: true } }),
        prisma.device.count({ where: { isActive: true } }),
        prisma.session.count({
          where: {
            startedAt: {
              gte: new Date(new Date().setDate(new Date().getDate() - 7)),
            },
          },
        }),
        prisma.session.count({
          where: {
            startedAt: {
              gte: new Date(new Date().setDate(new Date().getDate() - 14)),
              lt: new Date(new Date().setDate(new Date().getDate() - 7)),
            },
          },
        }),
      ]);

      // Calculate growth
      const sessionGrowth =
        lastWeekSessions > 0
          ? ((thisWeekSessions - lastWeekSessions) / lastWeekSessions) * 100
          : 0;

      // Get today's activity
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todaysCheckins = await prisma.roomCheckin.count({
        where: {
          checkedInAt: { gte: today, lt: tomorrow },
        },
      });

      const todaysSessions = await prisma.session.count({
        where: {
          startedAt: { gte: today, lt: tomorrow },
        },
      });

      // Get weekly active users
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const weeklyActiveUsers = await prisma.user.count({
        where: {
          lastLoginAt: { gte: weekAgo },
        },
      });

      const responseData = {
        users: {
          totalStudents,
          activeStudents,
          totalLecturers,
          activeLecturers,
          totalAdmins,
          weeklyActiveUsers,
          totalUsers: totalStudents + totalLecturers + totalAdmins,
        },
        academics: {
          totalCourses,
          activeCourses,
          totalSessions,
          activeSessions,
          totalClassrooms,
          activeClassrooms,
          sessionGrowth: parseFloat(sessionGrowth.toFixed(1)),
        },
        attendance: {
          totalRecords: totalAttendanceRecords,
          present: presentRecords,
          late: lateRecords,
          absent: absentRecords,
          attendanceRate:
            totalAttendanceRecords > 0
              ? parseFloat(
                  (
                    ((presentRecords + lateRecords) / totalAttendanceRecords) *
                    100
                  ).toFixed(1),
                )
              : 0,
          todaysCheckins,
          todaysSessions,
        },
        infrastructure: {
          totalDevices,
          totalClassrooms,
          activeClassrooms,
        },
        timestamp: new Date(),
      };

      // Cache for 10 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 600, JSON.stringify(responseData));
      }

      res.json({ success: true, data: responseData });
    } catch (error) {
      logger.error("Get admin overview error:", error);
      next(error);
    }
  }

  /**
   * Get attendance trends over time
   * GET /api/v1/analytics/trends
   */
  async getAttendanceTrends(req, res, next) {
    try {
      const { courseId, period = "monthly", months = 6 } = req.query;

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - parseInt(months));

      // Build filter
      const whereSession = {};
      if (courseId) whereSession.courseId = courseId;
      if (req.user.role === "lecturer" && !courseId) {
        const courses = await prisma.course.findMany({
          where: { lecturerId: req.user.id },
          select: { id: true },
        });
        whereSession.courseId = { in: courses.map((c) => c.id) };
      }

      whereSession.startedAt = { gte: startDate };
      whereSession.status = "closed";

      const sessions = await prisma.session.findMany({
        where: whereSession,
        include: {
          attendanceRecords: true,
          course: {
            select: { id: true, code: true, name: true },
          },
        },
        orderBy: { startedAt: "asc" },
      });

      let trends = [];

      if (period === "weekly") {
        const weeklyData = new Map();
        sessions.forEach((session) => {
          const weekNumber = this.getWeekNumber(session.startedAt);
          const year = session.startedAt.getFullYear();
          const weekKey = `${year}-W${weekNumber}`;

          if (!weeklyData.has(weekKey)) {
            weeklyData.set(weekKey, {
              period: weekKey,
              sessions: 0,
              present: 0,
              late: 0,
              absent: 0,
              total: 0,
            });
          }
          const week = weeklyData.get(weekKey);
          week.sessions++;
          week.present += session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          week.late += session.attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          week.absent += session.attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length;
          week.total += session.attendanceRecords.length;
        });
        trends = Array.from(weeklyData.values());
      } else if (period === "daily") {
        const dailyData = new Map();
        sessions.forEach((session) => {
          const dateKey = session.startedAt.toISOString().split("T")[0];
          if (!dailyData.has(dateKey)) {
            dailyData.set(dateKey, {
              period: dateKey,
              sessions: 0,
              present: 0,
              late: 0,
              absent: 0,
              total: 0,
            });
          }
          const day = dailyData.get(dateKey);
          day.sessions++;
          day.present += session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          day.late += session.attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          day.absent += session.attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length;
          day.total += session.attendanceRecords.length;
        });
        trends = Array.from(dailyData.values());
      } else {
        // Monthly (default)
        const monthlyData = new Map();
        sessions.forEach((session) => {
          const monthKey = session.startedAt.toISOString().substring(0, 7);
          if (!monthlyData.has(monthKey)) {
            monthlyData.set(monthKey, {
              period: monthKey,
              sessions: 0,
              present: 0,
              late: 0,
              absent: 0,
              total: 0,
            });
          }
          const month = monthlyData.get(monthKey);
          month.sessions++;
          month.present += session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          month.late += session.attendanceRecords.filter(
            (r) => r.status === "late",
          ).length;
          month.absent += session.attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length;
          month.total += session.attendanceRecords.length;
        });
        trends = Array.from(monthlyData.values());
      }

      // Calculate rates
      trends = trends.map((trend) => ({
        ...trend,
        attendanceRate:
          trend.total > 0
            ? parseFloat(
                (((trend.present + trend.late) / trend.total) * 100).toFixed(1),
              )
            : 0,
      }));

      res.json({
        success: true,
        data: {
          period,
          dateRange: { from: startDate, to: new Date() },
          trends,
          summary: {
            totalSessions: sessions.length,
            totalRecords: trends.reduce((sum, t) => sum + t.total, 0),
            averageAttendanceRate:
              trends.length > 0
                ? parseFloat(
                    (
                      trends.reduce((sum, t) => sum + t.attendanceRate, 0) /
                      trends.length
                    ).toFixed(1),
                  )
                : 0,
          },
        },
      });
    } catch (error) {
      logger.error("Get attendance trends error:", error);
      next(error);
    }
  }

  /**
   * Get course attendance statistics with filters
   * GET /api/v1/analytics/courses/:courseId/attendance
   */
  async getCourseAttendanceStats(req, res, next) {
    try {
      const { courseId } = req.params;
      const { sessionId } = req.query;

      // Verify access
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        select: { id: true, code: true, name: true, lecturerId: true },
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

      const sessionWhere = { courseId };
      if (sessionId) sessionWhere.id = sessionId;

      const sessions = await prisma.session.findMany({
        where: sessionWhere,
        include: {
          attendanceRecords: {
            include: {
              student: {
                select: {
                  id: true,
                  fullName: true,
                  regNumber: true,
                },
              },
            },
          },
          classroom: true,
        },
        orderBy: { startedAt: "desc" },
      });

      // Calculate distribution
      const statusDistribution = {
        present: 0,
        late: 0,
        absent: 0,
        excused: 0,
      };

      let totalRecords = 0;
      const sessionStats = [];

      for (const session of sessions) {
        const present = session.attendanceRecords.filter(
          (r) => r.status === "present",
        ).length;
        const late = session.attendanceRecords.filter(
          (r) => r.status === "late",
        ).length;
        const absent = session.attendanceRecords.filter(
          (r) => r.status === "absent",
        ).length;
        const excused = session.attendanceRecords.filter(
          (r) => r.status === "excused",
        ).length;

        statusDistribution.present += present;
        statusDistribution.late += late;
        statusDistribution.absent += absent;
        statusDistribution.excused += excused;
        totalRecords += session.attendanceRecords.length;

        sessionStats.push({
          sessionId: session.id,
          sessionCode: session.sessionCode,
          date: session.startedAt,
          present,
          late,
          absent,
          excused,
          total: session.attendanceRecords.length,
          classroom: session.classroom?.name,
        });
      }

      res.json({
        success: true,
        data: {
          course,
          summary: {
            totalSessions: sessions.length,
            totalRecords,
            distribution: statusDistribution,
            attendanceRate:
              totalRecords > 0
                ? parseFloat(
                    (
                      ((statusDistribution.present + statusDistribution.late) /
                        totalRecords) *
                      100
                    ).toFixed(1),
                  )
                : 0,
          },
          sessions: sessionStats,
        },
      });
    } catch (error) {
      logger.error("Get course attendance stats error:", error);
      next(error);
    }
  }

  /**
   * Helper: Calculate trends from sessions
   */
  calculateTrends(sessions, totalEnrolled) {
    if (sessions.length === 0) return [];

    const trends = [];
    const monthMap = new Map();

    for (const session of sessions) {
      const monthKey = session.startedAt.toISOString().substring(0, 7);
      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, {
          month: monthKey,
          sessions: 0,
          checkins: 0,
          possible: 0,
        });
      }
      const month = monthMap.get(monthKey);
      month.sessions++;
      month.checkins += session.roomCheckins.length;
      month.possible += totalEnrolled;
    }

    for (const [month, data] of monthMap) {
      trends.push({
        month,
        sessions: data.sessions,
        checkins: data.checkins,
        attendanceRate:
          data.possible > 0
            ? parseFloat(((data.checkins / data.possible) * 100).toFixed(1))
            : 0,
      });
    }

    return trends;
  }

  /**
   * Helper: Get at-risk count for a course
   */
  async getCourseAtRiskCount(courseId, threshold = 75) {
    const enrollments = await prisma.enrollment.findMany({
      where: { courseId, isActive: true },
      select: { studentId: true },
    });

    let atRiskCount = 0;

    for (const enrollment of enrollments) {
      const records = await prisma.attendanceRecord.findMany({
        where: {
          studentId: enrollment.studentId,
          session: { courseId },
        },
        select: { status: true },
      });

      const total = records.length;
      const attended = records.filter(
        (r) => r.status === "present" || r.status === "late",
      ).length;
      const rate = total > 0 ? (attended / total) * 100 : 100;

      if (rate < threshold && total > 0) {
        atRiskCount++;
      }
    }

    return atRiskCount;
  }

  /**
   * Helper: Get week number from date
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

module.exports = new AnalyticsController();
