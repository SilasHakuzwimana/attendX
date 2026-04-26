const { validationResult } = require("express-validator");
const logger = require("../utils/logger");

class AnalyticsController {
  /**
   * Course attendance summary
   * GET /api/analytics/courses/:courseId/summary
   */
  async getCourseSummary(req, res, next) {
    try {
      const { courseId } = req.params;
      const { from, to } = req.query;

      const course = await global.prisma.course.findUnique({
        where: { id: courseId },
        include: { lecturer: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Check access
      if (req.user.role !== "admin" && course.lecturerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have access to this course",
          },
        });
      }

      const whereSession = { courseId };
      if (from || to) {
        whereSession.startedAt = {};
        if (from) whereSession.startedAt.gte = new Date(from);
        if (to) whereSession.startedAt.lte = new Date(to);
      }

      const sessions = await global.prisma.session.findMany({
        where: whereSession,
        include: {
          attendanceRecords: true,
          roomCheckins: true,
        },
      });

      const totalSessions = sessions.length;
      let totalPresent = 0;
      let totalAbsent = 0;
      let totalStudents = 0;

      for (const session of sessions) {
        const present = session.attendanceRecords.filter(
          (r) => r.status === "present",
        ).length;
        const absent = session.attendanceRecords.filter(
          (r) => r.status === "absent",
        ).length;
        totalPresent += present;
        totalAbsent += absent;
        if (session.attendanceRecords.length > totalStudents) {
          totalStudents = session.attendanceRecords.length;
        }
      }

      const avgAttendanceRate =
        totalSessions > 0 && totalStudents > 0
          ? (totalPresent / (totalStudents * totalSessions)) * 100
          : 0;

      res.json({
        success: true,
        data: {
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          totalSessions,
          avgAttendanceRate: parseFloat(avgAttendanceRate.toFixed(1)),
          presentCount: totalPresent,
          absentCount: totalAbsent,
          totalEnrollments: totalStudents,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Per-student attendance breakdown
   * GET /api/analytics/courses/:courseId/students
   */
  async getStudentBreakdown(req, res, next) {
    try {
      const { courseId } = req.params;
      const {
        page = 1,
        limit = 20,
        sortBy = "attendanceRate",
        order = "desc",
      } = req.query;
      const skip = (page - 1) * limit;

      const course = await global.prisma.course.findUnique({
        where: { id: courseId },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Course not found" },
        });
      }

      // Check access
      if (req.user.role !== "admin" && course.lecturerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have access to this course",
          },
        });
      }

      const enrollments = await global.prisma.enrollment.findMany({
        where: { courseId },
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

      const sessions = await global.prisma.session.findMany({
        where: { courseId, status: "closed" },
        select: { id: true },
      });

      const totalSessions = sessions.length;
      const studentSummaries = [];

      for (const enrollment of enrollments) {
        const attendance = await global.prisma.attendanceRecord.findMany({
          where: {
            studentId: enrollment.studentId,
            session: { courseId },
          },
        });

        const present = attendance.filter((a) => a.status === "present").length;
        const absent = attendance.filter((a) => a.status === "absent").length;
        const excused = attendance.filter((a) => a.status === "excused").length;
        const late = attendance.filter((a) => a.status === "late").length;

        // Calculate consecutive absences
        let consecutiveAbsences = 0;
        const recentAttendance = await global.prisma.attendanceRecord.findMany({
          where: {
            studentId: enrollment.studentId,
            session: { courseId },
          },
          orderBy: { markedAt: "desc" },
          take: 5,
        });

        for (const record of recentAttendance) {
          if (record.status === "absent") consecutiveAbsences++;
          else break;
        }

        studentSummaries.push({
          student: enrollment.student,
          totalSessions,
          present,
          absent,
          excused,
          late,
          attendanceRate:
            totalSessions > 0 ? (present / totalSessions) * 100 : 0,
          consecutiveAbsences,
        });
      }

      // Sort
      studentSummaries.sort((a, b) => {
        let aVal = a[sortBy];
        let bVal = b[sortBy];
        if (sortBy === "fullName") {
          aVal = a.student.fullName;
          bVal = b.student.fullName;
        }
        if (order === "asc") {
          return aVal > bVal ? 1 : -1;
        } else {
          return aVal < bVal ? 1 : -1;
        }
      });

      const paginated = studentSummaries.slice(skip, skip + parseInt(limit));

      res.json({
        success: true,
        data: paginated,
        meta: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: studentSummaries.length,
          totalPages: Math.ceil(studentSummaries.length / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get at-risk students
   * GET /api/analytics/at-risk
   */
  async getAtRiskStudents(req, res, next) {
    try {
      const { courseId } = req.query;

      const systemConfig = await global.prisma.systemConfig.findUnique({
        where: { id: "singleton" },
      });
      const threshold = systemConfig?.consecutiveAbsenceWarningThreshold || 2;

      const whereCourse = {};
      if (courseId) {
        whereCourse.id = courseId;
      } else if (req.user.role === "lecturer") {
        whereCourse.lecturerId = req.user.id;
      }

      const courses = await global.prisma.course.findMany({
        where: whereCourse,
        include: {
          enrollments: {
            include: {
              student: {
                include: {
                  attendanceRecords: {
                    where: {
                      status: "absent",
                    },
                    orderBy: { markedAt: "desc" },
                  },
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

          // Count consecutive absences
          let consecutiveAbsences = 0;
          for (const record of student.attendanceRecords) {
            if (record.status === "absent") consecutiveAbsences++;
            else break;
          }

          // Calculate overall attendance rate
          const allRecords = await global.prisma.attendanceRecord.count({
            where: { studentId: student.id },
          });
          const presentRecords = await global.prisma.attendanceRecord.count({
            where: { studentId: student.id, status: "present" },
          });
          const overallRate =
            allRecords > 0 ? (presentRecords / allRecords) * 100 : 100;

          if (consecutiveAbsences >= threshold || overallRate < 75) {
            // Check if warning email was sent recently
            const warningSent = await global.redis.get(
              `warning:${student.id}:${course.id}`,
            );

            atRiskStudents.push({
              student: {
                id: student.id,
                fullName: student.fullName,
                email: student.email,
                regNumber: student.regNumber,
              },
              courseName: course.name,
              consecutiveAbsences,
              overallRate: parseFloat(overallRate.toFixed(1)),
              warningEmailSentAt: warningSent
                ? new Date(parseInt(warningSent))
                : null,
            });
          }
        }
      }

      res.json({ success: true, data: atRiskStudents });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Lecturer dashboard analytics
   * GET /api/analytics/lecturer/dashboard
   */
  async getLecturerDashboard(req, res, next) {
    try {
      const courses = await global.prisma.course.findMany({
        where: { lecturerId: req.user.id, isActive: true },
        include: {
          sessions: {
            where: { status: "closed" },
            include: { attendanceRecords: true },
          },
          enrollments: true,
        },
      });

      let totalCourses = courses.length;
      let totalSessions = 0;
      let totalPresent = 0;
      let totalPossible = 0;
      const courseSummaries = [];

      for (const course of courses) {
        let coursePresent = 0;
        let coursePossible = 0;

        for (const session of course.sessions) {
          totalSessions++;
          const present = session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length;
          const possible = session.attendanceRecords.length;
          coursePresent += present;
          coursePossible += possible;
          totalPresent += present;
          totalPossible += possible;
        }

        const avgRate =
          coursePossible > 0 ? (coursePresent / coursePossible) * 100 : 0;

        courseSummaries.push({
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          totalSessions: course.sessions.length,
          totalEnrollments: course.enrollments.length,
          avgAttendanceRate: parseFloat(avgRate.toFixed(1)),
          presentCount: coursePresent,
          absentCount: coursePossible - coursePresent,
        });
      }

      const avgAttendanceRate =
        totalPossible > 0 ? (totalPresent / totalPossible) * 100 : 0;

      // Get at-risk count
      const atRiskCount = await this.getAtRiskCount();

      res.json({
        success: true,
        data: {
          totalCourses,
          totalSessions,
          avgAttendanceRate: parseFloat(avgAttendanceRate.toFixed(1)),
          atRiskCount,
          courseSummaries,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Admin system overview
   * GET /api/analytics/admin/overview
   */
  async getAdminOverview(req, res, next) {
    try {
      const [
        totalStudents,
        totalLecturers,
        totalCourses,
        totalSessions,
        totalAttendance,
      ] = await Promise.all([
        global.prisma.user.count({
          where: { role: "student", isActive: true },
        }),
        global.prisma.user.count({
          where: { role: "lecturer", isActive: true },
        }),
        global.prisma.course.count({ where: { isActive: true } }),
        global.prisma.session.count(),
        global.prisma.attendanceRecord.count(),
      ]);

      const presentRecords = await global.prisma.attendanceRecord.count({
        where: { status: "present" },
      });

      const systemAvgAttendanceRate =
        totalAttendance > 0 ? (presentRecords / totalAttendance) * 100 : 0;

      // Get at-risk students across all courses
      const atRiskStudents = await this.getAtRiskStudentsCount();

      // Get today's active sessions
      const activeSessions = await global.prisma.session.count({
        where: {
          status: "active",
          checkinOpen: true,
        },
      });

      res.json({
        success: true,
        data: {
          totalStudents,
          totalLecturers,
          totalCourses,
          totalSessions,
          totalAttendanceRecords: totalAttendance,
          systemAvgAttendanceRate: parseFloat(
            systemAvgAttendanceRate.toFixed(1),
          ),
          atRiskStudents,
          activeSessions,
          lastUpdated: new Date(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // Helper methods
  async getAtRiskCount() {
    const systemConfig = await global.prisma.systemConfig.findUnique({
      where: { id: "singleton" },
    });
    const threshold = systemConfig?.consecutiveAbsenceWarningThreshold || 2;

    const students = await global.prisma.user.findMany({
      where: { role: "student", isActive: true },
      include: {
        attendanceRecords: {
          orderBy: { markedAt: "desc" },
          take: threshold,
        },
      },
    });

    let atRisk = 0;
    for (const student of students) {
      const consecutiveAbsences = student.attendanceRecords.filter(
        (r) => r.status === "absent",
      ).length;
      if (consecutiveAbsences >= threshold) atRisk++;
    }

    return atRisk;
  }

  async getAtRiskStudentsCount() {
    const atRiskList = await this.getAtRiskStudents({ query: {} });
    return atRiskList.data.length;
  }
}

module.exports = new AnalyticsController();
