const { validationResult } = require("express-validator");
const logger = require("../utils/logger");

class StudentController {
  /**
   * Student dashboard summary
   * GET /api/students/dashboard
   */
  async getDashboard(req, res, next) {
    try {
      const studentId = req.user.id;

      // Get student profile with enrolled courses count
      const student = await global.prisma.user.findUnique({
        where: { id: studentId },
        include: {
          enrollments: {
            where: { course: { isActive: true } },
          },
        },
      });

      if (!student) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Student not found" },
        });
      }

      // Get today's active sessions
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todaySessions = await global.prisma.session.findMany({
        where: {
          courseId: { in: student.enrollments.map((e) => e.courseId) },
          status: "active",
          checkinOpen: true,
          startedAt: { gte: today, lt: tomorrow },
        },
        include: {
          course: true,
          classroom: true,
          lecturer: {
            select: { id: true, fullName: true, email: true },
          },
        },
      });

      // Calculate overall attendance rate
      const attendanceRecords = await global.prisma.attendanceRecord.findMany({
        where: { studentId },
        select: { status: true },
      });

      const totalRecords = attendanceRecords.length;
      const presentRecords = attendanceRecords.filter(
        (r) => r.status === "present",
      ).length;
      const overallAttendanceRate =
        totalRecords > 0 ? (presentRecords / totalRecords) * 100 : 0;

      // Get recent attendance (last 5)
      const recentAttendance = await global.prisma.attendanceRecord.findMany({
        where: { studentId },
        include: {
          session: {
            include: {
              course: true,
              classroom: true,
            },
          },
        },
        orderBy: { markedAt: "desc" },
        take: 5,
      });

      res.json({
        success: true,
        data: {
          profile: {
            id: student.id,
            fullName: student.fullName,
            email: student.email,
            role: student.role,
            regNumber: student.regNumber,
            enrolledCourses: student.enrollments.length,
            attendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
          },
          overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
          todaySessions,
          recentAttendance,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Student attendance history
   * GET /api/students/attendance/history
   */
  async getAttendanceHistory(req, res, next) {
    try {
      const { page = 1, limit = 20, courseId, from, to } = req.query;
      const skip = (page - 1) * limit;

      const where = { studentId: req.user.id };

      if (courseId) where.session = { courseId };
      if (from || to) {
        where.markedAt = {};
        if (from) where.markedAt.gte = new Date(from);
        if (to) where.markedAt.lte = new Date(to);
      }

      const [records, total] = await Promise.all([
        global.prisma.attendanceRecord.findMany({
          where,
          include: {
            session: {
              include: {
                course: true,
                classroom: true,
                lecturer: {
                  select: { id: true, fullName: true },
                },
              },
            },
          },
          orderBy: { markedAt: "desc" },
          skip: parseInt(skip),
          take: parseInt(limit),
        }),
        global.prisma.attendanceRecord.count({ where }),
      ]);

      res.json({
        success: true,
        data: records,
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
   * Attendance trends for charts
   * GET /api/students/attendance/trends
   */
  async getAttendanceTrends(req, res, next) {
    try {
      const { courseId, weeks = 8 } = req.query;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - weeks * 7);

      const where = {
        studentId: req.user.id,
        markedAt: { gte: startDate },
      };

      if (courseId) {
        where.session = { courseId };
      }

      const records = await global.prisma.attendanceRecord.findMany({
        where,
        include: {
          session: {
            include: { course: true },
          },
        },
        orderBy: { markedAt: "asc" },
      });

      // Format data for charts
      const trends = records.map((record) => ({
        sessionDate: record.markedAt.toISOString().split("T")[0],
        status: record.status,
        courseName: record.session.course.name,
        courseCode: record.session.course.code,
      }));

      res.json({ success: true, data: trends });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List enrolled courses
   * GET /api/students/courses
   */
  async getEnrolledCourses(req, res, next) {
    try {
      const enrollments = await global.prisma.enrollment.findMany({
        where: { studentId: req.user.id },
        include: {
          course: {
            include: {
              lecturer: {
                select: { id: true, fullName: true, email: true },
              },
            },
          },
        },
        orderBy: { enrolledAt: "desc" },
      });

      const courses = enrollments.map((e) => e.course);

      res.json({ success: true, data: courses });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get active sessions for enrolled courses
   * GET /api/students/sessions/active
   */
  async getActiveSessions(req, res, next) {
    try {
      // Get student's enrolled courses
      const enrollments = await global.prisma.enrollment.findMany({
        where: { studentId: req.user.id },
        select: { courseId: true },
      });

      const courseIds = enrollments.map((e) => e.courseId);

      if (courseIds.length === 0) {
        return res.json({ success: true, data: [] });
      }

      // Get active sessions
      const sessions = await global.prisma.session.findMany({
        where: {
          courseId: { in: courseIds },
          status: "active",
          checkinOpen: true,
          expiresAt: { gt: new Date() },
        },
        include: {
          course: true,
          classroom: true,
          lecturer: {
            select: { id: true, fullName: true },
          },
        },
        orderBy: { startedAt: "desc" },
      });

      // Check if student already checked in
      const sessionsWithStatus = await Promise.all(
        sessions.map(async (session) => {
          const checkin = await global.prisma.roomCheckin.findUnique({
            where: {
              sessionId_studentId: {
                sessionId: session.id,
                studentId: req.user.id,
              },
            },
          });

          return {
            ...session,
            hasCheckedIn: !!checkin,
            checkedInAt: checkin?.checkedInAt || null,
          };
        }),
      );

      res.json({ success: true, data: sessionsWithStatus });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new StudentController();
