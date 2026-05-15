const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");

class DashboardController {
  /**
   * Get role-based dashboard
   * GET /api/v1/dashboard
   */
  async getDashboard(req, res, next) {
    try {
      const { role } = req.user;

      switch (role) {
        case "student":
          return await this.getStudentDashboard(req, res);
        case "lecturer":
          return await this.getLecturerDashboard(req, res);
        case "admin":
          return await this.getAdminDashboard(req, res);
        default:
          return res.status(400).json({
            success: false,
            error: { code: "INVALID_ROLE", message: "Invalid user role" },
          });
      }
    } catch (error) {
      logger.error("Get dashboard error:", error);
      next(error);
    }
  }

  /**
   * Student Dashboard
   * GET /api/v1/dashboard/student
   */
  async getStudentDashboard(req, res) {
    try {
      const studentId = req.user.id;
      const cacheKey = `dashboard:student:${studentId}`;

      // Check cache
      let cachedData = null;
      if (redisClient && redisClient.isReady) {
        cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json({
            success: true,
            data: JSON.parse(cachedData),
            meta: { cached: true, role: "student" },
          });
        }
      }

      // Get student profile with enrollments
      const student = await prisma.user.findUnique({
        where: { id: studentId, isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
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

      // Get attendance statistics
      const attendanceStats = await this.getStudentAttendanceStats(studentId);

      // Get active sessions for today
      const activeSessions = await this.getStudentActiveSessions(studentId);

      // Get upcoming sessions (next 7 days)
      const upcomingSessions = await this.getStudentUpcomingSessions(studentId);

      // Get recent activity
      const recentActivity = await this.getStudentRecentActivity(studentId);

      // Get notifications
      const notifications = await this.getStudentNotifications(studentId);

      // Calculate course progress
      const courseProgress = await this.getStudentCourseProgress(studentId);

      const dashboardData = {
        role: "student",
        profile: {
          id: student.id,
          fullName: student.fullName,
          email: student.email,
          regNumber: student.regNumber,
          phone: student.phone,
          memberSince: student.createdAt,
          enrolledCoursesCount: student.enrollments.length,
        },
        attendance: attendanceStats,
        activeSessions,
        upcomingSessions,
        courseProgress,
        recentActivity,
        notifications,
        lastUpdated: new Date(),
      };

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 120, JSON.stringify(dashboardData));
      }

      res.json({ success: true, data: dashboardData });
    } catch (error) {
      logger.error("Get student dashboard error:", error);
      throw error;
    }
  }

  /**
   * Lecturer Dashboard
   * GET /api/v1/dashboard/lecturer
   */
  async getLecturerDashboard(req, res) {
    try {
      const lecturerId = req.user.id;
      const cacheKey = `dashboard:lecturer:${lecturerId}`;

      // Check cache
      let cachedData = null;
      if (redisClient && redisClient.isReady) {
        cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json({
            success: true,
            data: JSON.parse(cachedData),
            meta: { cached: true, role: "lecturer" },
          });
        }
      }

      // Get lecturer profile
      const lecturer = await prisma.user.findUnique({
        where: { id: lecturerId, isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          staffNumber: true,
          phone: true,
          createdAt: true,
        },
      });

      if (!lecturer) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Lecturer not found" },
        });
      }

      // Get courses overview
      const coursesOverview = await this.getLecturerCoursesOverview(lecturerId);

      // Get active sessions
      const activeSessions = await this.getLecturerActiveSessions(lecturerId);

      // Get today's schedule
      const todaySchedule = await this.getLecturerTodaySchedule(lecturerId);

      // Get recent activity
      const recentActivity = await this.getLecturerRecentActivity(lecturerId);

      // Get at-risk students summary
      const atRiskSummary = await this.getLecturerAtRiskSummary(lecturerId);

      // Get notifications
      const notifications = await this.getLecturerNotifications(lecturerId);

      // Calculate summary statistics
      const totalStudents = coursesOverview.reduce(
        (sum, c) => sum + c.enrolledCount,
        0,
      );
      const totalSessions = coursesOverview.reduce(
        (sum, c) => sum + c.totalSessions,
        0,
      );
      const avgAttendance =
        coursesOverview.length > 0
          ? coursesOverview.reduce((sum, c) => sum + c.attendanceRate, 0) /
            coursesOverview.length
          : 0;

      const dashboardData = {
        role: "lecturer",
        profile: {
          id: lecturer.id,
          fullName: lecturer.fullName,
          email: lecturer.email,
          staffNumber: lecturer.staffNumber,
          phone: lecturer.phone,
          memberSince: lecturer.createdAt,
        },
        summary: {
          totalCourses: coursesOverview.length,
          totalStudents,
          totalSessions,
          activeSessions: activeSessions.length,
          averageAttendanceRate: parseFloat(avgAttendance.toFixed(1)),
          atRiskStudents: atRiskSummary.total,
        },
        coursesOverview,
        activeSessions,
        todaySchedule,
        recentActivity,
        atRiskSummary,
        notifications,
        lastUpdated: new Date(),
      };

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 120, JSON.stringify(dashboardData));
      }

      res.json({ success: true, data: dashboardData });
    } catch (error) {
      logger.error("Get lecturer dashboard error:", error);
      throw error;
    }
  }

  /**
   * Admin Dashboard
   * GET /api/v1/dashboard/admin
   */
  async getAdminDashboard(req, res) {
    try {
      const cacheKey = "dashboard:admin";

      // Check cache
      let cachedData = null;
      if (redisClient && redisClient.isReady) {
        cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json({
            success: true,
            data: JSON.parse(cachedData),
            meta: { cached: true, role: "admin" },
          });
        }
      }

      // Get admin profile
      const admin = await prisma.user.findUnique({
        where: { id: req.user.id, isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          staffNumber: true,
          createdAt: true,
        },
      });

      // Get system-wide statistics
      const systemStats = await this.getSystemStats();

      // Get user statistics
      const userStats = await this.getUserStats();

      // Get academic statistics
      const academicStats = await this.getAcademicStats();

      // Get attendance overview
      const attendanceOverview = await this.getAttendanceOverview();

      // Get recent activity
      const recentActivity = await this.getAdminRecentActivity();

      // Get system health
      const systemHealth = await this.getSystemHealth();

      const dashboardData = {
        role: "admin",
        profile: {
          id: admin.id,
          fullName: admin.fullName,
          email: admin.email,
          staffNumber: admin.staffNumber,
          memberSince: admin.createdAt,
        },
        systemStats,
        userStats,
        academicStats,
        attendanceOverview,
        recentActivity,
        systemHealth,
        lastUpdated: new Date(),
      };

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(dashboardData));
      }

      res.json({ success: true, data: dashboardData });
    } catch (error) {
      logger.error("Get admin dashboard error:", error);
      throw error;
    }
  }

  /**
   * Get widget data for dashboard
   * GET /api/v1/dashboard/widgets
   */
  async getDashboardWidgets(req, res, next) {
    try {
      const { role } = req.user;
      const { widgets } = req.query;

      const requestedWidgets = widgets ? widgets.split(",") : [];
      const widgetData = {};

      if (role === "student") {
        if (requestedWidgets.includes("attendance") || !widgets) {
          widgetData.attendance = await this.getStudentAttendanceStats(
            req.user.id,
          );
        }
        if (requestedWidgets.includes("sessions") || !widgets) {
          widgetData.activeSessions = await this.getStudentActiveSessions(
            req.user.id,
          );
        }
        if (requestedWidgets.includes("upcoming") || !widgets) {
          widgetData.upcomingSessions = await this.getStudentUpcomingSessions(
            req.user.id,
          );
        }
        if (requestedWidgets.includes("progress") || !widgets) {
          widgetData.courseProgress = await this.getStudentCourseProgress(
            req.user.id,
          );
        }
      } else if (role === "lecturer") {
        if (requestedWidgets.includes("courses") || !widgets) {
          widgetData.coursesOverview = await this.getLecturerCoursesOverview(
            req.user.id,
          );
        }
        if (requestedWidgets.includes("active") || !widgets) {
          widgetData.activeSessions = await this.getLecturerActiveSessions(
            req.user.id,
          );
        }
        if (requestedWidgets.includes("atrisk") || !widgets) {
          widgetData.atRiskSummary = await this.getLecturerAtRiskSummary(
            req.user.id,
          );
        }
      } else if (role === "admin") {
        if (requestedWidgets.includes("system") || !widgets) {
          widgetData.systemStats = await this.getSystemStats();
        }
        if (requestedWidgets.includes("users") || !widgets) {
          widgetData.userStats = await this.getUserStats();
        }
        if (requestedWidgets.includes("attendance") || !widgets) {
          widgetData.attendanceOverview = await this.getAttendanceOverview();
        }
        if (requestedWidgets.includes("health") || !widgets) {
          widgetData.systemHealth = await this.getSystemHealth();
        }
      }

      res.json({
        success: true,
        data: widgetData,
        meta: { widgets: Object.keys(widgetData) },
      });
    } catch (error) {
      logger.error("Get dashboard widgets error:", error);
      next(error);
    }
  }

  /**
   * Refresh dashboard cache
   * POST /api/v1/dashboard/refresh
   */
  async refreshDashboard(req, res, next) {
    try {
      const { role } = req.user;

      if (redisClient && redisClient.isReady) {
        if (role === "student") {
          await redisClient.del(`dashboard:student:${req.user.id}`);
        } else if (role === "lecturer") {
          await redisClient.del(`dashboard:lecturer:${req.user.id}`);
        } else if (role === "admin") {
          await redisClient.del("dashboard:admin");
        }
      }

      logger.info(`Dashboard cache refreshed for ${role}: ${req.user.id}`);

      res.json({
        success: true,
        data: { message: "Dashboard cache refreshed successfully" },
      });
    } catch (error) {
      logger.error("Refresh dashboard error:", error);
      next(error);
    }
  }

  // ==================== Helper Methods ====================

  /**
   * Get student attendance statistics
   */
  async getStudentAttendanceStats(studentId) {
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
      prisma.attendanceRecord.count({ where: { studentId, status: "absent" } }),
      prisma.attendanceRecord.count({
        where: { studentId, status: "excused" },
      }),
    ]);

    const attended = presentRecords + lateRecords;
    const attendanceRate =
      totalRecords > 0 ? (attended / totalRecords) * 100 : 100;

    // Calculate streak
    const recentRecords = await prisma.attendanceRecord.findMany({
      where: { studentId },
      orderBy: { markedAt: "desc" },
      take: 10,
    });

    let currentStreak = 0;
    let longestStreak = 0;
    let streak = 0;

    for (const record of recentRecords.reverse()) {
      if (record.status === "present" || record.status === "late") {
        streak++;
        longestStreak = Math.max(longestStreak, streak);
        currentStreak = streak;
      } else {
        streak = 0;
      }
    }

    return {
      totalSessions: totalRecords,
      present: presentRecords,
      late: lateRecords,
      absent: absentRecords,
      excused: excusedRecords,
      attended,
      attendanceRate: parseFloat(attendanceRate.toFixed(1)),
      currentStreak,
      longestStreak,
    };
  }

  /**
   * Get student active sessions
   */
  async getStudentActiveSessions(studentId) {
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId, isActive: true },
      select: { courseId: true },
    });

    const courseIds = enrollments.map((e) => e.courseId);

    if (courseIds.length === 0) return [];

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
        course: {
          select: { id: true, code: true, name: true },
        },
        classroom: {
          select: { id: true, name: true, building: true },
        },
      },
      orderBy: { expiresAt: "asc" },
      take: 5,
    });

    // Check which sessions student already checked into
    const sessionIds = sessions.map((s) => s.id);
    const checkins = await prisma.roomCheckin.findMany({
      where: {
        studentId,
        sessionId: { in: sessionIds },
      },
      select: { sessionId: true, checkedInAt: true },
    });

    const checkinMap = new Map(checkins.map((c) => [c.sessionId, c]));

    return sessions.map((session) => ({
      ...session,
      hasCheckedIn: checkinMap.has(session.id),
      checkedInAt: checkinMap.get(session.id)?.checkedInAt || null,
      timeRemaining: Math.max(
        0,
        Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
      ),
    }));
  }

  /**
   * Get student upcoming sessions
   */
  async getStudentUpcomingSessions(studentId) {
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId, isActive: true },
      select: { courseId: true },
    });

    const courseIds = enrollments.map((e) => e.courseId);

    if (courseIds.length === 0) return [];

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);

    const sessions = await prisma.session.findMany({
      where: {
        courseId: { in: courseIds },
        startedAt: { gt: new Date(), lt: endDate },
        status: { in: ["active", "scheduled"] },
      },
      select: {
        id: true,
        sessionCode: true,
        startedAt: true,
        expiresAt: true,
        course: {
          select: { id: true, code: true, name: true },
        },
        classroom: {
          select: { name: true, building: true },
        },
      },
      orderBy: { startedAt: "asc" },
      take: 10,
    });

    return sessions;
  }

  /**
   * Get student recent activity
   */
  async getStudentRecentActivity(studentId) {
    const recentCheckins = await prisma.roomCheckin.findMany({
      where: { studentId },
      select: {
        id: true,
        checkedInAt: true,
        distanceM: true,
        submissionMethod: true,
        session: {
          select: {
            sessionCode: true,
            course: {
              select: { name: true, code: true },
            },
          },
        },
      },
      orderBy: { checkedInAt: "desc" },
      take: 10,
    });

    return recentCheckins.map((checkin) => ({
      type: "checkin",
      title: `Checked into ${checkin.session.course.name}`,
      description: `Session: ${checkin.session.sessionCode}`,
      timestamp: checkin.checkedInAt,
      data: {
        distanceM: checkin.distanceM,
        method: checkin.submissionMethod,
      },
    }));
  }

  /**
   * Get student notifications
   */
  async getStudentNotifications(studentId) {
    // Get recent attendance warnings
    const warnings = await prisma.attendanceRecord.findMany({
      where: {
        studentId,
        status: "absent",
        markedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      include: {
        session: {
          include: {
            course: { select: { name: true } },
          },
        },
      },
      take: 5,
    });

    return warnings.map((warning) => ({
      type: "warning",
      title: "Missed Session",
      message: `You missed ${warning.session.course.name} on ${warning.markedAt.toLocaleDateString()}`,
      timestamp: warning.markedAt,
      read: false,
    }));
  }

  /**
   * Get student course progress
   */
  async getStudentCourseProgress(studentId) {
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId, isActive: true },
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
    });

    const progress = [];
    for (const enrollment of enrollments) {
      const totalSessions = await prisma.session.count({
        where: { courseId: enrollment.courseId, status: "closed" },
      });

      const attendedSessions = await prisma.attendanceRecord.count({
        where: {
          studentId,
          session: { courseId: enrollment.courseId },
          status: { in: ["present", "late"] },
        },
      });

      progress.push({
        courseId: enrollment.course.id,
        courseCode: enrollment.course.code,
        courseName: enrollment.course.name,
        credits: enrollment.course.credits,
        totalSessions,
        attendedSessions,
        attendanceRate:
          totalSessions > 0
            ? parseFloat(((attendedSessions / totalSessions) * 100).toFixed(1))
            : 100,
      });
    }

    return progress;
  }

  /**
   * Get lecturer courses overview
   */
  async getLecturerCoursesOverview(lecturerId) {
    const courses = await prisma.course.findMany({
      where: { lecturerId, isActive: true },
      include: {
        enrollments: {
          where: { isActive: true },
          select: { id: true },
        },
        sessions: {
          where: { status: "closed" },
          include: {
            attendanceRecords: true,
          },
        },
      },
    });

    return courses.map((course) => {
      const enrolledCount = course.enrollments.length;
      const totalSessions = course.sessions.length;
      let totalPresent = 0;
      let totalPossible = 0;

      for (const session of course.sessions) {
        totalPresent += session.attendanceRecords.filter(
          (r) => r.status === "present",
        ).length;
        totalPossible += session.attendanceRecords.length;
      }

      const attendanceRate =
        totalPossible > 0 ? (totalPresent / totalPossible) * 100 : 0;

      return {
        id: course.id,
        code: course.code,
        name: course.name,
        enrolledCount,
        totalSessions,
        attendanceRate: parseFloat(attendanceRate.toFixed(1)),
      };
    });
  }

  /**
   * Get lecturer active sessions
   */
  async getLecturerActiveSessions(lecturerId) {
    const sessions = await prisma.session.findMany({
      where: {
        lecturerId,
        status: "active",
        checkinOpen: true,
      },
      include: {
        course: { select: { code: true, name: true } },
        classroom: { select: { name: true, building: true } },
        _count: { select: { roomCheckins: true } },
      },
      orderBy: { expiresAt: "asc" },
    });

    return sessions.map((session) => ({
      id: session.id,
      sessionCode: session.sessionCode,
      courseName: session.course.name,
      classroom: session.classroom.name,
      expiresAt: session.expiresAt,
      timeRemaining: Math.max(
        0,
        Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
      ),
      checkinsCount: session._count.roomCheckins,
    }));
  }

  /**
   * Get lecturer today schedule
   */
  async getLecturerTodaySchedule(lecturerId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const sessions = await prisma.session.findMany({
      where: {
        lecturerId,
        startedAt: { gte: today, lt: tomorrow },
      },
      include: {
        course: { select: { code: true, name: true } },
        classroom: { select: { name: true } },
        _count: { select: { roomCheckins: true } },
      },
      orderBy: { startedAt: "asc" },
    });

    return sessions.map((session) => ({
      id: session.id,
      sessionCode: session.sessionCode,
      courseName: session.course.name,
      classroom: session.classroom.name,
      startTime: session.startedAt,
      endTime: session.expiresAt,
      status: session.status,
      checkinsCount: session._count.roomCheckins,
    }));
  }

  /**
   * Get lecturer recent activity
   */
  async getLecturerRecentActivity(lecturerId) {
    const recentSessions = await prisma.session.findMany({
      where: { lecturerId },
      include: {
        course: { select: { name: true, code: true } },
        _count: { select: { roomCheckins: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 10,
    });

    return recentSessions.map((session) => ({
      type: "session",
      title: `${session.course.name} Session`,
      description: `Session ${session.sessionCode} - ${session._count.roomCheckins} students checked in`,
      timestamp: session.startedAt,
      data: {
        sessionId: session.id,
        status: session.status,
        checkins: session._count.roomCheckins,
      },
    }));
  }

  /**
   * Get lecturer at-risk summary
   */
  async getLecturerAtRiskSummary(lecturerId) {
    const courses = await prisma.course.findMany({
      where: { lecturerId, isActive: true },
      include: {
        enrollments: {
          where: { isActive: true },
          include: {
            student: true,
          },
        },
      },
    });

    let totalAtRisk = 0;
    const atRiskByCourse = [];

    for (const course of courses) {
      let courseAtRisk = 0;
      for (const enrollment of course.enrollments) {
        const records = await prisma.attendanceRecord.findMany({
          where: {
            studentId: enrollment.studentId,
            session: { courseId: course.id },
          },
          select: { status: true },
        });

        const total = records.length;
        const attended = records.filter(
          (r) => r.status === "present" || r.status === "late",
        ).length;
        const rate = total > 0 ? (attended / total) * 100 : 100;

        if (rate < 75 && total > 0) {
          courseAtRisk++;
          totalAtRisk++;
        }
      }

      if (courseAtRisk > 0) {
        atRiskByCourse.push({
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          atRiskCount: courseAtRisk,
        });
      }
    }

    return {
      total: totalAtRisk,
      byCourse: atRiskByCourse,
    };
  }

  /**
   * Get lecturer notifications
   */
  async getLecturerNotifications(lecturerId) {
    // Get sessions that are about to expire
    const expiringSessions = await prisma.session.findMany({
      where: {
        lecturerId,
        status: "active",
        expiresAt: { lt: new Date(Date.now() + 15 * 60 * 1000) }, // 15 minutes
      },
      include: {
        course: { select: { name: true } },
      },
    });

    return expiringSessions.map((session) => ({
      type: "warning",
      title: "Session Expiring Soon",
      message: `${session.course.name} session expires in ${Math.floor((new Date(session.expiresAt) - new Date()) / 60000)} minutes`,
      timestamp: session.expiresAt,
      read: false,
      data: { sessionId: session.id },
    }));
  }

  /**
   * Get system statistics
   */
  async getSystemStats() {
    const [
      totalUsers,
      activeUsers,
      totalSessions,
      activeSessions,
      totalAttendance,
      todayAttendance,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.session.count(),
      prisma.session.count({ where: { status: "active" } }),
      prisma.attendanceRecord.count(),
      prisma.roomCheckin.count({
        where: {
          checkedInAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
    ]);

    return {
      totalUsers,
      activeUsers,
      totalSessions,
      activeSessions,
      totalAttendanceRecords: totalAttendance,
      todayCheckins: todayAttendance,
    };
  }

  /**
   * Get user statistics
   */
  async getUserStats() {
    const [students, lecturers, admins, newUsersThisWeek] = await Promise.all([
      prisma.user.count({ where: { role: "student", isActive: true } }),
      prisma.user.count({ where: { role: "lecturer", isActive: true } }),
      prisma.user.count({ where: { role: "admin", isActive: true } }),
      prisma.user.count({
        where: {
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    return {
      students,
      lecturers,
      admins,
      total: students + lecturers + admins,
      newThisWeek: newUsersThisWeek,
    };
  }

  /**
   * Get academic statistics
   */
  async getAcademicStats() {
    const [totalCourses, activeCourses, totalClassrooms, activeClassrooms] =
      await Promise.all([
        prisma.course.count(),
        prisma.course.count({ where: { isActive: true } }),
        prisma.classroom.count(),
        prisma.classroom.count({ where: { isActive: true } }),
      ]);

    return {
      totalCourses,
      activeCourses,
      totalClassrooms,
      activeClassrooms,
    };
  }

  /**
   * Get attendance overview
   */
  async getAttendanceOverview() {
    const totalRecords = await prisma.attendanceRecord.count();
    const presentRecords = await prisma.attendanceRecord.count({
      where: { status: "present" },
    });
    const lateRecords = await prisma.attendanceRecord.count({
      where: { status: "late" },
    });
    const absentRecords = await prisma.attendanceRecord.count({
      where: { status: "absent" },
    });

    // Get last 7 days attendance
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const weeklyAttendance = await prisma.roomCheckin.groupBy({
      by: ["checkedInAt"],
      where: {
        checkedInAt: { gte: weekAgo },
      },
      _count: true,
    });

    return {
      totalRecords,
      present: presentRecords,
      late: lateRecords,
      absent: absentRecords,
      attendanceRate:
        totalRecords > 0
          ? parseFloat(
              (((presentRecords + lateRecords) / totalRecords) * 100).toFixed(
                1,
              ),
            )
          : 0,
      weeklyTrend: weeklyAttendance.length,
    };
  }

  /**
   * Get admin recent activity
   */
  async getAdminRecentActivity() {
    const recentLogs = await prisma.auditLog.findMany({
      include: {
        user: {
          select: { fullName: true, email: true, role: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return recentLogs.map((log) => ({
      type: "audit",
      action: log.action,
      user: log.user?.fullName || "System",
      role: log.user?.role,
      timestamp: log.createdAt,
      details: {
        entity: log.entity,
        entityId: log.entityId,
      },
    }));
  }

  /**
   * Get system health
   */
  async getSystemHealth() {
    let redisStatus = "disconnected";
    if (redisClient && redisClient.isReady) {
      try {
        await redisClient.ping();
        redisStatus = "connected";
      } catch (error) {
        redisStatus = "error";
      }
    }

    let dbStatus = "disconnected";
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = "connected";
    } catch (error) {
      dbStatus = "error";
    }

    return {
      database: dbStatus,
      redis: redisStatus,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date(),
    };
  }
}

module.exports = new DashboardController();
