const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");

class StudentController {
  /**
   * Student dashboard summary
   * GET /api/v1/students/dashboard
   */
  async getDashboard(req, res, next) {
    try {
      const studentId = req.user.id;
      const cacheKey = `student:dashboard:${studentId}`;

      // Check cache first
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

      // Get student profile with enrolled courses
      const student = await prisma.user.findUnique({
        where: { id: studentId, isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          regNumber: true,
          phone: true,
          createdAt: true,
          enrollments: {
            where: { isActive: true },
            select: {
              courseId: true,
              enrolledAt: true,
              course: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  credits: true,
                  lecturer: {
                    select: { id: true, fullName: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!student) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Student not found" },
        });
      }

      // Get active sessions for today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const courseIds = student.enrollments.map((e) => e.courseId);

      let todaySessions = [];
      if (courseIds.length > 0) {
        todaySessions = await prisma.session.findMany({
          where: {
            courseId: { in: courseIds },
            status: "active",
            checkinOpen: true,
            expiresAt: { gt: new Date() },
            startedAt: { gte: today, lt: tomorrow },
          },
          select: {
            id: true,
            sessionCode: true,
            startedAt: true,
            expiresAt: true,
            durationMinutes: true,
            course: {
              select: { id: true, code: true, name: true },
            },
            classroom: {
              select: {
                id: true,
                name: true,
                building: true,
                latitude: true,
                longitude: true,
                radiusM: true,
              },
            },
            lecturer: {
              select: { id: true, fullName: true },
            },
          },
          orderBy: { startedAt: "asc" },
        });
      }

      // Get attendance statistics using transactions for better performance
      const [
        totalRecords,
        presentRecords,
        lateRecords,
        absentRecords,
        excusedRecords,
      ] = await Promise.all([
        prisma.attendanceRecord.count({ where: { studentId } }),
        prisma.attendanceRecord.count({
          where: { studentId, status: "present" },
        }),
        prisma.attendanceRecord.count({ where: { studentId, status: "late" } }),
        prisma.attendanceRecord.count({
          where: { studentId, status: "absent" },
        }),
        prisma.attendanceRecord.count({
          where: { studentId, status: "excused" },
        }),
      ]);

      const overallAttendanceRate =
        totalRecords > 0
          ? ((presentRecords + lateRecords) / totalRecords) * 100
          : 0;

      // Get recent attendance records
      const recentAttendance = await prisma.attendanceRecord.findMany({
        where: { studentId },
        select: {
          id: true,
          status: true,
          markedAt: true,
          submissionMethod: true,
          geofencePassed: true,
          distanceM: true,
          session: {
            select: {
              id: true,
              sessionCode: true,
              startedAt: true,
              course: {
                select: { id: true, code: true, name: true },
              },
              classroom: {
                select: { name: true, building: true },
              },
            },
          },
        },
        orderBy: { markedAt: "desc" },
        take: 5,
      });

      // Get attendance by course
      const attendanceByCourse = [];
      for (const enrollment of student.enrollments) {
        const [courseStats, presentCount] = await Promise.all([
          prisma.attendanceRecord.count({
            where: {
              studentId,
              session: { courseId: enrollment.courseId },
            },
          }),
          prisma.attendanceRecord.count({
            where: {
              studentId,
              session: { courseId: enrollment.courseId },
              status: { in: ["present", "late"] },
            },
          }),
        ]);

        const courseRate =
          courseStats > 0 ? (presentCount / courseStats) * 100 : 0;

        attendanceByCourse.push({
          courseId: enrollment.course.id,
          courseCode: enrollment.course.code,
          courseName: enrollment.course.name,
          totalSessions: courseStats,
          presentCount,
          attendanceRate: parseFloat(courseRate.toFixed(1)),
          credits: enrollment.course.credits,
        });
      }

      // Check check-in status for today's sessions
      let checkedInSessions = [];
      if (todaySessions.length > 0) {
        checkedInSessions = await prisma.roomCheckin.findMany({
          where: {
            studentId,
            sessionId: { in: todaySessions.map((s) => s.id) },
          },
          select: { sessionId: true, checkedInAt: true, status: true },
        });
      }

      const checkinMap = new Map(
        checkedInSessions.map((c) => [c.sessionId, c]),
      );

      const enrichedTodaySessions = todaySessions.map((session) => ({
        ...session,
        timeRemaining: Math.max(
          0,
          Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
        ),
        hasCheckedIn: checkinMap.has(session.id),
        checkedInAt: checkinMap.get(session.id)?.checkedInAt || null,
        checkinStatus: checkinMap.get(session.id)?.status || null,
      }));

      const dashboardData = {
        profile: {
          id: student.id,
          fullName: student.fullName,
          email: student.email,
          regNumber: student.regNumber,
          phone: student.phone,
          enrolledCoursesCount: student.enrollments.length,
          memberSince: student.createdAt,
        },
        attendanceSummary: {
          totalSessions: totalRecords,
          present: presentRecords,
          late: lateRecords,
          absent: absentRecords,
          excused: excusedRecords,
          attendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
        },
        attendanceByCourse,
        todaySessions: enrichedTodaySessions,
        recentAttendance,
      };

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 120, JSON.stringify(dashboardData));
      }

      res.json({
        success: true,
        data: dashboardData,
      });
    } catch (error) {
      logger.error("Dashboard error:", error);
      next(error);
    }
  }

  /**
   * Student attendance history with advanced filtering
   * GET /api/v1/students/attendance/history
   */
  async getAttendanceHistory(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        courseId,
        status,
        from,
        to,
        sortBy = "markedAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      // Build where clause
      const where = { studentId: req.user.id };

      if (courseId) {
        where.session = { courseId };
      }

      if (status && ["present", "absent", "excused", "late"].includes(status)) {
        where.status = status;
      }

      if (from || to) {
        where.markedAt = {};
        if (from) where.markedAt.gte = new Date(from);
        if (to) where.markedAt.lte = new Date(to);
      }

      // Get total count for pagination
      const total = await prisma.attendanceRecord.count({ where });

      // Get paginated records
      const records = await prisma.attendanceRecord.findMany({
        where,
        select: {
          id: true,
          status: true,
          submissionMethod: true,
          geofencePassed: true,
          distanceM: true,
          markedAt: true,
          overriddenAt: true,
          overriddenBy: true,
          overrideReason: true,
          notes: true,
          session: {
            select: {
              id: true,
              sessionCode: true,
              startedAt: true,
              expiresAt: true,
              durationMinutes: true,
              course: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  credits: true,
                },
              },
              classroom: {
                select: {
                  id: true,
                  name: true,
                  building: true,
                },
              },
              lecturer: {
                select: {
                  id: true,
                  fullName: true,
                },
              },
            },
          },
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take,
      });

      // Calculate summary statistics using transactions
      const [present, late, absent, excused] = await Promise.all([
        prisma.attendanceRecord.count({
          where: { ...where, status: "present" },
        }),
        prisma.attendanceRecord.count({ where: { ...where, status: "late" } }),
        prisma.attendanceRecord.count({
          where: { ...where, status: "absent" },
        }),
        prisma.attendanceRecord.count({
          where: { ...where, status: "excused" },
        }),
      ]);

      res.json({
        success: true,
        data: records,
        summary: {
          total,
          present,
          late,
          absent,
          excused,
          attendanceRate:
            total > 0
              ? parseFloat((((present + late) / total) * 100).toFixed(1))
              : 0,
        },
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
          hasNextPage: skip + take < total,
          hasPrevPage: page > 1,
        },
      });
    } catch (error) {
      logger.error("Attendance history error:", error);
      next(error);
    }
  }

  /**
   * Attendance trends for charts with multiple views
   * GET /api/v1/students/attendance/trends
   */
  async getAttendanceTrends(req, res, next) {
    try {
      const { courseId, view = "monthly", months = 6 } = req.query;

      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - parseInt(months));

      const cacheKey = `student:trends:${req.user.id}:${courseId || "all"}:${view}`;

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

      const where = {
        studentId: req.user.id,
        markedAt: { gte: startDate },
      };

      if (courseId) {
        where.session = { courseId };
      }

      const records = await prisma.attendanceRecord.findMany({
        where,
        select: {
          status: true,
          markedAt: true,
          session: {
            select: {
              course: {
                select: { id: true, code: true, name: true },
              },
            },
          },
        },
        orderBy: { markedAt: "asc" },
      });

      let trends = [];
      const courseData = {};

      if (view === "weekly") {
        // Group by week
        const weeklyData = new Map();
        records.forEach((record) => {
          const weekNumber = this.getWeekNumber(record.markedAt);
          const year = record.markedAt.getFullYear();
          const weekKey = `${year}-W${weekNumber}`;

          if (!weeklyData.has(weekKey)) {
            weeklyData.set(weekKey, {
              present: 0,
              late: 0,
              absent: 0,
              excused: 0,
              total: 0,
            });
          }
          const week = weeklyData.get(weekKey);
          week[record.status]++;
          week.total++;
        });

        trends = Array.from(weeklyData.entries()).map(([week, data]) => ({
          period: week,
          ...data,
          rate:
            data.total > 0
              ? parseFloat(
                  (((data.present + data.late) / data.total) * 100).toFixed(1),
                )
              : 0,
        }));
      } else {
        // Group by month (default)
        const monthlyData = new Map();
        records.forEach((record) => {
          const monthKey = record.markedAt.toISOString().substring(0, 7);
          if (!monthlyData.has(monthKey)) {
            monthlyData.set(monthKey, {
              present: 0,
              late: 0,
              absent: 0,
              excused: 0,
              total: 0,
            });
          }
          const month = monthlyData.get(monthKey);
          month[record.status]++;
          month.total++;
        });

        trends = Array.from(monthlyData.entries()).map(([month, data]) => ({
          period: month,
          ...data,
          rate:
            data.total > 0
              ? parseFloat(
                  (((data.present + data.late) / data.total) * 100).toFixed(1),
                )
              : 0,
        }));
      }

      // Calculate course breakdown
      records.forEach((record) => {
        const courseIdKey = record.session.course.id;
        if (!courseData[courseIdKey]) {
          courseData[courseIdKey] = {
            courseId: courseIdKey,
            courseCode: record.session.course.code,
            courseName: record.session.course.name,
            present: 0,
            late: 0,
            absent: 0,
            excused: 0,
          };
        }
        courseData[courseIdKey][record.status]++;
      });

      const byCourse = Object.values(courseData).map((course) => {
        const total =
          course.present + course.late + course.absent + course.excused;
        return {
          ...course,
          total,
          rate:
            total > 0
              ? parseFloat(
                  (((course.present + course.late) / total) * 100).toFixed(1),
                )
              : 0,
        };
      });

      const responseData = {
        view,
        trends,
        byCourse,
        summary: {
          totalRecords: records.length,
          dateRange: {
            from: startDate,
            to: new Date(),
          },
        },
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
      logger.error("Attendance trends error:", error);
      next(error);
    }
  }

  /**
   * Get attendance summary by course
   * GET /api/v1/students/attendance/summary
   */
  async getAttendanceSummary(req, res, next) {
    try {
      const studentId = req.user.id;
      const cacheKey = `student:summary:${studentId}`;

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

      const enrollments = await prisma.enrollment.findMany({
        where: { studentId, isActive: true },
        include: {
          course: {
            select: {
              id: true,
              code: true,
              name: true,
              credits: true,
              academicYear: true,
              semester: true,
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
      });

      const summary = [];
      let totalCredits = 0;
      let totalOverallSessions = 0;
      let totalOverallPresent = 0;

      for (const enrollment of enrollments) {
        totalCredits += enrollment.course.credits;

        const [attendanceRecords, totalSessionsCount] = await Promise.all([
          prisma.attendanceRecord.findMany({
            where: {
              studentId,
              session: { courseId: enrollment.courseId },
            },
            select: { status: true, markedAt: true },
          }),
          prisma.session.count({
            where: {
              courseId: enrollment.courseId,
              status: "closed",
            },
          }),
        ]);

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

        totalOverallSessions += totalSessions;
        totalOverallPresent += presentCount + lateCount;

        // Calculate attendance streaks
        const sortedRecords = attendanceRecords.sort(
          (a, b) => a.markedAt - b.markedAt,
        );
        let currentStreak = 0;
        let longestStreak = 0;
        let streak = 0;

        for (const record of sortedRecords) {
          if (record.status === "present" || record.status === "late") {
            streak++;
            longestStreak = Math.max(longestStreak, streak);
            currentStreak = streak;
          } else {
            streak = 0;
          }
        }

        summary.push({
          course: enrollment.course,
          stats: {
            totalSessions,
            totalExpectedSessions: totalSessionsCount,
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
                : 0,
            currentStreak,
            longestStreak,
          },
        });
      }

      const responseData = {
        overall: {
          totalCourses: enrollments.length,
          totalCredits,
          overallAttendanceRate:
            totalOverallSessions > 0
              ? parseFloat(
                  ((totalOverallPresent / totalOverallSessions) * 100).toFixed(
                    1,
                  ),
                )
              : 0,
        },
        courses: summary,
      };

      // Cache for 10 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 600, JSON.stringify(responseData));
      }

      res.json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      logger.error("Get attendance summary error:", error);
      next(error);
    }
  }

  /**
   * List enrolled courses
   * GET /api/v1/students/courses
   */
  async getEnrolledCourses(req, res, next) {
    try {
      const { semester, academicYear, includeProgress = false } = req.query;
      const studentId = req.user.id;

      const cacheKey = `student:courses:${studentId}:${semester || ""}:${academicYear || ""}:${includeProgress}`;

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

      const where = {
        studentId,
        isActive: true,
      };

      const enrollments = await prisma.enrollment.findMany({
        where,
        select: {
          enrolledAt: true,
          isActive: true,
          course: {
            select: {
              id: true,
              code: true,
              name: true,
              description: true,
              credits: true,
              semester: true,
              academicYear: true,
              isActive: true,
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
        orderBy: { enrolledAt: "desc" },
      });

      let courses = enrollments.map((e) => ({
        ...e.course,
        enrolledAt: e.enrolledAt,
      }));

      // Apply filters
      if (semester) {
        courses = courses.filter((c) => c.semester === parseInt(semester));
      }

      if (academicYear) {
        courses = courses.filter((c) => c.academicYear === academicYear);
      }

      // Include progress if requested
      if (includeProgress === "true") {
        const coursesWithProgress = await Promise.all(
          courses.map(async (course) => {
            const [totalSessions, presentCount] = await Promise.all([
              prisma.attendanceRecord.count({
                where: {
                  studentId,
                  session: { courseId: course.id },
                },
              }),
              prisma.attendanceRecord.count({
                where: {
                  studentId,
                  session: { courseId: course.id },
                  status: { in: ["present", "late"] },
                },
              }),
            ]);

            return {
              ...course,
              progress: {
                totalSessions,
                attendedSessions: presentCount,
                attendanceRate:
                  totalSessions > 0
                    ? parseFloat(
                        ((presentCount / totalSessions) * 100).toFixed(1),
                      )
                    : 0,
              },
            };
          }),
        );
        courses = coursesWithProgress;
      }

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(courses));
      }

      res.json({
        success: true,
        data: courses,
        meta: {
          total: courses.length,
          includeProgress: includeProgress === "true",
        },
      });
    } catch (error) {
      logger.error("Get enrolled courses error:", error);
      next(error);
    }
  }

  /**
   * Get active sessions for enrolled courses
   * GET /api/v1/students/sessions/active
   */
  async getActiveSessions(req, res, next) {
    try {
      const studentId = req.user.id;
      const cacheKey = `student:active-sessions:${studentId}`;

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

      // Get student's enrolled courses
      const enrollments = await prisma.enrollment.findMany({
        where: { studentId, isActive: true },
        select: { courseId: true },
      });

      const courseIds = enrollments.map((e) => e.courseId);

      if (courseIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // Get active sessions
      const sessions = await prisma.session.findMany({
        where: {
          courseId: { in: courseIds },
          status: "active",
          checkinOpen: true,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          sessionCode: true,
          startedAt: true,
          expiresAt: true,
          durationMinutes: true,
          checkinsCount: true,
          course: {
            select: {
              id: true,
              code: true,
              name: true,
              description: true,
            },
          },
          classroom: {
            select: {
              id: true,
              name: true,
              building: true,
              latitude: true,
              longitude: true,
              radiusM: true,
            },
          },
          lecturer: {
            select: {
              id: true,
              fullName: true,
            },
          },
        },
        orderBy: { expiresAt: "asc" },
      });

      if (sessions.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // Check if student already checked in
      const sessionIds = sessions.map((s) => s.id);
      const existingCheckins = await prisma.roomCheckin.findMany({
        where: {
          studentId,
          sessionId: { in: sessionIds },
        },
        select: {
          sessionId: true,
          checkedInAt: true,
          status: true,
          distanceM: true,
        },
      });

      const checkinMap = new Map(existingCheckins.map((c) => [c.sessionId, c]));

      const sessionsWithStatus = sessions.map((session) => ({
        ...session,
        hasCheckedIn: checkinMap.has(session.id),
        checkedInAt: checkinMap.get(session.id)?.checkedInAt || null,
        checkinStatus: checkinMap.get(session.id)?.status || null,
        distanceM: checkinMap.get(session.id)?.distanceM || null,
        timeRemaining: Math.max(
          0,
          Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
        ),
        isExpiringSoon:
          new Date(session.expiresAt) - new Date() < 15 * 60 * 1000,
      }));

      // Cache for 30 seconds (sessions change frequently)
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(
          cacheKey,
          30,
          JSON.stringify(sessionsWithStatus),
        );
      }

      res.json({
        success: true,
        data: sessionsWithStatus,
        meta: {
          total: sessionsWithStatus.length,
          availableForCheckin: sessionsWithStatus.filter((s) => !s.hasCheckedIn)
            .length,
        },
      });
    } catch (error) {
      logger.error("Get active sessions error:", error);
      next(error);
    }
  }

  /**
   * Get upcoming scheduled sessions
   * GET /api/v1/students/sessions/upcoming
   */
  async getUpcomingSessions(req, res, next) {
    try {
      const studentId = req.user.id;
      const { days = 7 } = req.query;
      const cacheKey = `student:upcoming:${studentId}:${days}`;

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

      const endDate = new Date();
      endDate.setDate(endDate.getDate() + parseInt(days));

      const enrollments = await prisma.enrollment.findMany({
        where: { studentId, isActive: true },
        select: { courseId: true },
      });

      const courseIds = enrollments.map((e) => e.courseId);

      if (courseIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // Get sessions that are active for the upcoming days
      const upcomingSessions = await prisma.session.findMany({
        where: {
          courseId: { in: courseIds },
          status: "active",
          startedAt: { gte: new Date(), lte: endDate },
        },
        select: {
          id: true,
          sessionCode: true,
          startedAt: true,
          expiresAt: true,
          durationMinutes: true,
          course: {
            select: { id: true, code: true, name: true },
          },
          classroom: {
            select: { name: true, building: true },
          },
        },
        orderBy: { startedAt: "asc" },
      });

      // Check which ones the student has already checked into
      if (upcomingSessions.length > 0) {
        const sessionIds = upcomingSessions.map((s) => s.id);
        const checkins = await prisma.roomCheckin.findMany({
          where: {
            studentId,
            sessionId: { in: sessionIds },
          },
          select: { sessionId: true },
        });

        const checkedInSet = new Set(checkins.map((c) => c.sessionId));
        upcomingSessions.forEach((session) => {
          session.hasCheckedIn = checkedInSet.has(session.id);
        });
      }

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(
          cacheKey,
          120,
          JSON.stringify(upcomingSessions),
        );
      }

      res.json({
        success: true,
        data: upcomingSessions,
        meta: {
          days: parseInt(days),
          count: upcomingSessions.length,
        },
      });
    } catch (error) {
      logger.error("Get upcoming sessions error:", error);
      next(error);
    }
  }

  /**
   * Invalidate student cache (call this when data changes)
   * POST /api/v1/students/cache/invalidate
   */
  async invalidateCache(req, res, next) {
    try {
      const studentId = req.user.id;

      if (redisClient && redisClient.isReady) {
        const patterns = [
          `student:dashboard:${studentId}`,
          `student:summary:${studentId}`,
          `student:active-sessions:${studentId}`,
          `student:trends:${studentId}:*`,
          `student:courses:${studentId}:*`,
          `student:upcoming:${studentId}:*`,
        ];

        for (const pattern of patterns) {
          const keys = await redisClient.keys(pattern);
          if (keys.length > 0) {
            await redisClient.del(keys);
          }
        }

        logger.info(`Cache invalidated for student: ${studentId}`);
      }

      res.json({
        success: true,
        data: { message: "Cache invalidated successfully" },
      });
    } catch (error) {
      logger.error("Cache invalidation error:", error);
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

module.exports = new StudentController();
