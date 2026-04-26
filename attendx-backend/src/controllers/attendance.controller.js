const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { sendEmail } = require("../services/email.service");

class AttendanceController {
  /**
   * Query attendance records
   * GET /api/attendance
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
      } = req.query;
      const skip = (page - 1) * limit;

      const where = {};

      if (sessionId) where.sessionId = sessionId;
      if (status) where.status = status;

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
          const courses = await global.prisma.course.findMany({
            where: { lecturerId: req.user.id },
            select: { id: true },
          });
          const courseIds = courses.map((c) => c.id);
          where.session = { courseId: { in: courseIds } };
        }
      } else if (req.user.role === "admin") {
        if (courseId) where.session = { courseId };
        if (studentId) where.studentId = studentId;
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
                  select: { id: true, fullName: true, email: true },
                },
              },
            },
            student: {
              select: {
                id: true,
                fullName: true,
                email: true,
                regNumber: true,
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
   * Override attendance record
   * PATCH /api/attendance/:attendanceId/override
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
            fields: errors.array(),
          },
        });
      }

      const { attendanceId } = req.params;
      const { status, reason } = req.body;

      const attendance = await global.prisma.attendanceRecord.findUnique({
        where: { id: attendanceId },
        include: {
          session: {
            include: { course: true },
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

      const updated = await global.prisma.attendanceRecord.update({
        where: { id: attendanceId },
        data: {
          status,
          overriddenAt: new Date(),
          overriddenBy: req.user.id,
          overrideReason: reason,
        },
        include: {
          session: {
            include: { course: true },
          },
          student: true,
        },
      });

      // Send email notification about override
      await sendEmail(
        attendance.student.email,
        "📝 Attendance Record Updated - AttendX",
        `<div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #4F46E5;">Attendance Record Updated</h2>
          <p>Dear ${attendance.student.fullName},</p>
          <p>Your attendance record for <strong>${updated.session.course.name}</strong> has been updated.</p>
          <p><strong>Changes:</strong></p>
          <ul>
            <li>Previous Status: ${attendance.status.toUpperCase()}</li>
            <li>New Status: ${status.toUpperCase()}</li>
            <li>Reason: ${reason || "No reason provided"}</li>
          </ul>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>`,
      );

      logger.info(
        `Attendance record ${attendanceId} overridden by ${req.user.email}: ${attendance.status} -> ${status}`,
      );

      res.json({
        success: true,
        data: {
          id: updated.id,
          status: updated.status,
          submissionMethod: updated.submissionMethod,
          message: "Attendance record updated successfully",
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get attendance statistics for a student
   * GET /api/attendance/statistics/:studentId
   */
  async getStudentStatistics(req, res, next) {
    try {
      const { studentId } = req.params;

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

      const records = await global.prisma.attendanceRecord.findMany({
        where: { studentId },
        include: {
          session: {
            include: { course: true },
          },
        },
      });

      const totalClasses = records.length;
      const present = records.filter((r) => r.status === "present").length;
      const absent = records.filter((r) => r.status === "absent").length;
      const excused = records.filter((r) => r.status === "excused").length;
      const late = records.filter((r) => r.status === "late").length;

      // Per-course statistics
      const courseStats = {};
      for (const record of records) {
        const courseId = record.session.courseId;
        if (!courseStats[courseId]) {
          courseStats[courseId] = {
            courseName: record.session.course.name,
            courseCode: record.session.course.code,
            total: 0,
            present: 0,
            absent: 0,
            excused: 0,
            late: 0,
          };
        }
        courseStats[courseId].total++;
        courseStats[courseId][record.status]++;
      }

      res.json({
        success: true,
        data: {
          overall: {
            totalClasses,
            present,
            absent,
            excused,
            late,
            attendanceRate:
              totalClasses > 0 ? ((present + excused) / totalClasses) * 100 : 0,
          },
          perCourse: Object.values(courseStats),
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AttendanceController();
