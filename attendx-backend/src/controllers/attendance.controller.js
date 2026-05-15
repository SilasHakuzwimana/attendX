const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const { sendEmail } = require("../services/email.service");
const { sendPushNotification } = require("../services/notification.service");

class AttendanceController {
  /**
   * Query attendance records with advanced filtering
   * GET /api/v1/attendance
   */
  async queryAttendance(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        sessionId,
        courseId,
        studentId,
        status,
        from,
        to,
        sortBy = "markedAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = {};

      if (sessionId) where.sessionId = sessionId;
      if (status && ["present", "absent", "excused", "late"].includes(status)) {
        where.status = status;
      }

      if (from || to) {
        where.markedAt = {};
        if (from) where.markedAt.gte = new Date(from);
        if (to) where.markedAt.lte = new Date(to);
      }

      // Build query based on role
      if (req.user.role === "student") {
        where.studentId = req.user.id;
      } else if (req.user.role === "lecturer") {
        if (courseId) {
          where.session = { courseId };
        } else if (studentId) {
          where.studentId = studentId;
        } else {
          // Lecturer can only see their own courses
          const courses = await prisma.course.findMany({
            where: { lecturerId: req.user.id, isActive: true },
            select: { id: true },
          });
          const courseIds = courses.map((c) => c.id);
          if (courseIds.length > 0) {
            where.session = { courseId: { in: courseIds } };
          } else {
            return res.json({
              success: true,
              data: [],
              meta: { page: 1, limit, total: 0, totalPages: 0 },
            });
          }
        }
      } else if (req.user.role === "admin") {
        if (courseId) where.session = { courseId };
        if (studentId) where.studentId = studentId;
      }

      const cacheKey = `attendance:query:${req.user.id}:${JSON.stringify(req.query)}`;

      // Check cache for frequent queries
      let cachedData = null;
      if (redisClient && redisClient.isReady && page === 1 && !from && !to) {
        cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.json({
            success: true,
            data: JSON.parse(cachedData),
            meta: { cached: true },
          });
        }
      }

      const [records, total] = await Promise.all([
        prisma.attendanceRecord.findMany({
          where,
          include: {
            session: {
              include: {
                course: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    credits: true,
                    academicYear: true,
                    semester: true,
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
                    email: true,
                    staffNumber: true,
                  },
                },
              },
            },
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
          orderBy: { [sortBy]: sortOrder },
          skip,
          take,
        }),
        prisma.attendanceRecord.count({ where }),
      ]);

      // Cache for 2 minutes
      if (redisClient && redisClient.isReady && page === 1 && !from && !to) {
        await redisClient.setEx(cacheKey, 120, JSON.stringify(records));
      }

      res.json({
        success: true,
        data: records,
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
      logger.error("Query attendance error:", error);
      next(error);
    }
  }

  /**
   * Get single attendance record by ID
   * GET /api/v1/attendance/:attendanceId
   */
  async getAttendanceRecord(req, res, next) {
    try {
      const { attendanceId } = req.params;

      const record = await prisma.attendanceRecord.findUnique({
        where: { id: attendanceId },
        include: {
          session: {
            include: {
              course: true,
              classroom: true,
              lecturer: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                },
              },
            },
          },
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

      if (!record) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Attendance record not found" },
        });
      }

      // Check permission
      if (req.user.role === "student" && record.studentId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only view your own attendance",
          },
        });
      }

      if (
        req.user.role === "lecturer" &&
        record.session.lecturerId !== req.user.id
      ) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only view attendance for your courses",
          },
        });
      }

      res.json({ success: true, data: record });
    } catch (error) {
      logger.error("Get attendance record error:", error);
      next(error);
    }
  }

  /**
   * Override attendance record (Lecturer/Admin only)
   * PATCH /api/v1/attendance/:attendanceId/override
   */
  async overrideAttendance(req, res, next) {
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

      const { attendanceId } = req.params;
      const { status, reason, notes } = req.body;

      // Validate status
      const validStatuses = ["present", "absent", "excused", "late"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Invalid status value" },
        });
      }

      const attendance = await prisma.attendanceRecord.findUnique({
        where: { id: attendanceId },
        include: {
          session: {
            include: {
              course: true,
              lecturer: true,
            },
          },
          student: true,
        },
      });

      if (!attendance) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Attendance record not found" },
        });
      }

      // Check permission
      if (
        req.user.role !== "admin" &&
        attendance.session.lecturerId !== req.user.id
      ) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to override this record",
          },
        });
      }

      const oldStatus = attendance.status;

      const updated = await prisma.attendanceRecord.update({
        where: { id: attendanceId },
        data: {
          status,
          overriddenAt: new Date(),
          overriddenBy: req.user.id,
          overrideReason: reason,
          notes: notes || attendance.notes,
        },
        include: {
          session: {
            include: { course: true },
          },
          student: true,
        },
      });

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "OVERRIDE_ATTENDANCE",
          entity: "AttendanceRecord",
          entityId: attendanceId,
          oldValues: { status: oldStatus },
          newValues: { status, reason },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Send email notification about override
      await sendEmail(
        attendance.student.email,
        "📝 Attendance Record Updated - AttendX",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">AttendX</h1>
          </div>
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333;">Attendance Record Updated</h2>
            <p>Dear ${attendance.student.fullName},</p>
            <p>Your attendance record for <strong>${updated.session.course.name}</strong> has been updated.</p>
            <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p><strong>Changes:</strong></p>
              <ul>
                <li>Previous Status: <strong>${oldStatus.toUpperCase()}</strong></li>
                <li>New Status: <strong>${status.toUpperCase()}</strong></li>
                <li>Reason: ${reason || "No reason provided"}</li>
              </ul>
            </div>
            <p style="color: #666; font-size: 12px;">If you have questions, please contact your lecturer.</p>
            <hr style="margin: 20px 0;" />
            <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
          </div>
        </div>
        `,
      );

      // Send push notification if device has FCM token
      const devices = await prisma.device.findMany({
        where: {
          userId: attendance.student.id,
          isActive: true,
          fcmToken: { not: null },
        },
      });

      for (const device of devices) {
        await sendPushNotification(device.fcmToken, {
          title: "Attendance Updated",
          body: `Your attendance for ${updated.session.course.name} has been changed to ${status.toUpperCase()}`,
          data: { attendanceId, type: "attendance_override" },
        });
      }

      // Invalidate relevant caches
      if (redisClient && redisClient.isReady) {
        const cachePatterns = [
          `attendance:query:${attendance.studentId}:*`,
          `student:dashboard:${attendance.studentId}`,
          `student:summary:${attendance.studentId}`,
          `student:attendance:${attendance.studentId}`,
          `lecturer:dashboard:${attendance.session.lecturerId}`,
        ];

        for (const pattern of cachePatterns) {
          const keys = await redisClient.keys(pattern);
          if (keys.length > 0) {
            await redisClient.del(keys);
          }
        }
      }

      logger.info(
        `Attendance record ${attendanceId} overridden by ${req.user.email}: ${oldStatus} -> ${status}`,
      );

      res.json({
        success: true,
        data: {
          id: updated.id,
          status: updated.status,
          oldStatus,
          overriddenAt: updated.overriddenAt,
          message: "Attendance record updated successfully",
        },
      });
    } catch (error) {
      logger.error("Override attendance error:", error);
      next(error);
    }
  }

  /**
   * Get attendance statistics for a student
   * GET /api/v1/attendance/statistics/:studentId
   */
  async getStudentStatistics(req, res, next) {
    try {
      const { studentId } = req.params;
      const { courseId, semester, academicYear } = req.query;

      // Check permission
      if (req.user.role === "student" && req.user.id !== studentId) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only view your own statistics",
          },
        });
      }

      const cacheKey = `attendance:stats:${studentId}:${courseId || "all"}:${semester || "all"}:${academicYear || "all"}`;

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

      // Build where clause
      const where = { studentId };
      if (courseId) {
        where.session = { courseId };
      }
      if (semester || academicYear) {
        where.session = {
          ...where.session,
          course: {},
        };
        if (semester) where.session.course.semester = parseInt(semester);
        if (academicYear) where.session.course.academicYear = academicYear;
      }

      const records = await prisma.attendanceRecord.findMany({
        where,
        include: {
          session: {
            include: {
              course: true,
              classroom: true,
            },
          },
        },
      });

      const totalClasses = records.length;
      const present = records.filter((r) => r.status === "present").length;
      const absent = records.filter((r) => r.status === "absent").length;
      const excused = records.filter((r) => r.status === "excused").length;
      const late = records.filter((r) => r.status === "late").length;

      // Calculate attendance rate (present + late are considered attended)
      const attended = present + late;
      const attendanceRate =
        totalClasses > 0 ? (attended / totalClasses) * 100 : 0;

      // Per-course statistics
      const courseStats = {};
      for (const record of records) {
        const courseIdKey = record.session.courseId;
        if (!courseStats[courseIdKey]) {
          courseStats[courseIdKey] = {
            courseId: courseIdKey,
            courseName: record.session.course.name,
            courseCode: record.session.course.code,
            credits: record.session.course.credits,
            total: 0,
            present: 0,
            absent: 0,
            excused: 0,
            late: 0,
          };
        }
        courseStats[courseIdKey].total++;
        courseStats[courseIdKey][record.status]++;
      }

      // Calculate streak
      const sortedRecords = [...records].sort(
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

      const responseData = {
        studentId,
        overall: {
          totalClasses,
          present,
          absent,
          excused,
          late,
          attended,
          attendanceRate: parseFloat(attendanceRate.toFixed(1)),
          currentStreak,
          longestStreak,
        },
        perCourse: Object.values(courseStats).map((course) => ({
          ...course,
          attendanceRate:
            course.total > 0
              ? parseFloat(
                  (
                    ((course.present + course.late) / course.total) *
                    100
                  ).toFixed(1),
                )
              : 0,
        })),
        lastUpdated: new Date(),
      };

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(responseData));
      }

      res.json({ success: true, data: responseData });
    } catch (error) {
      logger.error("Get student statistics error:", error);
      next(error);
    }
  }

  /**
   * Get course attendance statistics (Lecturer/Admin)
   * GET /api/v1/attendance/course/:courseId/statistics
   */
  async getCourseStatistics(req, res, next) {
    try {
      const { courseId } = req.params;
      const { sessionId } = req.query;

      // Check permission
      if (req.user.role === "lecturer") {
        const course = await prisma.course.findFirst({
          where: { id: courseId, lecturerId: req.user.id },
        });
        if (!course) {
          return res.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You don't have access to this course",
            },
          });
        }
      }

      const cacheKey = `attendance:course:${courseId}:${sessionId || "all"}`;

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

      // Get all sessions for this course
      const sessions = await prisma.session.findMany({
        where: {
          courseId,
          ...(sessionId && { id: sessionId }),
        },
        include: {
          attendanceRecords: {
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
          classroom: true,
        },
        orderBy: { startedAt: "desc" },
      });

      const course = await prisma.course.findUnique({
        where: { id: courseId },
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
        },
      });

      // Calculate per-student statistics
      const studentStats = {};
      for (const enrollment of course.enrollments) {
        const studentId = enrollment.student.id;
        studentStats[studentId] = {
          student: enrollment.student,
          totalSessions: 0,
          present: 0,
          absent: 0,
          excused: 0,
          late: 0,
          attendanceRate: 0,
        };
      }

      for (const session of sessions) {
        for (const record of session.attendanceRecords) {
          const stats = studentStats[record.studentId];
          if (stats) {
            stats.totalSessions++;
            stats[record.status]++;
          }
        }
      }

      // Calculate rates
      for (const stats of Object.values(studentStats)) {
        const attended = stats.present + stats.late;
        stats.attendanceRate =
          stats.totalSessions > 0
            ? parseFloat(((attended / stats.totalSessions) * 100).toFixed(1))
            : 0;
      }

      const responseData = {
        course: {
          id: course.id,
          code: course.code,
          name: course.name,
          credits: course.credits,
        },
        sessions: sessions.map((s) => ({
          id: s.id,
          sessionCode: s.sessionCode,
          startedAt: s.startedAt,
          expiresAt: s.expiresAt,
          status: s.status,
          checkinsCount: s.attendanceRecords.length,
          classroom: s.classroom,
        })),
        studentStatistics: Object.values(studentStats),
        summary: {
          totalStudents: course.enrollments.length,
          totalSessions: sessions.length,
          averageAttendance:
            Object.values(studentStats).reduce(
              (acc, s) => acc + s.attendanceRate,
              0,
            ) / (Object.values(studentStats).length || 1),
        },
      };

      // Cache for 5 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(responseData));
      }

      res.json({ success: true, data: responseData });
    } catch (error) {
      logger.error("Get course statistics error:", error);
      next(error);
    }
  }

  /**
   * Export attendance data to CSV
   * GET /api/v1/attendance/export
   */
  async exportAttendance(req, res, next) {
    try {
      const { courseId, sessionId, from, to, format = "csv" } = req.query;

      const where = {};
      if (courseId) where.session = { courseId };
      if (sessionId) where.sessionId = sessionId;
      if (from || to) {
        where.markedAt = {};
        if (from) where.markedAt.gte = new Date(from);
        if (to) where.markedAt.lte = new Date(to);
      }

      // Apply role-based filtering
      if (req.user.role === "student") {
        where.studentId = req.user.id;
      } else if (req.user.role === "lecturer") {
        const courses = await prisma.course.findMany({
          where: { lecturerId: req.user.id },
          select: { id: true },
        });
        const courseIds = courses.map((c) => c.id);
        where.session = { ...where.session, courseId: { in: courseIds } };
      }

      const records = await prisma.attendanceRecord.findMany({
        where,
        include: {
          session: {
            include: { course: true },
          },
          student: {
            select: {
              fullName: true,
              email: true,
              regNumber: true,
            },
          },
        },
        orderBy: { markedAt: "desc" },
      });

      // Format as CSV
      const csvRows = [
        [
          "Date",
          "Student Name",
          "Student Email",
          "Registration Number",
          "Course",
          "Session Code",
          "Status",
          "Method",
          "Distance (m)",
          "Notes",
        ],
      ];

      for (const record of records) {
        csvRows.push([
          record.markedAt.toISOString(),
          record.student.fullName,
          record.student.email,
          record.student.regNumber || "",
          record.session.course.name,
          record.session.sessionCode,
          record.status,
          record.submissionMethod || "",
          record.distanceM || "",
          record.notes || "",
        ]);
      }

      const csvContent = csvRows.map((row) => row.join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=attendance_export_${Date.now()}.csv`,
      );
      res.send(csvContent);
    } catch (error) {
      logger.error("Export attendance error:", error);
      next(error);
    }
  }

  /**
   * Get at-risk students (below threshold)
   * GET /api/v1/attendance/at-risk
   */
  async getAtRiskStudents(req, res, next) {
    try {
      const { courseId, threshold = 75 } = req.query;

      // Check permission
      if (req.user.role === "lecturer") {
        const course = await prisma.course.findFirst({
          where: { id: courseId, lecturerId: req.user.id },
        });
        if (!course) {
          return res.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You don't have access to this course",
            },
          });
        }
      }

      const enrollments = await prisma.enrollment.findMany({
        where: {
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

      const atRiskStudents = [];

      for (const enrollment of enrollments) {
        const records = await prisma.attendanceRecord.findMany({
          where: {
            studentId: enrollment.studentId,
            session: { courseId },
          },
        });

        const total = records.length;
        const attended = records.filter(
          (r) => r.status === "present" || r.status === "late",
        ).length;
        const rate = total > 0 ? (attended / total) * 100 : 100;

        if (rate < threshold) {
          atRiskStudents.push({
            student: enrollment.student,
            attendanceRate: parseFloat(rate.toFixed(1)),
            totalSessions: total,
            attendedSessions: attended,
            status:
              rate < 50 ? "critical" : rate < threshold ? "warning" : "good",
          });
        }
      }

      res.json({
        success: true,
        data: {
          threshold: parseFloat(threshold),
          totalAtRisk: atRiskStudents.length,
          students: atRiskStudents.sort(
            (a, b) => a.attendanceRate - b.attendanceRate,
          ),
        },
      });
    } catch (error) {
      logger.error("Get at-risk students error:", error);
      next(error);
    }
  }
}

module.exports = new AttendanceController();
