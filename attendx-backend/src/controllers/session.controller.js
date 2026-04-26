const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { generateSessionCode } = require("../utils/helpers");
const { calculateDistance } = require("../utils/geofence");
const { sendPushNotification } = require("../services/notification.service");
const { sendEmail } = require("../services/email.service");

class SessionController {
  /**
   * Start a new attendance session
   * POST /api/sessions
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
            fields: errors.array(),
          },
        });
      }

      const { courseId, classroomId, durationMinutes = 90 } = req.body;

      // Check for existing active session
      const existingSession = await global.prisma.session.findFirst({
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
          },
        });
      }

      // Get course and classroom
      const course = await global.prisma.course.findUnique({
        where: { id: courseId },
        include: { lecturer: true },
      });

      const classroom = await global.prisma.classroom.findUnique({
        where: { id: classroomId },
      });

      if (!course || !classroom) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Course or classroom not found",
          },
        });
      }

      // Create session
      const sessionCode = await generateSessionCode(global.prisma);
      const expiresAt = new Date(Date.now() + durationMinutes * 60000);

      const session = await global.prisma.session.create({
        data: {
          sessionCode,
          courseId,
          classroomId,
          lecturerId: req.user.id,
          expiresAt,
          checkinOpen: true,
          status: "active",
        },
      });

      // Store in Redis for quick access
      await global.redis.setex(
        `session:${session.id}`,
        durationMinutes * 60,
        JSON.stringify({
          id: session.id,
          courseId,
          classroomId,
          latitude: classroom.latitude,
          longitude: classroom.longitude,
          radiusM: classroom.radiusM,
          checkinOpen: true,
        }),
      );

      // Get enrolled students with devices
      const enrollments = await global.prisma.enrollment.findMany({
        where: { courseId },
        include: {
          student: {
            include: {
              devices: true,
              notificationPref: true,
            },
          },
        },
      });

      // Send push notifications
      for (const enrollment of enrollments) {
        const devices = enrollment.student.devices.filter(
          (d) => d.fcmToken && d.isActive,
        );
        for (const device of devices) {
          if (enrollment.student.notificationPref?.sessionStarted !== false) {
            await sendPushNotification(device.fcmToken, {
              title: "📚 Attendance Session Started",
              body: `${course.name} in ${classroom.name} has started. Check in now!`,
              data: {
                sessionId: session.id,
                sessionCode,
                courseName: course.name,
                roomName: classroom.name,
              },
            });
          }
        }
      }

      // Emit WebSocket event
      if (global.io) {
        global.io.to(`course:${courseId}`).emit("session-started", {
          sessionId: session.id,
          sessionCode,
          courseName: course.name,
          roomName: classroom.name,
          expiresAt,
        });
      }

      logger.info(
        `Session started: ${session.id} for course ${course.name} by ${req.user.email}`,
      );

      res.status(201).json({
        success: true,
        data: {
          sessionId: session.id,
          sessionCode,
          roomName: classroom.name,
          courseName: course.name,
          expiresAt,
          checkinOpen: true,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List sessions
   * GET /api/sessions
   */
  async listSessions(req, res, next) {
    try {
      const { page = 1, limit = 20, courseId, status } = req.query;
      const skip = (page - 1) * limit;

      const where = {};

      if (req.user.role !== "admin") {
        where.lecturerId = req.user.id;
      }

      if (courseId) where.courseId = courseId;
      if (status) where.status = status;

      const [sessions, total] = await Promise.all([
        global.prisma.session.findMany({
          where,
          include: {
            course: true,
            classroom: true,
            lecturer: {
              select: { id: true, fullName: true, email: true },
            },
            _count: {
              select: { roomCheckins: true },
            },
          },
          orderBy: { startedAt: "desc" },
          skip: parseInt(skip),
          take: parseInt(limit),
        }),
        global.prisma.session.count({ where }),
      ]);

      // Add check-in counts
      const sessionsWithCounts = sessions.map((session) => ({
        ...session,
        checkinCount: session._count.roomCheckins,
        _count: undefined,
      }));

      res.json({
        success: true,
        data: sessionsWithCounts,
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
   * Get session details
   * GET /api/sessions/:sessionId
   */
  async getSession(req, res, next) {
    try {
      const { sessionId } = req.params;

      const session = await global.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          course: true,
          classroom: true,
          lecturer: {
            select: { id: true, fullName: true, email: true },
          },
          roomCheckins: {
            include: {
              student: {
                select: { id: true, fullName: true, regNumber: true },
              },
            },
            orderBy: { checkedInAt: "desc" },
          },
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }

      // Check access (lecturer can only see their own sessions)
      if (req.user.role !== "admin" && session.lecturerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have access to this session",
          },
        });
      }

      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Student check-in
   * POST /api/sessions/:sessionId/checkin
   */
  async checkIn(req, res, next) {
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

      const { sessionId } = req.params;
      const { latitude, longitude, deviceFingerprint } = req.body;

      // Get session from Redis cache
      let sessionData = await global.redis.get(`session:${sessionId}`);
      let session;

      if (sessionData) {
        sessionData = JSON.parse(sessionData);
        session = await global.prisma.session.findUnique({
          where: { id: sessionId },
          include: { course: true, classroom: true },
        });
      } else {
        session = await global.prisma.session.findUnique({
          where: { id: sessionId },
          include: { course: true, classroom: true },
        });

        if (session && session.checkinOpen) {
          // Cache for future requests
          await global.redis.setex(
            `session:${sessionId}`,
            300,
            JSON.stringify({
              id: session.id,
              courseId: session.courseId,
              classroomId: session.classroomId,
              latitude: session.classroom.latitude,
              longitude: session.classroom.longitude,
              radiusM: session.classroom.radiusM,
              checkinOpen: session.checkinOpen,
            }),
          );
        }
      }

      if (!session || !session.checkinOpen) {
        return res.json({
          success: true,
          data: {
            status: "session_closed",
            message: "Session is not active for check-in",
          },
        });
      }

      // Check enrollment
      const enrollment = await global.prisma.enrollment.findUnique({
        where: {
          studentId_courseId: {
            studentId: req.user.id,
            courseId: session.courseId,
          },
        },
      });

      if (!enrollment) {
        return res.json({
          success: true,
          data: {
            status: "not_enrolled",
            message: "You are not enrolled in this course",
          },
        });
      }

      // Check device
      const device = await global.prisma.device.findFirst({
        where: {
          deviceFingerprint,
          userId: req.user.id,
          isActive: true,
        },
      });

      if (!device) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Device not recognized" },
        });
      }

      // Check for duplicate check-in
      const existingCheckin = await global.prisma.roomCheckin.findUnique({
        where: {
          sessionId_studentId: {
            sessionId,
            studentId: req.user.id,
          },
        },
      });

      if (existingCheckin) {
        return res.json({
          success: true,
          data: {
            status: "already_checked_in",
            checkedInAt: existingCheckin.checkedInAt,
            message: "You have already checked in for this session",
          },
        });
      }

      // Calculate distance
      const distance = calculateDistance(
        session.classroom.latitude,
        session.classroom.longitude,
        latitude,
        longitude,
      );

      if (distance > session.classroom.radiusM) {
        return res.json({
          success: true,
          data: {
            status: "outside_geofence",
            distanceM: parseFloat(distance.toFixed(1)),
            message: `You are ${Math.round(distance)}m from the classroom. Move closer to check in.`,
          },
        });
      }

      // Create check-in
      const checkin = await global.prisma.roomCheckin.create({
        data: {
          sessionId,
          studentId: req.user.id,
          latitude,
          longitude,
          distanceM: distance,
          deviceFingerprint,
          submissionMethod: "app",
        },
        include: { student: true },
      });

      // Update session check-in count in Redis
      await global.redis.hincrby(
        `session:${sessionId}:stats`,
        "checkinCount",
        1,
      );

      // Emit WebSocket event
      if (global.io) {
        global.io.to(`session:${sessionId}`).emit("checkin", {
          sessionId,
          student: {
            id: req.user.id,
            fullName: checkin.student.fullName,
            regNumber: checkin.student.regNumber,
            method: "app",
          },
          distanceM: parseFloat(distance.toFixed(1)),
          checkedInAt: checkin.checkedInAt,
        });
      }

      logger.info(
        `Student ${req.user.email} checked in to session ${sessionId}`,
      );

      res.json({
        success: true,
        data: {
          status: "checked_in",
          distanceM: parseFloat(distance.toFixed(1)),
          checkedInAt: checkin.checkedInAt,
          message:
            "You have been checked in successfully. Attendance will be marked when the session closes.",
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Close session and finalize attendance
   * POST /api/sessions/:sessionId/close
   */
  async closeSession(req, res, next) {
    try {
      const { sessionId } = req.params;

      const session = await global.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          course: {
            include: {
              enrollments: {
                include: {
                  student: {
                    include: { notificationPref: true },
                  },
                },
              },
            },
          },
          roomCheckins: true,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }

      // Check access
      if (req.user.role !== "admin" && session.lecturerId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to close this session",
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

      // Close session
      await global.prisma.session.update({
        where: { id: sessionId },
        data: {
          checkinOpen: false,
          status: "closed",
          closedAt: new Date(),
        },
      });

      // Process attendance records
      const checkedInStudentIds = session.roomCheckins.map((c) => c.studentId);
      const attendanceRecords = [];
      let presentCount = 0;
      let absentCount = 0;

      for (const enrollment of session.course.enrollments) {
        const isPresent = checkedInStudentIds.includes(enrollment.studentId);
        if (isPresent) presentCount++;
        else absentCount++;

        attendanceRecords.push({
          sessionId,
          studentId: enrollment.studentId,
          status: isPresent ? "present" : "absent",
          submissionMethod: isPresent ? "app" : null,
          geofencePassed: isPresent ? true : null,
        });
      }

      await global.prisma.attendanceRecord.createMany({
        data: attendanceRecords,
      });

      // Send email notifications and check for warnings
      const systemConfig = await global.prisma.systemConfig.findUnique({
        where: { id: "singleton" },
      });
      const warningThreshold =
        systemConfig?.consecutiveAbsenceWarningThreshold || 2;

      for (const record of attendanceRecords) {
        const enrollment = session.course.enrollments.find(
          (e) => e.studentId === record.studentId,
        );
        const student = enrollment.student;
        const preferences = student.notificationPref;

        if (
          record.status === "present" &&
          preferences?.attendanceConfirmation !== false
        ) {
          await sendEmail(
            student.email,
            "✅ Attendance Confirmation - AttendX",
            `<div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #4F46E5;">Attendance Confirmed</h2>
              <p>Dear ${student.fullName},</p>
              <p>Your attendance has been confirmed for <strong>${session.course.name}</strong>.</p>
              <p><strong>Details:</strong></p>
              <ul>
                <li>Date: ${new Date(session.startedAt).toLocaleDateString()}</li>
                <li>Time: ${new Date(session.startedAt).toLocaleTimeString()}</li>
                <li>Location: ${session.classroom?.name || "Classroom"}</li>
              </ul>
              <p>Thank you for your presence!</p>
              <hr style="margin: 20px 0;" />
              <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
            </div>`,
          );
        } else if (
          record.status === "absent" &&
          preferences?.missedAttendance !== false
        ) {
          await sendEmail(
            student.email,
            "⚠️ Attendance Notice - AttendX",
            `<div style="font-family: Arial, sans-serif; max-width: 600px;">
              <h2 style="color: #EF4444;">Attendance Notice</h2>
              <p>Dear ${student.fullName},</p>
              <p>You were marked <strong>absent</strong> for <strong>${session.course.name}</strong>.</p>
              <p><strong>Details:</strong></p>
              <ul>
                <li>Date: ${new Date(session.startedAt).toLocaleDateString()}</li>
                <li>Time: ${new Date(session.startedAt).toLocaleTimeString()}</li>
              </ul>
              <p>If this is an error, please contact your lecturer.</p>
              <hr style="margin: 20px 0;" />
              <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
            </div>`,
          );

          // Check for consecutive absences
          const recentAbsences = await global.prisma.attendanceRecord.count({
            where: {
              studentId: student.id,
              session: { courseId: session.courseId },
              status: "absent",
              markedAt: {
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
              }, // Last 30 days
            },
          });

          if (
            recentAbsences >= warningThreshold &&
            preferences?.absenceWarning !== false
          ) {
            await sendEmail(
              student.email,
              "⚠️ Attendance Warning - AttendX",
              `<div style="font-family: Arial, sans-serif; max-width: 600px;">
                <h2 style="color: #F59E0B;">Attendance Warning</h2>
                <p>Dear ${student.fullName},</p>
                <p>You have been absent for <strong>${recentAbsences} sessions</strong> in <strong>${session.course.name}</strong>.</p>
                <p>Please contact your lecturer to discuss your attendance.</p>
                <hr style="margin: 20px 0;" />
                <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
              </div>`,
            );
          }
        }
      }

      // Remove from Redis
      await global.redis.del(`session:${sessionId}`);

      // Emit WebSocket event
      if (global.io) {
        global.io.to(`session:${sessionId}`).emit("sessionClosed", {
          sessionId,
          summary: {
            totalEnrolled: session.course.enrollments.length,
            presentCount,
            absentCount,
          },
        });
      }

      logger.info(
        `Session closed: ${sessionId} by ${req.user.email}. Present: ${presentCount}, Absent: ${absentCount}`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          totalEnrolled: session.course.enrollments.length,
          presentCount,
          absentCount,
          closedAt: new Date(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get live check-ins for session
   * GET /api/sessions/:sessionId/checkins
   */
  async getLiveCheckins(req, res, next) {
    try {
      const { sessionId } = req.params;

      const session = await global.prisma.session.findUnique({
        where: { id: sessionId },
        include: {
          course: {
            include: {
              enrollments: {
                select: { studentId: true },
              },
            },
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

      const checkins = await global.prisma.roomCheckin.findMany({
        where: { sessionId },
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
      });

      res.json({
        success: true,
        data: {
          sessionId,
          checkinOpen: session.checkinOpen,
          totalEnrolled: session.course.enrollments.length,
          checkins: checkins.map((c) => ({
            id: c.student.id,
            regNumber: c.student.regNumber,
            fullName: c.student.fullName,
            email: c.student.email,
            checkedInAt: c.checkedInAt,
            distanceM: c.distanceM,
            method: c.submissionMethod,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new SessionController();
