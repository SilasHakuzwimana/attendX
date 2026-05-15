const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient, io } = require("../index");
const {
  calculateDistance,
  validateGeofence,
} = require("../services/geofence.service");
const { sendPushNotification } = require("../services/notification.service");

class CheckinController {
  /**
   * Student check-in to session with GPS validation
   * POST /api/v1/sessions/:sessionId/checkin
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
            details: errors.array(),
          },
        });
      }

      const { sessionId } = req.params;
      const { latitude, longitude, deviceFingerprint } = req.body;
      const studentId = req.user.id;

      // Validate required fields
      if (!latitude || !longitude) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Latitude and longitude are required",
          },
        });
      }

      if (!deviceFingerprint) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Device fingerprint is required",
          },
        });
      }

      // Step 1: Verify device is registered and active
      const device = await prisma.device.findFirst({
        where: {
          fingerprint: deviceFingerprint,
          userId: studentId,
          isActive: true,
        },
      });

      if (!device) {
        logger.warn(
          `Check-in failed: Device not recognized for student ${studentId}`,
        );
        return res.status(403).json({
          success: false,
          error: {
            code: "DEVICE_NOT_RECOGNIZED",
            message:
              "Device not recognized or inactive. Please register your device first.",
          },
        });
      }

      // Update device last seen
      await prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });

      // Step 2: Get session from cache or database
      let sessionData;
      const cachedSession = await redisClient?.get(`session:${sessionId}`);

      if (cachedSession) {
        sessionData = JSON.parse(cachedSession);
      } else {
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: {
            classroom: true,
            course: true,
          },
        });

        if (session) {
          sessionData = {
            id: session.id,
            sessionCode: session.sessionCode,
            courseId: session.courseId,
            courseName: session.course.name,
            classroomId: session.classroomId,
            classroomName: session.classroom.name,
            classroomLat: session.classroom.latitude,
            classroomLng: session.classroom.longitude,
            radiusM: session.classroom.radiusM,
            expiresAt: session.expiresAt,
            checkinOpen: session.checkinOpen,
            status: session.status,
            durationMinutes: session.durationMinutes,
          };
        }
      }

      if (!sessionData) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Session not found",
          },
        });
      }

      // Step 3: Check if session is active and open for check-in
      if (sessionData.status !== "active") {
        return res.status(400).json({
          success: false,
          error: {
            code: "SESSION_INACTIVE",
            message: "Session is not active",
          },
        });
      }

      if (!sessionData.checkinOpen) {
        return res.status(400).json({
          success: false,
          error: {
            code: "CHECKIN_CLOSED",
            message: "Check-in is closed for this session",
          },
        });
      }

      // Step 4: Check if session has expired
      const now = new Date();
      const expiresAt = new Date(sessionData.expiresAt);

      if (now > expiresAt) {
        // Auto-close expired session
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            status: "expired",
            checkinOpen: false,
          },
        });

        return res.status(400).json({
          success: false,
          error: {
            code: "SESSION_EXPIRED",
            message: "Session has expired",
          },
        });
      }

      // Step 5: Verify student is enrolled in the course
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId: sessionData.courseId,
          isActive: true,
        },
      });

      if (!enrollment) {
        logger.warn(
          `Check-in failed: Student ${studentId} not enrolled in course ${sessionData.courseId}`,
        );
        return res.status(403).json({
          success: false,
          error: {
            code: "NOT_ENROLLED",
            message: "You are not enrolled in this course",
          },
        });
      }

      // Step 6: Check for duplicate check-in
      const existingCheckin = await prisma.roomCheckin.findFirst({
        where: {
          sessionId,
          studentId,
        },
      });

      if (existingCheckin) {
        return res.status(409).json({
          success: false,
          error: {
            code: "ALREADY_CHECKED_IN",
            message: "You have already checked in to this session",
            data: {
              checkedInAt: existingCheckin.checkedInAt,
              status: existingCheckin.status,
            },
          },
        });
      }

      // Step 7: Calculate distance and validate geofence
      const distance = calculateDistance(
        parseFloat(latitude),
        parseFloat(longitude),
        parseFloat(sessionData.classroomLat),
        parseFloat(sessionData.classroomLng),
      );

      const geofenceResult = validateGeofence(
        parseFloat(latitude),
        parseFloat(longitude),
        parseFloat(sessionData.classroomLat),
        parseFloat(sessionData.classroomLng),
        sessionData.radiusM,
      );

      // Step 8: Determine check-in status based on distance and time
      let checkinStatus = "present";
      const gracePeriodMinutes = 15; // Can be from system config
      const sessionStartMinutes =
        Math.floor((now - new Date(sessionData.expiresAt)) / 60000) +
        sessionData.durationMinutes;

      if (!geofenceResult.isValid) {
        return res.status(400).json({
          success: false,
          error: {
            code: "OUTSIDE_GEOFENCE",
            message: `You are ${Math.round(distance)}m away. Must be within ${sessionData.radiusM}m of the classroom.`,
            data: {
              distanceM: Math.round(distance),
              requiredRadiusM: sessionData.radiusM,
              classroomLat: sessionData.classroomLat,
              classroomLng: sessionData.classroomLng,
            },
          },
        });
      }

      // Check if student is late (after grace period)
      if (sessionStartMinutes > gracePeriodMinutes) {
        checkinStatus = "late";
      }

      // Step 9: Create check-in record
      const checkin = await prisma.roomCheckin.create({
        data: {
          sessionId,
          studentId,
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          distanceM: distance,
          deviceFingerprint,
          submissionMethod: "app",
          checkedInAt: new Date(),
        },
        include: {
          session: {
            include: {
              course: true,
              classroom: true,
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
      });

      // Step 10: Create or update attendance record
      const attendanceRecord = await prisma.attendanceRecord.upsert({
        where: {
          sessionId_studentId: {
            sessionId,
            studentId,
          },
        },
        update: {
          status: checkinStatus,
          submissionMethod: "app",
          geofencePassed: geofenceResult.isValid,
          distanceM: distance,
          markedAt: new Date(),
        },
        create: {
          sessionId,
          studentId,
          status: checkinStatus,
          submissionMethod: "app",
          geofencePassed: geofenceResult.isValid,
          distanceM: distance,
          checkinId: checkin.id,
          markedAt: new Date(),
        },
      });

      // Step 11: Update session check-in count
      await prisma.session.update({
        where: { id: sessionId },
        data: {
          checkinsCount: {
            increment: 1,
          },
        },
      });

      // Step 12: Update Redis counter
      if (redisClient && redisClient.isReady) {
        await redisClient.hIncrBy(`session:${sessionId}:stats`, "checkins", 1);
        await redisClient.hSet(
          `session:${sessionId}:stats`,
          `student:${studentId}`,
          JSON.stringify({
            checkedInAt: checkin.checkedInAt,
            distance,
            status: checkinStatus,
          }),
        );
      }

      // Step 13: Emit real-time event via Socket.IO
      if (io) {
        io.to(`session:${sessionId}`).emit("checkin", {
          sessionId,
          studentId,
          studentName: req.user.fullName,
          regNumber: req.user.regNumber,
          checkedInAt: checkin.checkedInAt,
          status: checkinStatus,
          distanceM: Math.round(distance),
        });

        io.to(`course:${sessionData.courseId}`).emit("student-checked-in", {
          sessionId,
          studentId,
          studentName: req.user.fullName,
          timestamp: checkin.checkedInAt,
        });
      }

      // Step 14: Invalidate student caches
      if (redisClient && redisClient.isReady) {
        const cacheKeys = [
          `student:dashboard:${studentId}`,
          `student:summary:${studentId}`,
          `student:attendance:${studentId}`,
          `student:active-sessions:${studentId}`,
        ];

        for (const key of cacheKeys) {
          await redisClient.del(key);
        }
      }

      // Step 15: Send confirmation notification
      await this.sendCheckinConfirmation(checkin, checkinStatus, distance);

      logger.info(
        `Student ${studentId} checked into session ${sessionId} from ${Math.round(distance)}m away - Status: ${checkinStatus}`,
      );

      res.json({
        success: true,
        data: {
          status: "checked_in",
          checkinStatus,
          distanceM: Math.round(distance),
          checkedInAt: checkin.checkedInAt,
          sessionCode: sessionData.sessionCode,
          courseName: sessionData.courseName,
          classroomName: sessionData.classroomName,
          message:
            checkinStatus === "late"
              ? "Checked in successfully but you are late"
              : "Checked in successfully",
        },
      });
    } catch (error) {
      logger.error("Check-in error:", error);
      next(error);
    }
  }

  /**
   * Get check-in status for a session
   * GET /api/v1/sessions/:sessionId/checkin-status
   */
  async getCheckinStatus(req, res, next) {
    try {
      const { sessionId } = req.params;
      const studentId = req.user.id;

      const checkin = await prisma.roomCheckin.findFirst({
        where: {
          sessionId,
          studentId,
        },
        include: {
          session: {
            include: {
              course: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                },
              },
            },
          },
        },
      });

      if (!checkin) {
        return res.json({
          success: true,
          data: {
            hasCheckedIn: false,
            message: "You haven't checked in to this session yet",
          },
        });
      }

      res.json({
        success: true,
        data: {
          hasCheckedIn: true,
          checkedInAt: checkin.checkedInAt,
          status: checkin.status,
          distanceM: checkin.distanceM,
          submissionMethod: checkin.submissionMethod,
          session: {
            id: checkin.session.id,
            sessionCode: checkin.session.sessionCode,
            courseName: checkin.session.course.name,
          },
        },
      });
    } catch (error) {
      logger.error("Get check-in status error:", error);
      next(error);
    }
  }

  /**
   * Get all check-ins for a session (Lecturer only)
   * GET /api/v1/sessions/:sessionId/checkins
   */
  async getSessionCheckins(req, res, next) {
    try {
      const { sessionId } = req.params;
      const { page = 1, limit = 50, status } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Verify lecturer owns this session
      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          lecturerId: req.user.id,
        },
      });

      if (!session && req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You don't have access to this session",
          },
        });
      }

      const where = { sessionId };
      if (status) where.status = status;

      const [checkins, total] = await Promise.all([
        prisma.roomCheckin.findMany({
          where,
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
          orderBy: { checkedInAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.roomCheckin.count({ where }),
      ]);

      // Get total enrolled students for this session's course
      const enrolledCount = await prisma.enrollment.count({
        where: {
          courseId: session.courseId,
          isActive: true,
        },
      });

      res.json({
        success: true,
        data: {
          checkins,
          statistics: {
            totalCheckedIn: total,
            totalEnrolled: enrolledCount,
            checkinRate: enrolledCount > 0 ? (total / enrolledCount) * 100 : 0,
          },
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / parseInt(limit)),
          },
        },
      });
    } catch (error) {
      logger.error("Get session check-ins error:", error);
      next(error);
    }
  }

  /**
   * Get nearby active sessions for student
   * GET /api/v1/checkin/nearby
   */
  async getNearbySessions(req, res, next) {
    try {
      const { latitude, longitude, radius = 500 } = req.query;
      const studentId = req.user.id;

      if (!latitude || !longitude) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Latitude and longitude are required",
          },
        });
      }

      // Get student's enrolled courses
      const enrollments = await prisma.enrollment.findMany({
        where: { studentId, isActive: true },
        select: { courseId: true },
      });

      const courseIds = enrollments.map((e) => e.courseId);

      if (courseIds.length === 0) {
        return res.json({
          success: true,
          data: [],
          message: "You are not enrolled in any courses",
        });
      }

      // Get active sessions
      const sessions = await prisma.session.findMany({
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
            select: {
              id: true,
              fullName: true,
            },
          },
        },
      });

      // Calculate distance to each session and filter by radius
      const nearbySessions = [];
      for (const session of sessions) {
        const distance = calculateDistance(
          parseFloat(latitude),
          parseFloat(longitude),
          parseFloat(session.classroom.latitude),
          parseFloat(session.classroom.longitude),
        );

        if (distance <= radius) {
          const hasCheckedIn = await prisma.roomCheckin.findFirst({
            where: {
              sessionId: session.id,
              studentId,
            },
          });

          nearbySessions.push({
            ...session,
            distanceM: Math.round(distance),
            withinGeofence: distance <= session.classroom.radiusM,
            hasCheckedIn: !!hasCheckedIn,
            timeRemaining: Math.max(
              0,
              Math.floor((new Date(session.expiresAt) - new Date()) / 60000),
            ),
          });
        }
      }

      // Sort by distance
      nearbySessions.sort((a, b) => a.distanceM - b.distanceM);

      res.json({
        success: true,
        data: nearbySessions,
        meta: {
          total: nearbySessions.length,
          radius,
          timestamp: new Date(),
        },
      });
    } catch (error) {
      logger.error("Get nearby sessions error:", error);
      next(error);
    }
  }

  /**
   * Manual check-in for lecturer/admin (for absent students)
   * POST /api/v1/sessions/:sessionId/manual-checkin
   */
  async manualCheckin(req, res, next) {
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

      const { sessionId } = req.params;
      const { studentId, status = "present", reason } = req.body;

      // Verify lecturer/admin has permission
      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          ...(req.user.role !== "admin" && { lecturerId: req.user.id }),
        },
        include: { course: true },
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

      // Verify student is enrolled
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId,
          courseId: session.courseId,
          isActive: true,
        },
        include: {
          student: true,
        },
      });

      if (!enrollment) {
        return res.status(400).json({
          success: false,
          error: {
            code: "NOT_ENROLLED",
            message: "Student is not enrolled in this course",
          },
        });
      }

      // Check if already checked in
      const existingCheckin = await prisma.roomCheckin.findFirst({
        where: {
          sessionId,
          studentId,
        },
      });

      let checkin;
      let attendanceRecord;

      if (existingCheckin) {
        // Update existing
        attendanceRecord = await prisma.attendanceRecord.update({
          where: {
            sessionId_studentId: {
              sessionId,
              studentId,
            },
          },
          data: {
            status,
            overriddenAt: new Date(),
            overriddenBy: req.user.id,
            overrideReason: reason,
          },
        });
      } else {
        // Create new manual check-in
        checkin = await prisma.roomCheckin.create({
          data: {
            sessionId,
            studentId,
            latitude: 0,
            longitude: 0,
            distanceM: 0,
            deviceFingerprint: "manual",
            submissionMethod: "manual",
            checkedInAt: new Date(),
          },
        });

        attendanceRecord = await prisma.attendanceRecord.create({
          data: {
            sessionId,
            studentId,
            status,
            submissionMethod: "manual",
            geofencePassed: true,
            distanceM: 0,
            checkinId: checkin.id,
            markedAt: new Date(),
            overriddenBy: req.user.id,
            overrideReason: reason,
          },
        });

        // Update session check-in count
        await prisma.session.update({
          where: { id: sessionId },
          data: {
            checkinsCount: {
              increment: 1,
            },
          },
        });
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "MANUAL_CHECKIN",
          entity: "AttendanceRecord",
          entityId: attendanceRecord.id,
          newValues: { studentId, status, reason },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Send notification to student
      await this.sendManualCheckinNotification(
        enrollment.student,
        session,
        status,
        reason,
      );

      logger.info(
        `Manual check-in by ${req.user.email} for student ${studentId} in session ${sessionId} - Status: ${status}`,
      );

      res.json({
        success: true,
        data: {
          studentId,
          studentName: enrollment.student.fullName,
          status,
          reason,
          message: `Manual check-in completed for ${enrollment.student.fullName}`,
        },
      });
    } catch (error) {
      logger.error("Manual check-in error:", error);
      next(error);
    }
  }

  /**
   * Get check-in statistics for lecturer dashboard
   * GET /api/v1/checkin/statistics
   */
  async getCheckinStatistics(req, res, next) {
    try {
      const { courseId, date } = req.query;
      const targetDate = date ? new Date(date) : new Date();
      targetDate.setHours(0, 0, 0, 0);

      let where = {};

      if (req.user.role === "lecturer") {
        where = {
          lecturerId: req.user.id,
          ...(courseId && { id: courseId }),
        };
      } else if (courseId) {
        where = { id: courseId };
      }

      const courses = await prisma.course.findMany({
        where,
        select: { id: true, name: true, code: true },
      });

      const courseIds = courses.map((c) => c.id);

      const sessions = await prisma.session.findMany({
        where: {
          courseId: { in: courseIds },
          startedAt: {
            gte: targetDate,
            lt: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000),
          },
        },
        include: {
          checkins: true,
          course: true,
        },
      });

      const statistics = sessions.map((session) => ({
        sessionId: session.id,
        sessionCode: session.sessionCode,
        courseName: session.course.name,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        totalCheckins: session.checkins.length,
        status: session.status,
        checkinRate:
          session.checkins.length > 0
            ? (session.checkins.length / session.checkins.length) * 100
            : 0,
      }));

      res.json({
        success: true,
        data: {
          date: targetDate,
          totalSessions: sessions.length,
          totalCheckins: sessions.reduce(
            (sum, s) => sum + s.checkins.length,
            0,
          ),
          sessions: statistics,
        },
      });
    } catch (error) {
      logger.error("Get check-in statistics error:", error);
      next(error);
    }
  }

  /**
   * Send check-in confirmation notification
   */
  async sendCheckinConfirmation(checkin, status, distance) {
    try {
      const message =
        status === "late"
          ? `You checked in late for ${checkin.session.course.name}. Distance: ${Math.round(distance)}m`
          : `Successfully checked in to ${checkin.session.course.name}. Distance: ${Math.round(distance)}m`;

      // Email notification
      await sendEmail(
        checkin.student.email,
        "✅ Check-in Confirmation - AttendX",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #4CAF50; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">Check-in Confirmed</h1>
          </div>
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2>${checkin.session.course.name}</h2>
            <p><strong>Status:</strong> ${status.toUpperCase()}</p>
            <p><strong>Time:</strong> ${checkin.checkedInAt.toLocaleString()}</p>
            <p><strong>Location:</strong> ${checkin.session.classroom.name}</p>
            <p><strong>Distance from classroom:</strong> ${Math.round(distance)}m</p>
            <hr />
            <p style="color: #666;">Thank you for using AttendX!</p>
          </div>
        </div>
        `,
      );

      // Push notification
      const devices = await prisma.device.findMany({
        where: {
          userId: checkin.studentId,
          isActive: true,
          fcmToken: { not: null },
        },
      });

      for (const device of devices) {
        await sendPushNotification(device.fcmToken, {
          title: "Check-in Successful",
          body: message,
          data: {
            type: "checkin_confirmation",
            sessionId: checkin.sessionId,
            courseName: checkin.session.course.name,
            status,
          },
        });
      }
    } catch (error) {
      logger.error("Send check-in confirmation error:", error);
    }
  }

  /**
   * Send manual check-in notification
   */
  async sendManualCheckinNotification(student, session, status, reason) {
    try {
      await sendEmail(
        student.email,
        "📋 Manual Attendance Record - AttendX",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #2196F3; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">Manual Attendance Record</h1>
          </div>
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2>${session.course.name}</h2>
            <p><strong>Status:</strong> ${status.toUpperCase()}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
            <hr />
            <p style="color: #666;">This attendance was recorded manually by your lecturer.</p>
          </div>
        </div>
        `,
      );
    } catch (error) {
      logger.error("Send manual check-in notification error:", error);
    }
  }
}

module.exports = new CheckinController();
