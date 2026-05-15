const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const { sendEmail } = require("../services/email.service");

class ReportController {
  /**
   * Generate attendance report for a course
   * GET /api/v1/reports/course-attendance
   */
  async generateCourseAttendanceReport(req, res, next) {
    try {
      const {
        courseId,
        from,
        to,
        format = "json",
        includeStudents = true,
      } = req.query;

      // Verify access
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

      // Build date filter
      const dateFilter = {};
      if (from) dateFilter.gte = new Date(from);
      if (to) dateFilter.lte = new Date(to);

      const whereSession = { courseId, status: "closed" };
      if (from || to) whereSession.startedAt = dateFilter;

      // Get sessions
      const sessions = await prisma.session.findMany({
        where: whereSession,
        include: {
          classroom: true,
          attendanceRecords:
            includeStudents === "true"
              ? {
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
                }
              : true,
          roomCheckins: true,
        },
        orderBy: { startedAt: "asc" },
      });

      // Get enrolled students
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

      // Calculate statistics
      let totalPresent = 0;
      let totalLate = 0;
      let totalAbsent = 0;
      let totalExcused = 0;

      for (const session of sessions) {
        totalPresent += session.attendanceRecords.filter(
          (r) => r.status === "present",
        ).length;
        totalLate += session.attendanceRecords.filter(
          (r) => r.status === "late",
        ).length;
        totalAbsent += session.attendanceRecords.filter(
          (r) => r.status === "absent",
        ).length;
        totalExcused += session.attendanceRecords.filter(
          (r) => r.status === "excused",
        ).length;
      }

      const totalRecords =
        totalPresent + totalLate + totalAbsent + totalExcused;
      const attendanceRate =
        totalRecords > 0
          ? ((totalPresent + totalLate) / totalRecords) * 100
          : 0;

      // Prepare report data
      const reportData = {
        reportType: "course_attendance",
        generatedAt: new Date(),
        generatedBy: {
          id: req.user.id,
          name: req.user.fullName,
          role: req.user.role,
        },
        course: {
          id: course.id,
          code: course.code,
          name: course.name,
          credits: course.credits,
          semester: course.semester,
          academicYear: course.academicYear,
          lecturer: course.lecturer,
        },
        dateRange: {
          from: from || sessions[0]?.startedAt || null,
          to: to || sessions[sessions.length - 1]?.startedAt || null,
        },
        summary: {
          totalSessions: sessions.length,
          totalStudents: enrollments.length,
          totalPresent,
          totalLate,
          totalAbsent,
          totalExcused,
          totalRecords,
          attendanceRate: parseFloat(attendanceRate.toFixed(1)),
          averagePerSession:
            sessions.length > 0
              ? parseFloat((totalRecords / sessions.length).toFixed(1))
              : 0,
        },
        sessions: sessions.map((session) => ({
          id: session.id,
          sessionCode: session.sessionCode,
          date: session.startedAt,
          startTime: session.startedAt,
          endTime: session.expiresAt,
          classroom: session.classroom?.name,
          present: session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length,
          late: session.attendanceRecords.filter((r) => r.status === "late")
            .length,
          absent: session.attendanceRecords.filter((r) => r.status === "absent")
            .length,
          excused: session.attendanceRecords.filter(
            (r) => r.status === "excused",
          ).length,
          checkins: session.roomCheckins.length,
        })),
        students:
          includeStudents === "true"
            ? await this.getStudentAttendanceDetails(
                courseId,
                enrollments,
                sessions,
              )
            : [],
      };

      // Generate different formats
      if (format === "csv") {
        return this.exportToCSV(reportData, res);
      } else if (format === "pdf") {
        return this.exportToPDF(reportData, res);
      } else {
        res.json({ success: true, data: reportData });
      }
    } catch (error) {
      logger.error("Generate course attendance report error:", error);
      next(error);
    }
  }

  /**
   * Generate student attendance report
   * GET /api/v1/reports/student-attendance
   */
  async generateStudentAttendanceReport(req, res, next) {
    try {
      const { studentId, courseId, from, to, format = "json" } = req.query;

      const targetStudentId = studentId || req.user.id;

      // Check permission
      if (req.user.role === "student" && req.user.id !== targetStudentId) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only view your own report",
          },
        });
      }

      // Get student details
      const student = await prisma.user.findFirst({
        where: { id: targetStudentId, role: "student", isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          regNumber: true,
          phone: true,
          createdAt: true,
        },
      });

      if (!student) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Student not found" },
        });
      }

      // Build where clause for sessions
      const sessionWhere = { status: "closed" };
      if (courseId) sessionWhere.courseId = courseId;
      if (from || to) {
        sessionWhere.startedAt = {};
        if (from) sessionWhere.startedAt.gte = new Date(from);
        if (to) sessionWhere.startedAt.lte = new Date(to);
      }

      // Get attendance records
      const attendanceRecords = await prisma.attendanceRecord.findMany({
        where: {
          studentId: targetStudentId,
          session: sessionWhere,
        },
        include: {
          session: {
            include: {
              course: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  credits: true,
                },
              },
              classroom: true,
            },
          },
        },
        orderBy: { markedAt: "desc" },
      });

      // Calculate statistics
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
      const attended = presentCount + lateCount;
      const attendanceRate =
        totalSessions > 0 ? (attended / totalSessions) * 100 : 100;

      // Group by course
      const byCourse = {};
      for (const record of attendanceRecords) {
        const courseIdKey = record.session.course.id;
        if (!byCourse[courseIdKey]) {
          byCourse[courseIdKey] = {
            course: record.session.course,
            present: 0,
            late: 0,
            absent: 0,
            excused: 0,
            total: 0,
          };
        }
        byCourse[courseIdKey][record.status]++;
        byCourse[courseIdKey].total++;
      }

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

      const reportData = {
        reportType: "student_attendance",
        generatedAt: new Date(),
        generatedBy: {
          id: req.user.id,
          name: req.user.fullName,
          role: req.user.role,
        },
        student,
        dateRange: {
          from: from || null,
          to: to || null,
          courseId: courseId || null,
        },
        summary: {
          totalSessions,
          present: presentCount,
          late: lateCount,
          absent: absentCount,
          excused: excusedCount,
          attended,
          attendanceRate: parseFloat(attendanceRate.toFixed(1)),
          currentStreak,
          longestStreak,
        },
        byCourse: Object.values(byCourse).map((c) => ({
          ...c,
          attendanceRate:
            c.total > 0
              ? parseFloat((((c.present + c.late) / c.total) * 100).toFixed(1))
              : 0,
        })),
        attendanceHistory: attendanceRecords.map((record) => ({
          date: record.markedAt,
          status: record.status,
          sessionCode: record.session.sessionCode,
          courseName: record.session.course.name,
          courseCode: record.session.course.code,
          classroom: record.session.classroom?.name,
          distanceM: record.distanceM,
          submissionMethod: record.submissionMethod,
          notes: record.notes,
        })),
      };

      if (format === "csv") {
        return this.exportToCSV(reportData, res);
      } else if (format === "pdf") {
        return this.exportToPDF(reportData, res);
      } else {
        res.json({ success: true, data: reportData });
      }
    } catch (error) {
      logger.error("Generate student attendance report error:", error);
      next(error);
    }
  }

  /**
   * Generate lecturer summary report
   * GET /api/v1/reports/lecturer-summary
   */
  async generateLecturerSummaryReport(req, res, next) {
    try {
      const { lecturerId, from, to, format = "json" } = req.query;

      const targetLecturerId = lecturerId || req.user.id;

      // Check permission
      if (req.user.role === "lecturer" && req.user.id !== targetLecturerId) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only view your own report",
          },
        });
      }

      // Get lecturer details
      const lecturer = await prisma.user.findFirst({
        where: { id: targetLecturerId, role: "lecturer", isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          staffNumber: true,
          phone: true,
        },
      });

      if (!lecturer) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Lecturer not found" },
        });
      }

      // Get courses
      const courses = await prisma.course.findMany({
        where: { lecturerId: targetLecturerId, isActive: true },
        include: {
          enrollments: {
            where: { isActive: true },
            select: { id: true },
          },
          sessions: {
            where:
              from || to
                ? {
                    startedAt: {
                      ...(from && { gte: new Date(from) }),
                      ...(to && { lte: new Date(to) }),
                    },
                  }
                : {},
            include: {
              attendanceRecords: true,
            },
          },
        },
      });

      let totalStudents = 0;
      let totalSessions = 0;
      let totalPresent = 0;
      let totalLate = 0;
      let totalAbsent = 0;
      let totalPossible = 0;

      const courseSummaries = [];

      for (const course of courses) {
        const enrolledCount = course.enrollments.length;
        totalStudents += enrolledCount;

        let coursePresent = 0;
        let courseLate = 0;
        let courseAbsent = 0;
        let coursePossible = 0;
        const courseSessions = course.sessions.length;
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
          totalPossible += session.attendanceRecords.length;
        }

        courseSummaries.push({
          courseId: course.id,
          courseCode: course.code,
          courseName: course.name,
          enrolledCount,
          sessions: courseSessions,
          present: coursePresent,
          late: courseLate,
          absent: courseAbsent,
          attendanceRate:
            coursePossible > 0
              ? parseFloat(
                  (
                    ((coursePresent + courseLate) / coursePossible) *
                    100
                  ).toFixed(1),
                )
              : 0,
        });
      }

      const overallAttendanceRate =
        totalPossible > 0
          ? ((totalPresent + totalLate) / totalPossible) * 100
          : 0;

      const reportData = {
        reportType: "lecturer_summary",
        generatedAt: new Date(),
        generatedBy: {
          id: req.user.id,
          name: req.user.fullName,
          role: req.user.role,
        },
        lecturer,
        dateRange: {
          from: from || null,
          to: to || null,
        },
        summary: {
          totalCourses: courses.length,
          totalStudents,
          totalSessions,
          totalPresent,
          totalLate,
          totalAbsent,
          totalRecords: totalPossible,
          overallAttendanceRate: parseFloat(overallAttendanceRate.toFixed(1)),
          averagePerCourse:
            courses.length > 0
              ? parseFloat((totalSessions / courses.length).toFixed(1))
              : 0,
        },
        courseSummaries,
      };

      if (format === "csv") {
        return this.exportToCSV(reportData, res);
      } else if (format === "pdf") {
        return this.exportToPDF(reportData, res);
      } else {
        res.json({ success: true, data: reportData });
      }
    } catch (error) {
      logger.error("Generate lecturer summary report error:", error);
      next(error);
    }
  }

  /**
   * Generate system analytics report (Admin only)
   * GET /api/v1/reports/system-analytics
   */
  async generateSystemAnalyticsReport(req, res, next) {
    try {
      const { from, to, period = "monthly", format = "json" } = req.query;

      const startDate = from ? new Date(from) : new Date();
      startDate.setMonth(startDate.getMonth() - 6);
      const endDate = to ? new Date(to) : new Date();

      // Get user statistics over time
      const userStats = await prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', created_at) as period,
          COUNT(*) as total_users,
          COUNT(CASE WHEN role = 'student' THEN 1 END) as students,
          COUNT(CASE WHEN role = 'lecturer' THEN 1 END) as lecturers
        FROM users
        WHERE created_at BETWEEN ${startDate} AND ${endDate}
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY period ASC
      `;

      // Get session statistics
      const sessionStats = await prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', started_at) as period,
          COUNT(*) as total_sessions,
          AVG(checkins_count) as avg_checkins,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_sessions
        FROM sessions
        WHERE started_at BETWEEN ${startDate} AND ${endDate}
        GROUP BY DATE_TRUNC('month', started_at)
        ORDER BY period ASC
      `;

      // Get attendance statistics
      const attendanceStats = await prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', marked_at) as period,
          COUNT(*) as total_records,
          COUNT(CASE WHEN status = 'present' THEN 1 END) as present,
          COUNT(CASE WHEN status = 'late' THEN 1 END) as late,
          COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent,
          COUNT(CASE WHEN status = 'excused' THEN 1 END) as excused
        FROM attendance_records
        WHERE marked_at BETWEEN ${startDate} AND ${endDate}
        GROUP BY DATE_TRUNC('month', marked_at)
        ORDER BY period ASC
      `;

      // Get course statistics
      const courseStats = await prisma.$queryRaw`
        SELECT 
          COUNT(*) as total_courses,
          SUM(credits) as total_credits,
          AVG(CASE WHEN is_active = true THEN 1 ELSE 0 END) * 100 as active_rate
        FROM courses
        WHERE created_at BETWEEN ${startDate} AND ${endDate}
      `;

      const reportData = {
        reportType: "system_analytics",
        generatedAt: new Date(),
        generatedBy: {
          id: req.user.id,
          name: req.user.fullName,
          role: req.user.role,
        },
        dateRange: {
          from: startDate,
          to: endDate,
          period,
        },
        userGrowth: userStats,
        sessionTrends: sessionStats,
        attendanceTrends: attendanceStats,
        courseStatistics: courseStats[0],
        summary: {
          totalUsers: userStats.reduce(
            (sum, u) => sum + parseInt(u.total_users),
            0,
          ),
          totalSessions: sessionStats.reduce(
            (sum, s) => sum + parseInt(s.total_sessions),
            0,
          ),
          totalAttendance: attendanceStats.reduce(
            (sum, a) => sum + parseInt(a.total_records),
            0,
          ),
          averageAttendanceRate:
            attendanceStats.length > 0
              ? parseFloat(
                  (
                    attendanceStats.reduce(
                      (sum, a) =>
                        sum +
                        ((parseInt(a.present) + parseInt(a.late)) /
                          parseInt(a.total_records)) *
                          100,
                      0,
                    ) / attendanceStats.length
                  ).toFixed(1),
                )
              : 0,
        },
      };

      if (format === "csv") {
        return this.exportToCSV(reportData, res);
      } else if (format === "pdf") {
        return this.exportToPDF(reportData, res);
      } else {
        res.json({ success: true, data: reportData });
      }
    } catch (error) {
      logger.error("Generate system analytics report error:", error);
      next(error);
    }
  }

  /**
   * Generate at-risk students report
   * GET /api/v1/reports/at-risk-students
   */
  async generateAtRiskReport(req, res, next) {
    try {
      const {
        courseId,
        threshold = 75,
        consecutiveAbsences = 2,
        format = "json",
      } = req.query;

      // Build course filter
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
          const records = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
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

          const isLowAttendance = attendanceRate < parseFloat(threshold);
          const hasConsecutiveAbsences =
            consecutiveAbsenceCount >= parseInt(consecutiveAbsences);

          if (
            (isLowAttendance || hasConsecutiveAbsences) &&
            totalSessions > 0
          ) {
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
                consecutiveAbsences: consecutiveAbsenceCount,
                missedSessions: totalSessions - attended,
              },
              riskFactors: {
                lowAttendance: isLowAttendance,
                consecutiveAbsences: hasConsecutiveAbsences,
              },
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

      const reportData = {
        reportType: "at_risk_students",
        generatedAt: new Date(),
        generatedBy: {
          id: req.user.id,
          name: req.user.fullName,
          role: req.user.role,
        },
        criteria: {
          attendanceThreshold: parseFloat(threshold),
          consecutiveAbsencesThreshold: parseInt(consecutiveAbsences),
        },
        summary: {
          totalAtRisk: atRiskStudents.length,
          criticalCount: atRiskStudents.filter(
            (s) => s.riskLevel === "critical",
          ).length,
          warningCount: atRiskStudents.filter((s) => s.riskLevel === "warning")
            .length,
          affectedCourses: new Set(atRiskStudents.map((s) => s.course.id)).size,
        },
        students: atRiskStudents,
      };

      if (format === "csv") {
        return this.exportToCSV(reportData, res);
      } else if (format === "pdf") {
        return this.exportToPDF(reportData, res);
      } else {
        res.json({ success: true, data: reportData });
      }
    } catch (error) {
      logger.error("Generate at-risk report error:", error);
      next(error);
    }
  }

  /**
   * Export report as CSV
   */
  async exportToCSV(reportData, res) {
    try {
      let csvRows = [];
      const filename = `${reportData.reportType}_${Date.now()}.csv`;

      switch (reportData.reportType) {
        case "course_attendance":
          csvRows = this.formatCourseAttendanceCSV(reportData);
          break;
        case "student_attendance":
          csvRows = this.formatStudentAttendanceCSV(reportData);
          break;
        case "lecturer_summary":
          csvRows = this.formatLecturerSummaryCSV(reportData);
          break;
        case "at_risk_students":
          csvRows = this.formatAtRiskCSV(reportData);
          break;
        default:
          csvRows = [["Report Data", JSON.stringify(reportData)]];
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
      res.send(csvContent);
    } catch (error) {
      logger.error("Export to CSV error:", error);
      res.status(500).json({
        success: false,
        error: { code: "EXPORT_ERROR", message: "Failed to export report" },
      });
    }
  }

  /**
   * Export PDF report
   */
  async exportToPDF(reportData, res) {
    try {
      const doc = new PDFDocument({
        margin: 50,
        size: "A4",
        layout: "portrait",
      });

      const filename = `${reportData.reportType}_${Date.now()}.pdf`;

      // Set response headers
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

      // Pipe PDF to response
      doc.pipe(res);

      // Generate PDF based on report type
      switch (reportData.reportType) {
        case "course_attendance":
          await this.generateCourseAttendancePDF(doc, reportData);
          break;
        case "student_attendance":
          await this.generateStudentAttendancePDF(doc, reportData);
          break;
        case "lecturer_summary":
          await this.generateLecturerSummaryPDF(doc, reportData);
          break;
        case "at_risk_students":
          await this.generateAtRiskPDF(doc, reportData);
          break;
        case "system_analytics":
          await this.generateSystemAnalyticsPDF(doc, reportData);
          break;
        default:
          await this.generateGenericPDF(doc, reportData);
      }

      // Finalize PDF
      doc.end();
    } catch (error) {
      logger.error("Export to PDF error:", error);
      res.status(500).json({
        success: false,
        error: { code: "EXPORT_ERROR", message: "Failed to export PDF" },
      });
    }
  }

  /**
   * Generate Course Attendance PDF
   */
  async generateCourseAttendancePDF(doc, data) {
    // Header with logo and title
    this.addHeader(doc, "Course Attendance Report");

    // Report metadata
    this.addMetadata(doc, data);

    // Course Information
    this.addSectionTitle(doc, "Course Information");
    doc
      .fontSize(10)
      .text(`Course Name: ${data.course.name}`, { continued: true })
      .text(`  Code: ${data.course.code}`, { align: "right" })
      .moveDown(0.5)
      .text(`Lecturer: ${data.course.lecturer?.fullName || "N/A"}`, {
        continued: true,
      })
      .text(`  Semester: ${data.course.semester || "N/A"}`, { align: "right" })
      .moveDown(1);

    // Summary Statistics
    this.addSectionTitle(doc, "Summary Statistics");
    this.addStatsGrid(doc, [
      { label: "Total Sessions", value: data.summary.totalSessions },
      { label: "Total Students", value: data.summary.totalStudents },
      { label: "Present", value: data.summary.totalPresent },
      { label: "Late", value: data.summary.totalLate },
      { label: "Absent", value: data.summary.totalAbsent },
      { label: "Excused", value: data.summary.totalExcused },
      { label: "Attendance Rate", value: `${data.summary.attendanceRate}%` },
      { label: "Average/Session", value: data.summary.averagePerSession },
    ]);

    // Session Breakdown Table
    this.addSectionTitle(doc, "Session Breakdown");
    this.addTable(
      doc,
      [
        { label: "Session Code", width: 100 },
        { label: "Date", width: 80 },
        { label: "Classroom", width: 100 },
        { label: "Present", width: 60, align: "center" },
        { label: "Late", width: 60, align: "center" },
        { label: "Absent", width: 60, align: "center" },
        { label: "Rate", width: 70, align: "center" },
      ],
      data.sessions.map((session) => [
        session.sessionCode,
        new Date(session.date).toLocaleDateString(),
        session.classroom || "N/A",
        session.present.toString(),
        session.late.toString(),
        session.absent.toString(),
        `${session.attendanceRate || 0}%`,
      ]),
    );

    // Student Details (if included)
    if (data.students && data.students.length > 0) {
      this.addSectionTitle(doc, "Student Performance");
      this.addTable(
        doc,
        [
          { label: "Student Name", width: 120 },
          { label: "Reg Number", width: 80 },
          { label: "Present", width: 60, align: "center" },
          { label: "Late", width: 60, align: "center" },
          { label: "Absent", width: 60, align: "center" },
          { label: "Rate", width: 70, align: "center" },
        ],
        data.students
          .slice(0, 20)
          .map((student) => [
            student.name.length > 25
              ? student.name.substring(0, 22) + "..."
              : student.name,
            student.regNumber || "N/A",
            student.present.toString(),
            student.late.toString(),
            student.absent.toString(),
            `${student.attendanceRate}%`,
          ]),
      );

      if (data.students.length > 20) {
        doc
          .fontSize(9)
          .text(`* Showing first 20 of ${data.students.length} students`, {
            align: "center",
            color: "gray",
          });
      }
    }

    // Footer
    this.addFooter(doc);
  }

  /**
   * Generate Student Attendance PDF
   */
  async generateStudentAttendancePDF(doc, data) {
    // Header
    this.addHeader(doc, "Student Attendance Report");

    // Metadata
    this.addMetadata(doc, data);

    // Student Information
    this.addSectionTitle(doc, "Student Information");
    doc
      .fontSize(10)
      .text(`Name: ${data.student.fullName}`)
      .text(`Registration Number: ${data.student.regNumber || "N/A"}`)
      .text(`Email: ${data.student.email}`)
      .text(`Phone: ${data.student.phone || "N/A"}`)
      .moveDown(1);

    // Summary Statistics
    this.addSectionTitle(doc, "Attendance Summary");
    this.addStatsGrid(doc, [
      { label: "Total Sessions", value: data.summary.totalSessions },
      { label: "Present", value: data.summary.present },
      { label: "Late", value: data.summary.late },
      { label: "Absent", value: data.summary.absent },
      { label: "Excused", value: data.summary.excused },
      { label: "Attendance Rate", value: `${data.summary.attendanceRate}%` },
      { label: "Current Streak", value: data.summary.currentStreak },
      { label: "Longest Streak", value: data.summary.longestStreak },
    ]);

    // Course Breakdown
    this.addSectionTitle(doc, "Course Breakdown");
    this.addTable(
      doc,
      [
        { label: "Course Code", width: 100 },
        { label: "Course Name", width: 150 },
        { label: "Present", width: 60, align: "center" },
        { label: "Late", width: 60, align: "center" },
        { label: "Absent", width: 60, align: "center" },
        { label: "Rate", width: 70, align: "center" },
      ],
      data.byCourse.map((course) => [
        course.course.code,
        course.course.name.length > 25
          ? course.course.name.substring(0, 22) + "..."
          : course.course.name,
        course.present.toString(),
        course.late.toString(),
        course.absent.toString(),
        `${course.attendanceRate}%`,
      ]),
    );

    // Attendance History
    this.addSectionTitle(doc, "Attendance History");
    this.addTable(
      doc,
      [
        { label: "Date", width: 80 },
        { label: "Course", width: 80 },
        { label: "Session", width: 70 },
        { label: "Status", width: 70, align: "center" },
        { label: "Classroom", width: 100 },
      ],
      data.attendanceHistory
        .slice(0, 30)
        .map((record) => [
          new Date(record.date).toLocaleDateString(),
          record.courseCode,
          record.sessionCode,
          record.status.toUpperCase(),
          record.classroom || "N/A",
        ]),
    );

    if (data.attendanceHistory.length > 30) {
      doc
        .fontSize(9)
        .text(`* Showing last 30 of ${data.attendanceHistory.length} records`, {
          align: "center",
          color: "gray",
        });
    }

    this.addFooter(doc);
  }

  /**
   * Generate Lecturer Summary PDF
   */
  async generateLecturerSummaryPDF(doc, data) {
    // Header
    this.addHeader(doc, "Lecturer Summary Report");

    // Metadata
    this.addMetadata(doc, data);

    // Lecturer Information
    this.addSectionTitle(doc, "Lecturer Information");
    doc
      .fontSize(10)
      .text(`Name: ${data.lecturer.fullName}`)
      .text(`Staff Number: ${data.lecturer.staffNumber || "N/A"}`)
      .text(`Email: ${data.lecturer.email}`)
      .moveDown(1);

    // Summary Statistics
    this.addSectionTitle(doc, "Overall Statistics");
    this.addStatsGrid(doc, [
      { label: "Total Courses", value: data.summary.totalCourses },
      { label: "Total Students", value: data.summary.totalStudents },
      { label: "Total Sessions", value: data.summary.totalSessions },
      { label: "Present", value: data.summary.totalPresent },
      { label: "Late", value: data.summary.totalLate },
      { label: "Absent", value: data.summary.totalAbsent },
      {
        label: "Overall Rate",
        value: `${data.summary.overallAttendanceRate}%`,
      },
      { label: "Avg/Course", value: data.summary.averagePerCourse },
    ]);

    // Course Breakdown
    this.addSectionTitle(doc, "Course Performance");
    this.addTable(
      doc,
      [
        { label: "Course Code", width: 80 },
        { label: "Course Name", width: 120 },
        { label: "Students", width: 60, align: "center" },
        { label: "Sessions", width: 60, align: "center" },
        { label: "Present", width: 60, align: "center" },
        { label: "Rate", width: 70, align: "center" },
      ],
      data.courseSummaries.map((course) => [
        course.courseCode,
        course.courseName.length > 20
          ? course.courseName.substring(0, 17) + "..."
          : course.courseName,
        course.enrolledCount.toString(),
        course.sessions.toString(),
        course.present.toString(),
        `${course.attendanceRate}%`,
      ]),
    );

    // Performance Chart (ASCII representation)
    this.addSectionTitle(doc, "Performance Overview");
    this.addBarChart(
      doc,
      data.courseSummaries.map((c) => ({
        label: c.courseCode,
        value: c.attendanceRate,
      })),
      300,
      150,
    );

    this.addFooter(doc);
  }

  /**
   * Generate At-Risk Students PDF
   */
  async generateAtRiskPDF(doc, data) {
    // Header
    this.addHeader(doc, "At-Risk Students Report");

    // Metadata
    this.addMetadata(doc, data);

    // Criteria Information
    this.addSectionTitle(doc, "Report Criteria");
    doc
      .fontSize(10)
      .text(`Attendance Threshold: ${data.criteria.attendanceThreshold}%`)
      .text(
        `Consecutive Absences Threshold: ${data.criteria.consecutiveAbsencesThreshold}`,
      )
      .moveDown(1);

    // Summary Statistics
    this.addSectionTitle(doc, "Summary");
    this.addStatsGrid(doc, [
      { label: "Total At-Risk Students", value: data.summary.totalAtRisk },
      { label: "Critical (Below 50%)", value: data.summary.criticalCount },
      { label: "Warning (50-75%)", value: data.summary.warningCount },
      { label: "Affected Courses", value: data.summary.affectedCourses },
    ]);

    // At-Risk Students List
    if (data.students && data.students.length > 0) {
      this.addSectionTitle(doc, "At-Risk Students");
      this.addTable(
        doc,
        [
          { label: "Student Name", width: 120 },
          { label: "Reg Number", width: 80 },
          { label: "Course", width: 100 },
          { label: "Attendance", width: 70, align: "center" },
          { label: "Consecutive\nAbsences", width: 60, align: "center" },
          { label: "Risk Level", width: 70, align: "center" },
        ],
        data.students.map((student) => [
          student.student.fullName.length > 25
            ? student.student.fullName.substring(0, 22) + "..."
            : student.student.fullName,
          student.student.regNumber || "N/A",
          student.course.code,
          `${student.statistics.attendanceRate}%`,
          student.statistics.consecutiveAbsences.toString(),
          student.riskLevel.toUpperCase(),
        ]),
      );
    }

    // Recommendations
    this.addSectionTitle(doc, "Recommendations");
    doc
      .fontSize(10)
      .text("1. Schedule parent-teacher conferences for critical students", {
        indent: 10,
      })
      .text("2. Send attendance warning notices", { indent: 10 })
      .text("3. Offer additional support sessions", { indent: 10 })
      .text("4. Monitor progress weekly", { indent: 10 })
      .moveDown(1);

    this.addFooter(doc);
  }

  /**
   * Generate System Analytics PDF
   */
  async generateSystemAnalyticsPDF(doc, data) {
    // Header
    this.addHeader(doc, "System Analytics Report");

    // Metadata
    this.addMetadata(doc, data);

    // Summary Statistics
    this.addSectionTitle(doc, "System Overview");
    this.addStatsGrid(doc, [
      { label: "Total Users", value: data.summary.totalUsers },
      { label: "Total Sessions", value: data.summary.totalSessions },
      { label: "Total Attendance", value: data.summary.totalAttendance },
      {
        label: "Avg Attendance Rate",
        value: `${data.summary.averageAttendanceRate}%`,
      },
    ]);

    // User Growth Chart
    if (data.userGrowth && data.userGrowth.length > 0) {
      this.addSectionTitle(doc, "User Growth Trends");
      this.addLineChart(
        doc,
        data.userGrowth.map((u) => ({
          label: new Date(u.period).toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
          }),
          value: parseInt(u.total_users),
        })),
        450,
        150,
      );
    }

    // Session Trends
    if (data.sessionTrends && data.sessionTrends.length > 0) {
      this.addSectionTitle(doc, "Session Trends");
      this.addBarChart(
        doc,
        data.sessionTrends.map((s) => ({
          label: new Date(s.period).toLocaleDateString("en-US", {
            month: "short",
          }),
          value: parseInt(s.total_sessions),
        })),
        450,
        150,
      );
    }

    // Attendance Trends
    if (data.attendanceTrends && data.attendanceTrends.length > 0) {
      this.addSectionTitle(doc, "Attendance Trends");
      this.addMultiLineChart(
        doc,
        [
          {
            label: "Present",
            data: data.attendanceTrends.map((a) => ({
              label: new Date(a.period).toLocaleDateString("en-US", {
                month: "short",
              }),
              value: parseInt(a.present),
            })),
          },
          {
            label: "Late",
            data: data.attendanceTrends.map((a) => ({
              label: new Date(a.period).toLocaleDateString("en-US", {
                month: "short",
              }),
              value: parseInt(a.late),
            })),
          },
          {
            label: "Absent",
            data: data.attendanceTrends.map((a) => ({
              label: new Date(a.period).toLocaleDateString("en-US", {
                month: "short",
              }),
              value: parseInt(a.absent),
            })),
          },
        ],
        450,
        180,
      );
    }

    this.addFooter(doc);
  }

  /**
   * Generate Generic PDF
   */
  async generateGenericPDF(doc, data) {
    this.addHeader(doc, "Attendance Report");
    this.addMetadata(doc, data);

    doc
      .fontSize(12)
      .text("Report Data", { underline: true, align: "center" })
      .moveDown(1);

    doc.fontSize(9).text(JSON.stringify(data, null, 2), { align: "left" });

    this.addFooter(doc);
  }

  // ==================== PDF Helper Methods ====================

  /**
   * Add header to PDF
   */
  addHeader(doc, title) {
    // Logo area (you can add an image if available)
    // if (fs.existsSync('./assets/logo.png')) {
    //   doc.image('./assets/logo.png', 50, 45, { width: 50 });
    // }

    doc
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("AttendX", { align: "center" })
      .moveDown(0.5);

    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text(title, { align: "center" })
      .moveDown(0.5);

    doc
      .strokeColor("#cccccc")
      .lineWidth(1)
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .stroke();

    doc.moveDown(1);
  }

  /**
   * Add metadata section
   */
  addMetadata(doc, data) {
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#666666")
      .text(`Generated: ${new Date(data.generatedAt).toLocaleString()}`, {
        align: "right",
      })
      .text(
        `Generated by: ${data.generatedBy.name} (${data.generatedBy.role})`,
        { align: "right" },
      )
      .fillColor("#000000")
      .moveDown(1);

    if (data.dateRange) {
      doc
        .fontSize(9)
        .text(
          `Date Range: ${data.dateRange.from ? new Date(data.dateRange.from).toLocaleDateString() : "Start"} to ${data.dateRange.to ? new Date(data.dateRange.to).toLocaleDateString() : "End"}`,
          { align: "center" },
        )
        .moveDown(1);
    }
  }

  /**
   * Add section title
   */
  addSectionTitle(doc, title) {
    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .fillColor("#333333")
      .text(title)
      .moveDown(0.5);

    doc
      .strokeColor("#999999")
      .lineWidth(0.5)
      .moveTo(50, doc.y)
      .lineTo(545, doc.y)
      .stroke();

    doc.moveDown(0.5);
  }

  /**
   * Add statistics grid
   */
  addStatsGrid(doc, stats) {
    const startY = doc.y;
    const itemsPerRow = 4;
    const boxWidth = (545 - 50) / itemsPerRow;
    const boxHeight = 60;

    for (let i = 0; i < stats.length; i++) {
      const col = i % itemsPerRow;
      const row = Math.floor(i / itemsPerRow);
      const x = 50 + col * boxWidth;
      const y = startY + row * boxHeight;

      // Draw box
      doc
        .rect(x, y, boxWidth - 5, boxHeight - 5)
        .fillColor("#f5f5f5")
        .fill()
        .fillColor("#000000");

      // Add label and value
      doc
        .fontSize(9)
        .font("Helvetica")
        .text(stats[i].label, x + 5, y + 10, {
          width: boxWidth - 15,
          align: "center",
        });

      doc
        .fontSize(14)
        .font("Helvetica-Bold")
        .text(stats[i].value.toString(), x + 5, y + 30, {
          width: boxWidth - 15,
          align: "center",
        });
    }

    doc.moveDown(Math.ceil(stats.length / itemsPerRow) + 1);
  }

  /**
   * Add table to PDF
   */
  addTable(doc, headers, rows) {
    const startY = doc.y;
    const rowHeight = 25;
    let currentY = startY;

    // Draw headers
    let currentX = 50;
    doc.fillColor("#4a5568").rect(50, currentY, 495, rowHeight).fill();

    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);

    headers.forEach((header) => {
      doc.text(header.label, currentX + 5, currentY + 8, {
        width: header.width - 10,
        align: header.align || "left",
      });
      currentX += header.width;
    });

    currentY += rowHeight;
    doc.fillColor("#000000");

    // Draw rows
    rows.forEach((row, rowIndex) => {
      const fillColor = rowIndex % 2 === 0 ? "#ffffff" : "#f7fafc";
      doc.fillColor(fillColor).rect(50, currentY, 495, rowHeight).fill();

      doc.fillColor("#000000").font("Helvetica").fontSize(8);

      currentX = 50;
      row.forEach((cell, cellIndex) => {
        doc.text(cell, currentX + 5, currentY + 8, {
          width: headers[cellIndex].width - 10,
          align: headers[cellIndex].align || "left",
        });
        currentX += headers[cellIndex].width;
      });

      currentY += rowHeight;

      // Add new page if needed
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
        this.addHeader(doc, "Attendance Report (Continued)");
      }
    });

    doc.moveDown(2);
  }

  /**
   * Add simple bar chart
   */
  addBarChart(doc, data, width, height) {
    const startX = 50;
    const startY = doc.y;
    const chartWidth = width;
    const chartHeight = height;
    const barWidth = (chartWidth - 20) / data.length - 5;
    const maxValue = Math.max(...data.map((d) => d.value));

    // Draw axes
    doc
      .lineWidth(1)
      .moveTo(startX, startY)
      .lineTo(startX, startY + chartHeight)
      .lineTo(startX + chartWidth, startY + chartHeight)
      .stroke();

    // Draw bars
    data.forEach((item, index) => {
      const barHeight = (item.value / maxValue) * (chartHeight - 20);
      const x = startX + 10 + index * (barWidth + 5);
      const y = startY + chartHeight - barHeight - 10;

      doc.fillColor("#4299e1").rect(x, y, barWidth, barHeight).fill();

      doc
        .fillColor("#000000")
        .fontSize(7)
        .text(item.label, x, startY + chartHeight - 5, {
          width: barWidth,
          align: "center",
        });

      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .text(item.value.toString(), x + barWidth / 2 - 5, y - 12);
    });

    doc.moveDown(2);
  }

  /**
   * Add line chart
   */
  addLineChart(doc, data, width, height) {
    const startX = 50;
    const startY = doc.y;
    const chartWidth = width;
    const chartHeight = height;
    const maxValue = Math.max(...data.map((d) => d.value));
    const stepX = (chartWidth - 20) / (data.length - 1);

    // Draw axes
    doc
      .lineWidth(1)
      .moveTo(startX, startY)
      .lineTo(startX, startY + chartHeight)
      .lineTo(startX + chartWidth, startY + chartHeight)
      .stroke();

    // Draw line
    const points = data.map((item, index) => ({
      x: startX + 10 + index * stepX,
      y:
        startY +
        chartHeight -
        10 -
        (item.value / maxValue) * (chartHeight - 20),
    }));

    doc.lineWidth(2).strokeColor("#4299e1");

    for (let i = 0; i < points.length - 1; i++) {
      doc
        .moveTo(points[i].x, points[i].y)
        .lineTo(points[i + 1].x, points[i + 1].y)
        .stroke();
    }

    // Draw points and labels
    points.forEach((point, index) => {
      doc.fillColor("#4299e1").circle(point.x, point.y, 3).fill();

      doc
        .fillColor("#000000")
        .fontSize(7)
        .text(data[index].label, point.x - 10, startY + chartHeight - 5, {
          width: 20,
          align: "center",
        });

      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .text(data[index].value.toString(), point.x - 5, point.y - 12);
    });

    doc.moveDown(2);
  }

  /**
   * Add multi-line chart
   */
  addMultiLineChart(doc, datasets, width, height) {
    const startX = 50;
    const startY = doc.y;
    const chartWidth = width;
    const chartHeight = height;

    // Find max value across all datasets
    let maxValue = 0;
    datasets.forEach((dataset) => {
      const datasetMax = Math.max(...dataset.data.map((d) => d.value));
      maxValue = Math.max(maxValue, datasetMax);
    });

    const stepX = (chartWidth - 20) / (datasets[0].data.length - 1);
    const colors = ["#4299e1", "#48bb78", "#f56565", "#ed8936"];

    // Draw axes
    doc
      .lineWidth(1)
      .moveTo(startX, startY)
      .lineTo(startX, startY + chartHeight)
      .lineTo(startX + chartWidth, startY + chartHeight)
      .stroke();

    // Draw lines for each dataset
    datasets.forEach((dataset, datasetIndex) => {
      const points = dataset.data.map((item, index) => ({
        x: startX + 10 + index * stepX,
        y:
          startY +
          chartHeight -
          10 -
          (item.value / maxValue) * (chartHeight - 20),
      }));

      doc.lineWidth(2).strokeColor(colors[datasetIndex % colors.length]);

      for (let i = 0; i < points.length - 1; i++) {
        doc
          .moveTo(points[i].x, points[i].y)
          .lineTo(points[i + 1].x, points[i + 1].y)
          .stroke();
      }

      // Add legend
      doc
        .fillColor(colors[datasetIndex % colors.length])
        .fontSize(8)
        .text(
          dataset.label,
          startX + chartWidth - 80,
          startY + datasetIndex * 15,
        );
    });

    // Add x-axis labels
    datasets[0].data.forEach((item, index) => {
      doc
        .fillColor("#000000")
        .fontSize(7)
        .text(
          item.label,
          startX + 10 + index * stepX - 10,
          startY + chartHeight - 5,
          { width: 20, align: "center" },
        );
    });

    doc.moveDown(2);
  }

  /**
   * Add footer to PDF
   */
  addFooter(doc) {
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor("#999999")
        .text(
          `AttendX - Smart Attendance System | Page ${i + 1} of ${pageCount} | ${new Date().toLocaleDateString()}`,
          50,
          doc.page.height - 50,
          { align: "center" },
        );
    }
    doc.fillColor("#000000");
  }

  /**
   * Format course attendance report as CSV
   */
  formatCourseAttendanceCSV(reportData) {
    const rows = [
      ["Course Attendance Report"],
      [`Generated: ${reportData.generatedAt}`],
      [`Course: ${reportData.course.name} (${reportData.course.code})`],
      [
        `Date Range: ${reportData.dateRange.from || "Start"} to ${reportData.dateRange.to || "End"}`,
      ],
      [],
      ["Summary Statistics"],
      [`Total Sessions,${reportData.summary.totalSessions}`],
      [`Total Students,${reportData.summary.totalStudents}`],
      [`Present,${reportData.summary.totalPresent}`],
      [`Late,${reportData.summary.totalLate}`],
      [`Absent,${reportData.summary.totalAbsent}`],
      [`Excused,${reportData.summary.totalExcused}`],
      [`Attendance Rate,${reportData.summary.attendanceRate}%`],
      [],
      ["Session Breakdown"],
      [
        "Session Code",
        "Date",
        "Classroom",
        "Present",
        "Late",
        "Absent",
        "Excused",
        "Checkins",
      ],
    ];

    for (const session of reportData.sessions) {
      rows.push([
        session.sessionCode,
        new Date(session.date).toLocaleDateString(),
        session.classroom || "N/A",
        session.present,
        session.late,
        session.absent,
        session.excused,
        session.checkins,
      ]);
    }

    if (reportData.students && reportData.students.length > 0) {
      rows.push([], ["Student Details"]);
      rows.push([
        "Student Name",
        "Registration Number",
        "Email",
        "Present",
        "Late",
        "Absent",
        "Excused",
        "Attendance Rate",
      ]);

      for (const student of reportData.students) {
        rows.push([
          `"${student.name}"`,
          student.regNumber || "N/A",
          student.email,
          student.present,
          student.late,
          student.absent,
          student.excused,
          `${student.attendanceRate}%`,
        ]);
      }
    }

    return rows;
  }

  /**
   * Format student attendance report as CSV
   */
  formatStudentAttendanceCSV(reportData) {
    const rows = [
      ["Student Attendance Report"],
      [`Generated: ${reportData.generatedAt}`],
      [
        `Student: ${reportData.student.fullName} (${reportData.student.regNumber || "N/A"})`,
      ],
      [`Email: ${reportData.student.email}`],
      [],
      ["Summary Statistics"],
      [`Total Sessions,${reportData.summary.totalSessions}`],
      [`Present,${reportData.summary.present}`],
      [`Late,${reportData.summary.late}`],
      [`Absent,${reportData.summary.absent}`],
      [`Excused,${reportData.summary.excused}`],
      [`Attendance Rate,${reportData.summary.attendanceRate}%`],
      [`Current Streak,${reportData.summary.currentStreak}`],
      [`Longest Streak,${reportData.summary.longestStreak}`],
      [],
      ["Course Breakdown"],
      [
        "Course Code",
        "Course Name",
        "Present",
        "Late",
        "Absent",
        "Excused",
        "Attendance Rate",
      ],
    ];

    for (const course of reportData.byCourse) {
      rows.push([
        course.course.code,
        `"${course.course.name}"`,
        course.present,
        course.late,
        course.absent,
        course.excused,
        `${course.attendanceRate}%`,
      ]);
    }

    rows.push([], ["Attendance History"]);
    rows.push([
      "Date",
      "Course",
      "Session Code",
      "Status",
      "Classroom",
      "Distance (m)",
    ]);

    for (const record of reportData.attendanceHistory) {
      rows.push([
        new Date(record.date).toLocaleDateString(),
        record.courseCode,
        record.sessionCode,
        record.status.toUpperCase(),
        record.classroom || "N/A",
        record.distanceM || "N/A",
      ]);
    }

    return rows;
  }

  /**
   * Format lecturer summary report as CSV
   */
  formatLecturerSummaryCSV(reportData) {
    const rows = [
      ["Lecturer Summary Report"],
      [`Generated: ${reportData.generatedAt}`],
      [
        `Lecturer: ${reportData.lecturer.fullName} (${reportData.lecturer.staffNumber || "N/A"})`,
      ],
      [],
      ["Summary Statistics"],
      [`Total Courses,${reportData.summary.totalCourses}`],
      [`Total Students,${reportData.summary.totalStudents}`],
      [`Total Sessions,${reportData.summary.totalSessions}`],
      [`Total Present,${reportData.summary.totalPresent}`],
      [`Total Late,${reportData.summary.totalLate}`],
      [`Total Absent,${reportData.summary.totalAbsent}`],
      [`Overall Attendance Rate,${reportData.summary.overallAttendanceRate}%`],
      [],
      ["Course Breakdown"],
      [
        "Course Code",
        "Course Name",
        "Enrolled Students",
        "Sessions",
        "Present",
        "Late",
        "Absent",
        "Attendance Rate",
      ],
    ];

    for (const course of reportData.courseSummaries) {
      rows.push([
        course.courseCode,
        `"${course.courseName}"`,
        course.enrolledCount,
        course.sessions,
        course.present,
        course.late,
        course.absent,
        `${course.attendanceRate}%`,
      ]);
    }

    return rows;
  }

  /**
   * Format at-risk students report as CSV
   */
  formatAtRiskCSV(reportData) {
    const rows = [
      ["At-Risk Students Report"],
      [`Generated: ${reportData.generatedAt}`],
      [`Attendance Threshold: ${reportData.criteria.attendanceThreshold}%`],
      [
        `Consecutive Absences Threshold: ${reportData.criteria.consecutiveAbsencesThreshold}`,
      ],
      [],
      ["Summary"],
      [`Total At-Risk Students,${reportData.summary.totalAtRisk}`],
      [`Critical (Below 50%),${reportData.summary.criticalCount}`],
      [`Warning (50-75%),${reportData.summary.warningCount}`],
      [`Affected Courses,${reportData.summary.affectedCourses}`],
      [],
      ["Student Details"],
      [
        "Student Name",
        "Registration Number",
        "Email",
        "Course",
        "Attendance Rate",
        "Consecutive Absences",
        "Risk Level",
      ],
    ];

    for (const student of reportData.students) {
      rows.push([
        `"${student.student.fullName}"`,
        student.student.regNumber || "N/A",
        student.student.email,
        `${student.course.code} - ${student.course.name}`,
        `${student.statistics.attendanceRate}%`,
        student.statistics.consecutiveAbsences,
        student.riskLevel.toUpperCase(),
      ]);
    }

    return rows;
  }

  /**
   * Get student attendance details for course report
   */
  async getStudentAttendanceDetails(courseId, enrollments, sessions) {
    const studentDetails = [];

    for (const enrollment of enrollments) {
      let present = 0;
      let late = 0;
      let absent = 0;
      let excused = 0;

      for (const session of sessions) {
        const record = session.attendanceRecords.find(
          (r) => r.studentId === enrollment.student.id,
        );
        if (record) {
          switch (record.status) {
            case "present":
              present++;
              break;
            case "late":
              late++;
              break;
            case "absent":
              absent++;
              break;
            case "excused":
              excused++;
              break;
          }
        } else {
          absent++;
        }
      }

      const total = present + late + absent + excused;
      const attendanceRate = total > 0 ? ((present + late) / total) * 100 : 100;

      studentDetails.push({
        id: enrollment.student.id,
        name: enrollment.student.fullName,
        regNumber: enrollment.student.regNumber,
        email: enrollment.student.email,
        present,
        late,
        absent,
        excused,
        total,
        attendanceRate: parseFloat(attendanceRate.toFixed(1)),
      });
    }

    return studentDetails;
  }

  /**
   * Send report via email
   * POST /api/v1/reports/send
   */
  async sendReportByEmail(req, res, next) {
    try {
      const {
        reportType,
        recipientEmail,
        format = "pdf",
        ...reportParams
      } = req.body;

      // Generate report based on type
      let reportData;
      const mockReq = { query: reportParams, user: req.user };
      const mockRes = {
        json: (data) => {
          reportData = data.data;
        },
      };

      switch (reportType) {
        case "course_attendance":
          await this.generateCourseAttendanceReport(mockReq, mockRes, next);
          break;
        case "student_attendance":
          await this.generateStudentAttendanceReport(mockReq, mockRes, next);
          break;
        case "lecturer_summary":
          await this.generateLecturerSummaryReport(mockReq, mockRes, next);
          break;
        case "at_risk":
          await this.generateAtRiskReport(mockReq, mockRes, next);
          break;
        default:
          throw new Error("Invalid report type");
      }

      // Send email with report
      await sendEmail(
        recipientEmail,
        `AttendX Report: ${reportType.replace(/_/g, " ").toUpperCase()}`,
        this.getReportEmailHTML(reportType, reportParams, reportData),
      );

      // Log the action
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SEND_REPORT",
          entity: "Report",
          newValues: { reportType, recipientEmail, format },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: {
          message: `Report sent to ${recipientEmail}`,
          reportType,
          recipient: recipientEmail,
        },
      });
    } catch (error) {
      logger.error("Send report by email error:", error);
      next(error);
    }
  }

  /**
   * Get report email HTML template
   */
  getReportEmailHTML(reportType, params, reportData) {
    const typeLabels = {
      course_attendance: "Course Attendance Report",
      student_attendance: "Student Attendance Report",
      lecturer_summary: "Lecturer Summary Report",
      at_risk: "At-Risk Students Report",
    };

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333;">${typeLabels[reportType] || "Report"}</h2>
          <p>Your requested report has been generated.</p>
          <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Report Details:</strong></p>
            <ul>
              <li>Type: ${reportType}</li>
              <li>Generated: ${new Date().toLocaleString()}</li>
              <li>Parameters: ${JSON.stringify(params)}</li>
            </ul>
          </div>
          <p>The report is attached to this email as ${params.format || "PDF"}.</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }
}

module.exports = new ReportController();
