const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient, io } = require("../index");
const { generateSessionCode } = require("../utils/helpers");
const {
  calculateDistance,
  validateGeofence,
} = require("../services/geofence.service");
const { sendPushNotification } = require("../services/notification.service");
const { sendEmail } = require("../services/email.service");

class SessionController {
  /**
   * Start a new attendance session
   * POST /api/v1/sessions
   */
  async startSession(req, res, next) {
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

      const { courseId, classroomId, durationMinutes = 90 } = req.body;

      // Verify course belongs to lecturer
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          lecturerId: req.user.id,
          isActive: true,
        },
        include: {
          lecturer: true,
          enrollments: {
            where: { isActive: true },
            include: {
              student: {
                include: {
                  devices: {
                    where: { isActive: true },
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
          error: {
            code: "NOT_FOUND",
            message: "Course not found or you are not the lecturer",
          },
        });
      }

      // Check for existing active session
      const existingSession = await prisma.session.findFirst({
        where: {
          courseId,
          status: "active",
          checkinOpen: true,
        },
      });

      if (existingSession) {
        return res.status(409).json({
          success: false,
          error: {
            code: "SESSION_ALREADY_ACTIVE",
            message: "There is already an active session for this course",
            data: { sessionId: existingSession.id },
          },
        });
      }

      // Get classroom
      const classroom = await prisma.classroom.findUnique({
        where: { id: classroomId, isActive: true },
      });

      if (!classroom) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Classroom not found",
          },
        });
      }

      // Create session
      const sessionCode = await generateSessionCode(prisma);
      const expiresAt = new Date(Date.now() + durationMinutes * 60000);

      const session = await prisma.session.create({
        data: {
          sessionCode,
          courseId,
          classroomId,
          lecturerId: req.user.id,
          durationMinutes,
          expiresAt,
          checkinOpen: true,
          status: "active",
        },
        include: {
          course: true,
          classroom: true,
        },
      });

      // Store in Redis for quick access
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(
          `session:${session.id}`,
          durationMinutes * 60,
          JSON.stringify({
            id: session.id,
            sessionCode: session.sessionCode,
            courseId,
            courseName: course.name,
            classroomId,
            classroomName: classroom.name,
            classroomLat: classroom.latitude,
            classroomLng: classroom.longitude,
            radiusM: classroom.radiusM,
            expiresAt: expiresAt.toISOString(),
            checkinOpen: true,
            status: "active",
          }),
        );
      }

      // Send push notifications to enrolled students
      const studentsWithDevices = course.enrollments.filter(
        (e) => e.student.devices.length > 0,
      );

      for (const enrollment of studentsWithDevices) {
        const student = enrollment.student;
        const preferences = student.notificationPref;

        if (preferences?.sessionStarted !== false) {
          for (const device of student.devices) {
            if (device.fcmToken && device.isActive) {
              await sendPushNotification(device.fcmToken, {
                title: "📚 Attendance Session Started",
                body: `${course.name} in ${classroom.name} has started. Check in now!`,
                data: {
                  sessionId: session.id,
                  sessionCode,
                  courseName: course.name,
                  courseCode: course.code,
                  roomName: classroom.name,
                  expiresAt: expiresAt.toISOString(),
                  type: "session_started",
                },
              });
            }
          }
        }
      }

      // Emit WebSocket event
      if (io) {
        io.to(`course:${courseId}`).emit("session-started", {
          sessionId: session.id,
          sessionCode,
          courseName: course.name,
          courseCode: course.code,
          roomName: classroom.name,
          building: classroom.building,
          expiresAt,
          durationMinutes,
        });
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "START_SESSION",
          entity: "Session",
          entityId: session.id,
          newValues: { courseId, classroomId, durationMinutes, sessionCode },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Session started: ${session.id} for course ${course.name} by ${req.user.email}`,
      );

      res.status(201).json({
        success: true,
        data: {
          sessionId: session.id,
          sessionCode,
          roomName: classroom.name,
          roomBuilding: classroom.building,
          courseName: course.name,
          courseCode: course.code,
          expiresAt,
          durationMinutes,
          checkinOpen: true,
          totalEnrolledStudents: course.enrollments.length,
        },
      });
    } catch (error) {
      logger.error("Start session error:", error);
      next(error);
    }
  }

  /**
   * List sessions for lecturer
   * GET /api/v1/sessions
   */
  async listSessions(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        courseId,
        status,
        from,
        to,
        sortBy = "startedAt",
        sortOrder = "desc",
      } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const take = parseInt(limit);

      const where = { lecturerId: req.user.id };

      if (courseId) where.courseId = courseId;
      if (status && ["active", "closed", "expired"].includes(status)) {
        where.status = status;
      }

      if (from || to) {
        where.startedAt = {};
        if (from) where.startedAt.gte = new Date(from);
        if (to) where.startedAt.lte = new Date(to);
      }

      const [sessions, total] = await Promise.all([
        prisma.session.findMany({
          where,
          include: {
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
            _count: {
              select: {
                roomCheckins: true,
                attendanceRecords: true,
              },
            },
          },
          orderBy: { [sortBy]: sortOrder },
          skip,
          take,
        }),
        prisma.session.count({ where }),
      ]);

      // Add additional stats
      const sessionsWithStats = await Promise.all(
        sessions.map(async (session) => {
          const enrolledCount = await prisma.enrollment.count({
            where: { courseId: session.courseId, isActive: true },
          });

          return {
            ...session,
            checkinCount: session._count.roomCheckins,
            attendanceCount: session._count.attendanceRecords,
            enrolledCount,
            checkinRate:
              enrolledCount > 0
                ? (session._count.roomCheckins / enrolledCount) * 100
                : 0,
            _count: undefined,
          };
        }),
      );

      res.json({
        success: true,
        data: sessionsWithStats,
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
      logger.error("List sessions error:", error);
      next(error);
    }
  }

  /**
   * Get session details
   * GET /api/v1/sessions/:sessionId
   */
  async getSession(req, res, next) {
    try {
      const { sessionId } = req.params;

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          course: {
            include: {
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
          classroom: true,
          roomCheckins: {
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
            orderBy: { checkedInAt: "desc" },
          },
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
            take: 100,
          },
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }

      // Check access
      if (
        req.user.role !== "admin" &&
        session.lecturerId !== req.user.id &&
        req.user.role !== "student"
      ) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have access to this session",
          },
        });
      }

      // If student, check enrollment
      if (req.user.role === "student") {
        const enrollment = await prisma.enrollment.findFirst({
          where: {
            studentId: req.user.id,
            courseId: session.courseId,
            isActive: true,
          },
        });

        if (!enrollment) {
          return res.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You are not enrolled in this course",
            },
          });
        }
      }

      // Calculate statistics
      const enrolledCount = await prisma.enrollment.count({
        where: { courseId: session.courseId, isActive: true },
      });

      const responseData = {
        ...session,
        statistics: {
          totalEnrolled: enrolledCount,
          checkedIn: session.roomCheckins.length,
          attendanceRecords: session.attendanceRecords.length,
          checkinRate:
            enrolledCount > 0
              ? (session.roomCheckins.length / enrolledCount) * 100
              : 0,
          presentCount: session.attendanceRecords.filter(
            (r) => r.status === "present",
          ).length,
          lateCount: session.attendanceRecords.filter(
            (r) => r.status === "late",
          ).length,
          absentCount: session.attendanceRecords.filter(
            (r) => r.status === "absent",
          ).length,
          excusedCount: session.attendanceRecords.filter(
            (r) => r.status === "excused",
          ).length,
        },
        timeRemaining:
          session.status === "active"
            ? Math.max(
                0,
                Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
              )
            : 0,
        isExpired:
          session.status === "active" &&
          new Date(session.expiresAt) < new Date(),
      };

      res.json({ success: true, data: responseData });
    } catch (error) {
      logger.error("Get session error:", error);
      next(error);
    }
  }

  /**
   * Close session and finalize attendance
   * POST /api/v1/sessions/:sessionId/close
   */
  async closeSession(req, res, next) {
    try {
      const { sessionId } = req.params;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          lecturerId: req.user.id,
        },
        include: {
          course: {
            include: {
              enrollments: {
                where: { isActive: true },
                include: {
                  student: {
                    include: {
                      notificationPref: true,
                      devices: {
                        where: { isActive: true, fcmToken: { not: null } },
                      },
                    },
                  },
                },
              },
            },
          },
          classroom: true,
          roomCheckins: true,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Session not found or you don't have permission",
          },
        });
      }

      if (session.status !== "active") {
        return res.status(409).json({
          success: false,
          error: {
            code: "SESSION_ALREADY_CLOSED",
            message: "This session has already been closed",
          },
        });
      }

      // Get checked-in student IDs
      const checkedInStudentIds = new Set(
        session.roomCheckins.map((c) => c.studentId),
      );

      // Process attendance records
      const attendanceRecords = [];
      let presentCount = 0;
      let lateCount = 0;
      let absentCount = 0;

      for (const enrollment of session.course.enrollments) {
        const checkin = session.roomCheckins.find(
          (c) => c.studentId === enrollment.studentId,
        );
        let status = "absent";

        if (checkin) {
          // Determine if late (check-in after grace period)
          const gracePeriodMinutes = 15; // From system config
          const checkinTime = new Date(checkin.checkedInAt);
          const sessionStart = new Date(session.startedAt);
          const minutesLate = Math.floor((checkinTime - sessionStart) / 60000);

          status = minutesLate > gracePeriodMinutes ? "late" : "present";

          if (status === "present") presentCount++;
          else if (status === "late") lateCount++;
        } else {
          absentCount++;
        }

        attendanceRecords.push({
          sessionId,
          studentId: enrollment.studentId,
          status,
          submissionMethod: checkin ? checkin.submissionMethod : null,
          geofencePassed: checkin ? true : null,
          distanceM: checkin ? checkin.distanceM : null,
          checkinId: checkin ? checkin.id : null,
          markedAt: new Date(),
        });
      }

      // Create attendance records in batch
      await prisma.attendanceRecord.createMany({
        data: attendanceRecords,
      });

      // Update session status
      const updatedSession = await prisma.session.update({
        where: { id: sessionId },
        data: {
          checkinOpen: false,
          status: "closed",
          closedAt: new Date(),
          checkinsCount: session.roomCheckins.length,
        },
      });

      // Get system config for warnings
      const systemConfig = await prisma.systemConfig.findUnique({
        where: { id: "singleton" },
      });
      const warningThreshold =
        systemConfig?.consecutiveAbsenceWarningThreshold || 2;

      // Send notifications to students
      for (const record of attendanceRecords) {
        const enrollment = session.course.enrollments.find(
          (e) => e.studentId === record.studentId,
        );
        const student = enrollment.student;
        const preferences = student.notificationPref;

        if (record.status === "present" || record.status === "late") {
          if (preferences?.attendanceConfirmation !== false) {
            await sendEmail(
              student.email,
              "✅ Attendance Confirmation - AttendX",
              this.getAttendanceConfirmationEmail(
                student,
                session,
                record.status,
              ),
            );
          }
        } else if (record.status === "absent") {
          if (preferences?.missedAttendance !== false) {
            await sendEmail(
              student.email,
              "⚠️ Attendance Notice - AttendX",
              this.getAbsenceNoticeEmail(student, session),
            );
          }

          // Check for consecutive absences warning
          const recentAbsences = await prisma.attendanceRecord.count({
            where: {
              studentId: student.id,
              session: { courseId: session.courseId },
              status: "absent",
              markedAt: {
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
              },
            },
          });

          if (
            recentAbsences >= warningThreshold &&
            preferences?.absenceWarning !== false
          ) {
            await sendEmail(
              student.email,
              "⚠️ Attendance Warning - AttendX",
              this.getAttendanceWarningEmail(student, session, recentAbsences),
            );
          }
        }
      }

      // Remove from Redis cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`session:${sessionId}`);
        await redisClient.del(`session:${sessionId}:stats`);
      }

      // Emit WebSocket event
      if (io) {
        io.to(`session:${sessionId}`).emit("session-closed", {
          sessionId,
          summary: {
            totalEnrolled: session.course.enrollments.length,
            presentCount,
            lateCount,
            absentCount,
            checkinCount: session.roomCheckins.length,
          },
        });

        io.to(`course:${session.courseId}`).emit("session-ended", {
          sessionId,
          courseId: session.courseId,
          summary: {
            present: presentCount,
            late: lateCount,
            absent: absentCount,
          },
        });
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "CLOSE_SESSION",
          entity: "Session",
          entityId: sessionId,
          newValues: {
            presentCount,
            lateCount,
            absentCount,
            totalCheckins: session.roomCheckins.length,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Session closed: ${sessionId} by ${req.user.email}. Present: ${presentCount}, Late: ${lateCount}, Absent: ${absentCount}`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          totalEnrolled: session.course.enrollments.length,
          presentCount,
          lateCount,
          absentCount,
          totalCheckins: session.roomCheckins.length,
          attendanceRate:
            session.course.enrollments.length > 0
              ? ((presentCount + lateCount) /
                  session.course.enrollments.length) *
                100
              : 0,
          closedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("Close session error:", error);
      next(error);
    }
  }

  /**
   * Extend session duration
   * PATCH /api/v1/sessions/:sessionId/extend
   */
  async extendSession(req, res, next) {
    try {
      const { sessionId } = req.params;
      const { minutes } = req.body;

      if (!minutes || minutes <= 0 || minutes > 120) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Minutes must be between 1 and 120",
          },
        });
      }

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          lecturerId: req.user.id,
          status: "active",
        },
        include: {
          course: true,
          classroom: true,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Active session not found" },
        });
      }

      const newExpiresAt = new Date(session.expiresAt);
      newExpiresAt.setMinutes(newExpiresAt.getMinutes() + minutes);

      const updatedSession = await prisma.session.update({
        where: { id: sessionId },
        data: { expiresAt: newExpiresAt },
      });

      // Update Redis cache
      if (redisClient && redisClient.isReady) {
        const cached = await redisClient.get(`session:${sessionId}`);
        if (cached) {
          const sessionData = JSON.parse(cached);
          sessionData.expiresAt = newExpiresAt.toISOString();
          const ttl = Math.floor((newExpiresAt - new Date()) / 1000);
          if (ttl > 0) {
            await redisClient.setEx(
              `session:${sessionId}`,
              ttl,
              JSON.stringify(sessionData),
            );
          }
        }
      }

      // Emit WebSocket event
      if (io) {
        io.to(`session:${sessionId}`).emit("session-extended", {
          sessionId,
          additionalMinutes: minutes,
          newExpiresAt,
        });
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "EXTEND_SESSION",
          entity: "Session",
          entityId: sessionId,
          newValues: { additionalMinutes: minutes, newExpiresAt },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Session ${sessionId} extended by ${minutes} minutes by ${req.user.email}`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          previousExpiresAt: session.expiresAt,
          newExpiresAt,
          additionalMinutes: minutes,
        },
      });
    } catch (error) {
      logger.error("Extend session error:", error);
      next(error);
    }
  }

  /**
   * Get session statistics for lecturer dashboard
   * GET /api/v1/sessions/statistics
   */
  async getSessionStatistics(req, res, next) {
    try {
      const { courseId, period = "month" } = req.query;
      const lecturerId = req.user.id;

      let startDate = new Date();
      switch (period) {
        case "week":
          startDate.setDate(startDate.getDate() - 7);
          break;
        case "month":
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case "semester":
          startDate.setMonth(startDate.getMonth() - 6);
          break;
        default:
          startDate.setMonth(startDate.getMonth() - 1);
      }

      const where = {
        lecturerId,
        startedAt: { gte: startDate },
      };

      if (courseId) where.courseId = courseId;

      const sessions = await prisma.session.findMany({
        where,
        include: {
          course: true,
          roomCheckins: true,
          attendanceRecords: true,
        },
        orderBy: { startedAt: "desc" },
      });

      const statistics = {
        period,
        startDate,
        endDate: new Date(),
        totalSessions: sessions.length,
        averageAttendance: 0,
        totalCheckins: 0,
        sessionsByStatus: {
          active: sessions.filter((s) => s.status === "active").length,
          closed: sessions.filter((s) => s.status === "closed").length,
          expired: sessions.filter((s) => s.status === "expired").length,
        },
        dailyBreakdown: {},
        courseBreakdown: {},
      };

      for (const session of sessions) {
        const date = session.startedAt.toISOString().split("T")[0];
        if (!statistics.dailyBreakdown[date]) {
          statistics.dailyBreakdown[date] = {
            date,
            sessions: 0,
            checkins: 0,
            attendance: 0,
          };
        }
        statistics.dailyBreakdown[date].sessions++;
        statistics.dailyBreakdown[date].checkins += session.roomCheckins.length;

        const courseIdKey = session.course.id;
        if (!statistics.courseBreakdown[courseIdKey]) {
          statistics.courseBreakdown[courseIdKey] = {
            courseId: courseIdKey,
            courseName: session.course.name,
            courseCode: session.course.code,
            sessions: 0,
            totalCheckins: 0,
            totalAttendance: 0,
          };
        }
        statistics.courseBreakdown[courseIdKey].sessions++;
        statistics.courseBreakdown[courseIdKey].totalCheckins +=
          session.roomCheckins.length;
        statistics.courseBreakdown[courseIdKey].totalAttendance +=
          session.attendanceRecords.length;

        statistics.totalCheckins += session.roomCheckins.length;
      }

      // Calculate averages
      if (sessions.length > 0) {
        const totalAttendance = sessions.reduce(
          (sum, s) => sum + s.attendanceRecords.length,
          0,
        );
        statistics.averageAttendance = totalAttendance / sessions.length;
      }

      res.json({
        success: true,
        data: statistics,
      });
    } catch (error) {
      logger.error("Get session statistics error:", error);
      next(error);
    }
  }

  /**
   * Get active session for a course (for students)
   * GET /api/v1/sessions/active/course/:courseId
   */
  async getActiveSessionByCourse(req, res, next) {
    try {
      const { courseId } = req.params;
      const studentId = req.user.id;

      // Check enrollment
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId,
          isActive: true,
        },
      });

      if (!enrollment) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You are not enrolled in this course",
          },
        });
      }

      const session = await prisma.session.findFirst({
        where: {
          courseId,
          status: "active",
          checkinOpen: true,
        },
        include: {
          course: true,
          classroom: true,
          lecturer: {
            select: {
              id: true,
              fullName: true,
            },
          },
        },
      });

      if (!session) {
        return res.json({
          success: true,
          data: null,
          message: "No active session found for this course",
        });
      }

      // Check if student already checked in
      const checkin = await prisma.roomCheckin.findFirst({
        where: {
          sessionId: session.id,
          studentId,
        },
      });

      res.json({
        success: true,
        data: {
          ...session,
          hasCheckedIn: !!checkin,
          checkedInAt: checkin?.checkedInAt || null,
          timeRemaining: Math.max(
            0,
            Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
          ),
        },
      });
    } catch (error) {
      logger.error("Get active session by course error:", error);
      next(error);
    }
  }

  // Email template helpers
  getAttendanceConfirmationEmail(student, session, status) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333;">Attendance Confirmed ✓</h2>
          <p>Dear ${student.fullName},</p>
          <p>Your attendance has been confirmed for <strong>${session.course.name}</strong>.</p>
          <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Details:</strong></p>
            <ul>
              <li>Course: ${session.course.name} (${session.course.code})</li>
              <li>Status: ${status.toUpperCase()}</li>
              <li>Date: ${new Date(session.startedAt).toLocaleDateString()}</li>
              <li>Time: ${new Date(session.startedAt).toLocaleTimeString()}</li>
              <li>Location: ${session.classroom?.name || "Classroom"}</li>
            </ul>
          </div>
          <p>Thank you for your presence!</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }

  getAbsenceNoticeEmail(student, session) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #EF4444; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #EF4444;">Attendance Notice ⚠️</h2>
          <p>Dear ${student.fullName},</p>
          <p>You were marked <strong>absent</strong> for <strong>${session.course.name}</strong>.</p>
          <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Details:</strong></p>
            <ul>
              <li>Course: ${session.course.name} (${session.course.code})</li>
              <li>Date: ${new Date(session.startedAt).toLocaleDateString()}</li>
              <li>Time: ${new Date(session.startedAt).toLocaleTimeString()}</li>
              <li>Location: ${session.classroom?.name || "Classroom"}</li>
            </ul>
          </div>
          <p>If this is an error, please contact your lecturer.</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }

  getAttendanceWarningEmail(student, session, absenceCount) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #F59E0B; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #F59E0B;">Attendance Warning ⚠️</h2>
          <p>Dear ${student.fullName},</p>
          <p>You have been absent for <strong>${absenceCount} sessions</strong> in <strong>${session.course.name}</strong>.</p>
          <div style="background: #FFF3E0; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p>Please be aware that continued absences may affect your:</p>
            <ul>
              <li>Course progress and understanding</li>
              <li>Final grade (if attendance is required)</li>
              <li>Eligibility for exams (per course policy)</li>
            </ul>
          </div>
          <p>Please contact your lecturer to discuss your attendance.</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }
}

module.exports = new SessionController();
