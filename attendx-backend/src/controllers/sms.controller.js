const { validationResult, body } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const rateLimit = require("express-rate-limit");
const { sendEmail } = require("../services/email.service");

class SMSService {
  constructor() {
    this.twilio = null;
    this.initialized = false;
    this.initTwilio();
  }

  initTwilio() {
    try {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        const twilio = require('twilio');
        this.twilio = twilio;
        this.client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );
        this.initialized = true;
        logger.info("Twilio SMS service initialized");
      } else {
        logger.warn("Twilio credentials not found. SMS service disabled.");
      }
    } catch (error) {
      logger.error("Failed to initialize Twilio:", error);
    }
  }

  async sendSMS(to, message) {
    if (!this.initialized) {
      throw new Error("SMS service not configured");
    }

    try {
      const result = await this.client.messages.create({
        body: message,
        to: to,
        from: process.env.TWILIO_PHONE_NUMBER,
      });
      return result;
    } catch (error) {
      logger.error("SMS sending failed:", error);
      throw error;
    }
  }

  async sendAttendanceConfirmation(to, studentName, courseName) {
    const message = `✅ ${studentName}, you have been checked into ${courseName}. Thank you for using AttendX!`;
    return this.sendSMS(to, message);
  }
}

// Rate limiter for SMS webhook
const smsRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // 3 SMS per minute per phone number
  keyGenerator: (req) => req.body.From || req.body.from || req.ip,
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many SMS requests. Please wait a minute before trying again.",
    },
  },
});

// Validation rules for SMS webhook
const validateSmsWebhook = [
  body("From").notEmpty().withMessage("From number is required"),
  body("Body").notEmpty().withMessage("Message body is required"),
  body("MessageSid").optional(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn("SMS validation failed:", errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    next();
  },
];

// Helper to normalize phone number to E.164 format
const normalizePhoneNumber = (phoneNumber) => {
  if (!phoneNumber) return null;
  
  // Remove any whitespace
  let cleaned = phoneNumber.trim();

  // If number doesn't start with '+', add it
  if (!cleaned.startsWith("+")) {
    // Remove any non-digit characters
    cleaned = cleaned.replace(/\D/g, "");

    // Remove leading zero if present
    if (cleaned.startsWith("0")) {
      cleaned = cleaned.substring(1);
    }

    // Add country code (default to Rwanda +250 if not present)
    if (cleaned.length <= 9) {
      cleaned = "250" + cleaned;
    }

    cleaned = "+" + cleaned;
  }

  return cleaned;
};

class SMSController {
  constructor() {
    this.smsService = new SMSService();
  }

  /**
   * Handle incoming SMS webhook from Twilio
   * POST /api/v1/sms/webhook
   */
  async handleIncomingSMS(req, res, next) {
    try {
      // Apply rate limiting
      await new Promise((resolve, reject) => {
        smsRateLimit(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Twilio sends form-urlencoded data
      const { From, Body, MessageSid, To, SmsStatus } = req.body;

      // Normalize phone number
      const normalizedFrom = normalizePhoneNumber(From);

      if (!normalizedFrom) {
        logger.warn("SMS received without valid from number");
        return this.sendTwimlResponse(res, "Unable to identify sender number", false);
      }

      logger.info(`Received SMS from ${normalizedFrom}: ${Body}`);

      // Validate Twilio signature (skip in development)
      if (process.env.NODE_ENV === "production" && !this.validateTwilioSignature(req)) {
        logger.warn(`Invalid Twilio signature from ${normalizedFrom}`);
        return this.sendTwimlResponse(res, "Security validation failed", false);
      }

      // Log incoming message
      await prisma.auditLog.create({
        data: {
          action: "SMS_RECEIVED",
          entity: "SMS",
          newValues: { from: normalizedFrom, body: Body, messageSid: MessageSid },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Parse the SMS body
      const parsed = this.parseSMSBody(Body);

      if (!parsed.isValid) {
        logger.info(`Invalid SMS format from ${normalizedFrom}: ${Body}`);
        return this.sendTwimlResponse(
          res,
          this.getHelpMessage(),
          false
        );
      }

      const { action, sessionCode } = parsed;

      // Handle different commands
      switch (action) {
        case "ATTEND":
          await this.processAttendanceCheckin(normalizedFrom, sessionCode, res);
          break;
        case "HELP":
          this.sendTwimlResponse(res, this.getHelpMessage(), true);
          break;
        case "STATUS":
          await this.sendAttendanceStatus(normalizedFrom, res);
          break;
        case "COURSES":
          await this.sendEnrolledCourses(normalizedFrom, res);
          break;
        case "NEXT":
          await this.sendNextSession(normalizedFrom, res);
          break;
        default:
          this.sendTwimlResponse(res, this.getHelpMessage(), false);
      }
    } catch (error) {
      if (error.message && error.message.includes("rate limit")) {
        return this.sendTwimlResponse(
          res,
          "⚠️ Too many requests. Please wait a minute before sending another message.",
          false
        );
      }

      logger.error("SMS webhook error:", error);
      this.sendTwimlResponse(
        res,
        "⚠️ System error. Please try again later or contact your lecturer.",
        false
      );
    }
  }

  /**
   * Process attendance check-in via SMS
   */
  async processAttendanceCheckin(phoneNumber, sessionCode, res) {
    try {
      // 1. Find user by phone number
      const user = await prisma.user.findFirst({
        where: {
          phone: phoneNumber,
          role: "student",
          isActive: true,
        },
        include: {
          notificationPref: true,
        },
      });

      if (!user) {
        logger.warn(`Unknown phone number attempted check-in: ${phoneNumber}`);
        await this.logFailedAttempt(phoneNumber, sessionCode, "UNKNOWN_USER");
        return this.sendTwimlResponse(
          res,
          "❌ Phone number not recognized. Please contact your lecturer to register your number for SMS attendance.\n\nSend HELP for available commands.",
          false
        );
      }

      // 2. Validate session code format
      if (!/^[A-Z0-9]{5,6}$/.test(sessionCode)) {
        logger.info(`Invalid session code format from ${phoneNumber}: ${sessionCode}`);
        return this.sendTwimlResponse(
          res,
          "❌ Invalid session code format. Session codes are 5-6 characters (letters and numbers).\nExample: ATTEND AB3X9K",
          false
        );
      }

      // Check cache for active session first
      let session = null;
      let fromCache = false;
      
      if (redisClient && redisClient.isReady) {
        const cachedSession = await redisClient.get(`session:code:${sessionCode}`);
        if (cachedSession) {
          session = JSON.parse(cachedSession);
          fromCache = true;
        }
      }

      if (!session) {
        // 3. Find active session by code
        session = await prisma.session.findFirst({
          where: {
            sessionCode: sessionCode,
            status: "active",
            checkinOpen: true,
            expiresAt: { gt: new Date() },
          },
          include: {
            course: {
              select: {
                id: true,
                name: true,
                code: true,
              }
            },
            classroom: {
              select: {
                name: true,
                building: true,
              }
            },
          },
        });

        // Cache for 5 minutes if found
        if (session && redisClient && redisClient.isReady) {
          await redisClient.setEx(`session:code:${sessionCode}`, 300, JSON.stringify(session));
        }
      }

      if (!session) {
        logger.info(`Invalid or expired session code from ${phoneNumber}: ${sessionCode}`);
        await this.logFailedAttempt(phoneNumber, sessionCode, "INVALID_CODE");
        return this.sendTwimlResponse(
          res,
          "❌ Invalid or expired session code. Please check with your lecturer for the correct code.\n\nSend HELP for assistance.",
          false
        );
      }

      // 4. Check if student is enrolled
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId: user.id,
          courseId: session.course.id,
          isActive: true,
        },
      });

      if (!enrollment) {
        logger.warn(`Non-enrolled student attempted check-in: ${user.email} for course ${session.course.id}`);
        await this.logFailedAttempt(phoneNumber, sessionCode, "NOT_ENROLLED", user.id);
        return this.sendTwimlResponse(
          res,
          `❌ You are not enrolled in ${session.course.name}. Please contact your lecturer to be added to the course.`,
          false
        );
      }

      // 5. Check for duplicate check-in
      const existingCheckin = await prisma.roomCheckin.findFirst({
        where: {
          sessionId: session.id,
          studentId: user.id,
        },
      });

      if (existingCheckin) {
        const checkinTime = existingCheckin.checkedInAt.toLocaleTimeString();
        const date = existingCheckin.checkedInAt.toLocaleDateString();
        return this.sendTwimlResponse(
          res,
          `ℹ️ You have already checked in for ${session.course.name} on ${date} at ${checkinTime}.\nDuplicate check-ins are not allowed.`,
          true
        );
      }

      // 6. Determine if late (session started more than 15 minutes ago)
      const sessionStart = new Date(session.startedAt);
      const now = new Date();
      const minutesSinceStart = Math.floor((now - sessionStart) / 60000);
      const isLate = minutesSinceStart > 15;
      const attendanceStatus = isLate ? "late" : "present";

      // 7. Create check-in record (SMS submission)
      const checkin = await prisma.roomCheckin.create({
        data: {
          sessionId: session.id,
          studentId: user.id,
          latitude: 0,
          longitude: 0,
          distanceM: null,
          deviceFingerprint: "sms",
          submissionMethod: "sms",
          checkedInAt: new Date(),
        },
      });

      // 8. Create or update attendance record
      const attendanceRecord = await prisma.attendanceRecord.upsert({
        where: {
          sessionId_studentId: {
            sessionId: session.id,
            studentId: user.id,
          },
        },
        update: {
          status: attendanceStatus,
          submissionMethod: "sms",
          markedAt: new Date(),
        },
        create: {
          sessionId: session.id,
          studentId: user.id,
          status: attendanceStatus,
          submissionMethod: "sms",
          geofencePassed: null,
          checkinId: checkin.id,
          markedAt: new Date(),
        },
      });

      // 9. Update session check-in count
      await prisma.session.update({
        where: { id: session.id },
        data: {
          checkinsCount: { increment: 1 },
        },
      });

      // 10. Invalidate caches
      if (redisClient && redisClient.isReady) {
        await redisClient.del(`student:dashboard:${user.id}`);
        await redisClient.del(`student:summary:${user.id}`);
        await redisClient.del(`session:${session.id}:stats`);
      }

      // 11. Send confirmation SMS
      const statusEmoji = isLate ? "⏰" : "✅";
      const statusText = isLate ? "checked in (late)" : "checked in";
      
      await this.smsService.sendSMS(
        phoneNumber,
        `${statusEmoji} ${user.fullName}, you have been ${statusText} to ${session.course.name}. ${isLate ? 'Please try to be on time for future sessions.' : 'Thank you!'}`
      );

      // 12. Send email notification if enabled
      if (user.notificationPref?.attendanceConfirmation !== false) {
        await sendEmail(
          user.email,
          `${attendanceStatus === "present" ? "✅" : "⏰"} Attendance Confirmed via SMS - AttendX`,
          this.getAttendanceConfirmationEmail(user, session, attendanceStatus)
        );
      }

      // 13. Emit WebSocket event for live dashboard
      if (global.io) {
        global.io.to(`session:${session.id}`).emit("checkin", {
          sessionId: session.id,
          student: {
            id: user.id,
            fullName: user.fullName,
            regNumber: user.regNumber,
            method: "sms",
            phone: phoneNumber,
          },
          checkedInAt: checkin.checkedInAt,
          status: attendanceStatus,
        });
      }

      // 14. Log successful check-in
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "SMS_CHECKIN",
          entity: "RoomCheckin",
          entityId: checkin.id,
          newValues: { sessionCode, courseId: session.course.id, status: attendanceStatus },
          ipAddress: req.ip,
          userAgent: "SMS",
        },
      });

      logger.info(`✅ SMS check-in successful: ${user.email} (${phoneNumber}) for session ${session.id} - Course: ${session.course.name} - Status: ${attendanceStatus}`);

      // 15. Send success response
      const lateWarning = isLate ? " You were marked as late. Please arrive earlier for future sessions." : "";
      this.sendTwimlResponse(
        res,
        `${statusEmoji} Attendance recorded for ${session.course.name}, ${user.fullName}!${lateWarning}\n\nA confirmation email has been sent to ${user.email}.`,
        true
      );
    } catch (error) {
      logger.error("Error processing SMS check-in:", error);
      this.sendTwimlResponse(
        res,
        "⚠️ Error processing your request. Please try again or contact your lecturer.\n\nSend HELP for assistance.",
        false
      );
    }
  }

  /**
   * Send attendance status for a student
   */
  async sendAttendanceStatus(phoneNumber, res) {
    try {
      const user = await prisma.user.findFirst({
        where: { phone: phoneNumber, role: "student", isActive: true },
        include: { notificationPref: true },
      });

      if (!user) {
        return this.sendTwimlResponse(
          res,
          "❌ Phone number not recognized. Please contact your lecturer to register your number.\n\nSend HELP for available commands.",
          false
        );
      }

      // Get attendance statistics
      const [totalRecords, presentRecords, lateRecords, absentRecords] = await Promise.all([
        prisma.attendanceRecord.count({ where: { studentId: user.id } }),
        prisma.attendanceRecord.count({ where: { studentId: user.id, status: "present" } }),
        prisma.attendanceRecord.count({ where: { studentId: user.id, status: "late" } }),
        prisma.attendanceRecord.count({ where: { studentId: user.id, status: "absent" } })
      ]);

      if (totalRecords === 0) {
        return this.sendTwimlResponse(
          res,
          `📊 No attendance records found for ${user.fullName}. Start attending classes to build your record!\n\nSend HELP for commands.`,
          true
        );
      }

      const attended = presentRecords + lateRecords;
      const attendanceRate = ((attended / totalRecords) * 100).toFixed(1);

      // Get recent attendance (last 5 sessions)
      const recentAttendance = await prisma.attendanceRecord.findMany({
        where: { studentId: user.id },
        include: { 
          session: { 
            include: { 
              course: { select: { name: true, code: true } } 
            } 
          } 
        },
        orderBy: { markedAt: "desc" },
        take: 5,
      });

      let message = `📊 Attendance Status for ${user.fullName}\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `📈 Overall Rate: ${attendanceRate}% (${attended}/${totalRecords})\n`;
      message += `✅ Present: ${presentRecords} | ⏰ Late: ${lateRecords} | ❌ Absent: ${absentRecords}\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `📚 Recent Classes:\n`;

      for (const record of recentAttendance) {
        const date = record.markedAt.toLocaleDateString();
        const status = this.getStatusSymbol(record.status);
        const course = record.session.course.name.substring(0, 25);
        message += `${date}: ${course} ${status}\n`;
      }

      message += `\n💡 Send HELP for commands or NEXT for upcoming sessions.`;

      this.sendTwimlResponse(res, message, true);
    } catch (error) {
      logger.error("Error sending attendance status:", error);
      this.sendTwimlResponse(
        res,
        "⚠️ Error retrieving attendance status. Please try again later.\n\nSend HELP for assistance.",
        false
      );
    }
  }

  /**
   * Send enrolled courses list
   */
  async sendEnrolledCourses(phoneNumber, res) {
    try {
      const user = await prisma.user.findFirst({
        where: { phone: phoneNumber, role: "student", isActive: true },
      });

      if (!user) {
        return this.sendTwimlResponse(
          res,
          "❌ Phone number not recognized. Please contact your lecturer.",
          false
        );
      }

      const enrollments = await prisma.enrollment.findMany({
        where: { studentId: user.id, isActive: true },
        include: {
          course: {
            select: { code: true, name: true, credits: true }
          }
        }
      });

      if (enrollments.length === 0) {
        return this.sendTwimlResponse(
          res,
          `📚 ${user.fullName}, you are not enrolled in any courses yet.\nContact your registrar for enrollment assistance.`,
          true
        );
      }

      let message = `📚 Your Courses (${enrollments.length})\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      
      for (const enrollment of enrollments) {
        message += `📖 ${enrollment.course.code}: ${enrollment.course.name}\n`;
        message += `   Credits: ${enrollment.course.credits}\n`;
      }
      
      message += `\n💡 Send STATUS to check attendance or NEXT for upcoming sessions.`;

      this.sendTwimlResponse(res, message, true);
    } catch (error) {
      logger.error("Error sending enrolled courses:", error);
      this.sendTwimlResponse(res, "⚠️ Error retrieving your courses. Please try again later.", false);
    }
  }

  /**
   * Send next upcoming session
   */
  async sendNextSession(phoneNumber, res) {
    try {
      const user = await prisma.user.findFirst({
        where: { phone: phoneNumber, role: "student", isActive: true },
      });

      if (!user) {
        return this.sendTwimlResponse(res, "❌ Phone number not recognized.", false);
      }

      const enrollments = await prisma.enrollment.findMany({
        where: { studentId: user.id, isActive: true },
        select: { courseId: true }
      });

      const courseIds = enrollments.map(e => e.courseId);

      if (courseIds.length === 0) {
        return this.sendTwimlResponse(res, "📚 You are not enrolled in any courses.", true);
      }

      const nextSession = await prisma.session.findFirst({
        where: {
          courseId: { in: courseIds },
          status: "active",
          checkinOpen: true,
          expiresAt: { gt: new Date() }
        },
        include: {
          course: { select: { name: true, code: true } },
          classroom: { select: { name: true, building: true } }
        },
        orderBy: { expiresAt: "asc" }
      });

      if (!nextSession) {
        return this.sendTwimlResponse(
          res,
          "📭 No active sessions at the moment.\nCheck back later or contact your lecturer for session schedules.",
          true
        );
      }

      const timeRemaining = Math.floor((new Date(nextSession.expiresAt) - new Date()) / 60000);
      const expiresIn = timeRemaining > 0 ? `${timeRemaining} minutes` : "expiring soon";

      let message = `🔔 Upcoming Session\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `📖 Course: ${nextSession.course.name}\n`;
      message += `📅 Session Code: ${nextSession.sessionCode}\n`;
      message += `⏰ Expires in: ${expiresIn}\n`;
      message += `📍 Location: ${nextSession.classroom?.building || ''} ${nextSession.classroom?.name || 'Classroom'}\n`;
      message += `━━━━━━━━━━━━━━━━━━━━\n`;
      message += `💡 Send: ATTEND ${nextSession.sessionCode} to check in now!`;

      this.sendTwimlResponse(res, message, true);
    } catch (error) {
      logger.error("Error sending next session:", error);
      this.sendTwimlResponse(res, "⚠️ Error retrieving upcoming sessions.", false);
    }
  }

  /**
   * Get help message
   */
  getHelpMessage() {
    return `📱 AttendX SMS Commands\n━━━━━━━━━━━━━━━━━━━━\n📌 ATTEND [CODE] - Check in to class\n   Example: ATTEND AB3X9K\n\n📊 STATUS - Check your attendance record\n\n📚 COURSES - View your enrolled courses\n\n🔔 NEXT - View next upcoming session\n\n❓ HELP - Show this menu\n━━━━━━━━━━━━━━━━━━━━\n📧 Need help? Contact your lecturer or email support@attendx.com`;
  }

  /**
   * Get status symbol for attendance
   */
  getStatusSymbol(status) {
    const symbols = {
      present: "✅",
      late: "⏰",
      absent: "❌",
      excused: "📝",
    };
    return symbols[status] || "❓";
  }

  /**
   * Parse SMS body to extract command
   */
  parseSMSBody(body) {
    if (!body || typeof body !== "string") {
      return { isValid: false };
    }

    const upperBody = body.trim().toUpperCase();

    // Pattern: ATTEND XXXXXX (5-6 char alphanumeric code)
    const attendMatch = upperBody.match(/^ATTEND\s+([A-Z0-9]{5,6})$/);
    if (attendMatch) {
      return {
        isValid: true,
        action: "ATTEND",
        sessionCode: attendMatch[1],
      };
    }

    // Help command
    if (upperBody === "HELP" || upperBody === "HELP?" || upperBody === "?") {
      return { isValid: true, action: "HELP" };
    }

    // Status command
    if (upperBody === "STATUS" || upperBody === "STAT" || upperBody === "SUMMARY") {
      return { isValid: true, action: "STATUS" };
    }

    // Courses command
    if (upperBody === "COURSES" || upperBody === "CLASSES" || upperBody === "MYCOURSES") {
      return { isValid: true, action: "COURSES" };
    }

    // Next session command
    if (upperBody === "NEXT" || upperBody === "UPCOMING" || upperBody === "SCHEDULE") {
      return { isValid: true, action: "NEXT" };
    }

    return { isValid: false };
  }

  /**
   * Send TwiML response to Twilio
   */
  sendTwimlResponse(res, message, success) {
    // Truncate message if too long (Twilio limit is 1600 chars)
    if (message.length > 1500) {
      message = message.substring(0, 1497) + "...";
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${this.escapeXml(message)}</Message>
</Response>`;

    res.set("Content-Type", "text/xml");
    res.send(twiml);
  }

  /**
   * Escape XML special characters
   */
  escapeXml(text) {
    if (!text) return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Validate Twilio webhook signature
   */
  validateTwilioSignature(req) {
    try {
      const twilio = require('twilio');
      const config = require('../config');

      const twilioSignature = req.headers["x-twilio-signature"];
      const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

      return twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        twilioSignature,
        url,
        req.body
      );
    } catch (error) {
      logger.error("Twilio signature validation error:", error);
      return false;
    }
  }

  /**
   * Log failed attempt
   */
  async logFailedAttempt(phoneNumber, sessionCode, reason, userId = null) {
    try {
      await prisma.auditLog.create({
        data: {
          userId: userId,
          action: "SMS_FAILED",
          entity: "SMS",
          newValues: { phoneNumber, sessionCode, reason },
        },
      });
    } catch (error) {
      logger.error("Failed to log SMS attempt:", error);
    }
  }

  /**
   * Get attendance confirmation email HTML
   */
  getAttendanceConfirmationEmail(user, session, status) {
    const isLate = status === "late";
    const emoji = isLate ? "⏰" : "✅";
    const statusText = isLate ? "Checked in (Late)" : "Checked in";
    
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: ${isLate ? '#FF9800' : '#4CAF50'}; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333;">${emoji} Attendance Confirmed via SMS</h2>
          <p>Dear ${user.fullName},</p>
          <p>You have successfully checked in to <strong>${session.course.name}</strong> via SMS.</p>
          <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Session Details:</strong></p>
            <ul>
              <li>Course: ${session.course.name} (${session.course.code})</li>
              <li>Session Code: ${session.sessionCode}</li>
              <li>Status: <strong style="color: ${isLate ? '#FF9800' : '#4CAF50'}">${statusText}</strong></li>
              <li>Date: ${new Date().toLocaleDateString()}</li>
              <li>Time: ${new Date().toLocaleTimeString()}</li>
              <li>Method: SMS</li>
            </ul>
          </div>
          ${isLate ? '<p style="color: #FF9800;">⚠️ You were marked as late. Please arrive earlier for future sessions.</p>' : ''}
          <p>Thank you for using AttendX!</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">This is an automated message. Please do not reply.</p>
        </div>
      </div>
    `;
  }

  /**
   * Broadcast SMS to multiple students (for lecturers)
   * POST /api/v1/sms/broadcast
   */
  async broadcastSMS(req, res, next) {
    try {
      const { courseId, message, sendEmailCopy = false } = req.body;

      if (!courseId || !message) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Course ID and message are required",
          },
        });
      }

      // Verify course belongs to lecturer
      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          lecturerId: req.user.id,
          isActive: true,
        },
      });

      if (!course && req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "You don't have access to this course" },
        });
      }

      // Check message length
      if (message.length > 160) {
        return res.status(400).json({
          success: false,
          error: {
            code: "MESSAGE_TOO_LONG",
            message: "SMS message cannot exceed 160 characters. Please shorten your message.",
          },
        });
      }

      // Get all enrolled students with phone numbers
      const enrollments = await prisma.enrollment.findMany({
        where: { courseId, isActive: true },
        include: {
          student: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
              notificationPref: true,
            },
          },
        },
      });

      const studentsWithPhone = enrollments.filter(e => e.student.phone);
      
      if (studentsWithPhone.length === 0) {
        return res.json({
          success: true,
          data: {
            total: 0,
            sent: 0,
            failed: 0,
            message: "No students with registered phone numbers found in this course.",
          },
        });
      }

      const results = [];
      let sentCount = 0;
      let failedCount = 0;

      for (const enrollment of studentsWithPhone) {
        try {
          const result = await this.smsService.sendSMS(
            enrollment.student.phone,
            `📢 ${course.code}: ${message}`
          );
          
          results.push({
            phone: enrollment.student.phone,
            name: enrollment.student.fullName,
            success: true,
            sid: result.sid,
          });
          sentCount++;

          // Send email copy if enabled and student has email preference
          if (sendEmailCopy && enrollment.student.notificationPref?.emailNotifications !== false) {
            await sendEmail(
              enrollment.student.email,
              `📢 Announcement: ${course.code}`,
              `<div style="font-family: Arial, sans-serif;">
                <h2>Course Announcement</h2>
                <p><strong>Course:</strong> ${course.name} (${course.code})</p>
                <p><strong>Message:</strong></p>
                <p>${message}</p>
                <hr />
                <p>You received this email because you have SMS notifications enabled.</p>
              </div>`
            );
          }

          logger.info(`Broadcast SMS sent to ${enrollment.student.phone} for course ${courseId}`);
        } catch (error) {
          results.push({
            phone: enrollment.student.phone,
            name: enrollment.student.fullName,
            success: false,
            error: error.message,
          });
          failedCount++;
          logger.error(`Failed to send broadcast SMS to ${enrollment.student.phone}:`, error);
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SMS_BROADCAST",
          entity: "Course",
          entityId: courseId,
          newValues: { recipients: sentCount, messageLength: message.length },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      res.json({
        success: true,
        data: {
          course: {
            id: course.id,
            code: course.code,
            name: course.name,
          },
          total: studentsWithPhone.length,
          sent: sentCount,
          failed: failedCount,
          details: results.slice(0, 10), // Return first 10 details
          message: `Broadcast sent to ${sentCount} students. Failed: ${failedCount}`,
        },
      });
    } catch (error) {
      logger.error("Broadcast SMS error:", error);
      next(error);
    }
  }

  /**
   * Send SMS to single student (for lecturers)
   * POST /api/v1/sms/send
   */
  async sendSingleSMS(req, res, next) {
    try {
      const { studentId, message } = req.body;

      if (!studentId || !message) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Student ID and message are required",
          },
        });
      }

      // Get student details
      const student = await prisma.user.findFirst({
        where: {
          id: studentId,
          role: "student",
          isActive: true,
        },
      });

      if (!student) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Student not found" },
        });
      }

      if (!student.phone) {
        return res.status(400).json({
          success: false,
          error: {
            code: "NO_PHONE",
            message: "Student does not have a registered phone number",
          },
        });
      }

      // Check message length
      if (message.length > 160) {
        return res.status(400).json({
          success: false,
          error: {
            code: "MESSAGE_TOO_LONG",
            message: "SMS message cannot exceed 160 characters",
          },
        });
      }

      // Send SMS
      const result = await this.smsService.sendSMS(student.phone, message);

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SMS_SINGLE",
          entity: "User",
          entityId: studentId,
          newValues: { phone: student.phone, messageLength: message.length },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`SMS sent to student ${student.email} by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          to: student.phone,
          studentName: student.fullName,
          message: message,
          sid: result.sid,
          status: result.status,
        },
      });
    } catch (error) {
      logger.error("Send single SMS error:", error);
      next(error);
    }
  }

  /**
   * Get SMS status (for webhook status callbacks)
   * POST /api/v1/sms/status
   */
  async smsStatus(req, res, next) {
    try {
      const { MessageSid, MessageStatus, To, From } = req.body;

      logger.info(`SMS Status Update: ${MessageSid} - ${MessageStatus} - To: ${To}`);

      // Log status update
      await prisma.auditLog.create({
        data: {
          action: "SMS_STATUS",
          entity: "SMS",
          entityId: MessageSid,
          newValues: { status: MessageStatus, to: To, from: From },
        },
      });

      // Return empty response (Twilio expects 200 OK)
      res.sendStatus(200);
    } catch (error) {
      logger.error("SMS status webhook error:", error);
      res.sendStatus(200); // Still return 200 to Twilio
    }
  }

  /**
   * Test endpoint for development
   * POST /api/v1/sms/test
   */
  async testSMS(req, res, next) {
    if (process.env.NODE_ENV !== "development") {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Endpoint not found" },
      });
    }

    try {
      const { to, message } = req.body;

      if (!to || !message) {
        return res.status(400).json({
          success: false,
          error: {
            code: "MISSING_FIELDS",
            message: "Both 'to' and 'message' are required",
          },
        });
      }

      const result = await this.smsService.sendSMS(to, message);

      res.json({
        success: true,
        data: {
          sid: result.sid,
          to: to,
          status: result.status,
          message: "Test SMS sent successfully",
        },
      });
    } catch (error) {
      logger.error("Test SMS error:", error);
      next(error);
    }
  }
}

module.exports = new SMSController();