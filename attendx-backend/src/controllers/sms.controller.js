const { validationResult, body } = require("express-validator");
const logger = require("../utils/logger");
const TwilioService = require("../services/twilio.service");
const { sendEmail } = require("../services/email.service");
const rateLimit = require("express-rate-limit");

const twilioService = new TwilioService();

// Rate limiter for SMS webhook
const smsRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // 3 SMS per minute per phone number
  keyGenerator: (req) => req.body.From || req.body.From,
  skipSuccessfulRequests: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message:
        "Too many SMS requests. Please wait a minute before trying again.",
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
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
];

// Helper to normalize phone number to E.164 format
const normalizePhoneNumber = (phoneNumber) => {
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
  /**
   * Handle incoming SMS webhook from Twilio
   * POST /api/sms/webhook
   */
  async handleIncomingSMS(req, res) {
    try {
      // Apply rate limiting
      await new Promise((resolve, reject) => {
        smsRateLimit(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Twilio sends form-urlencoded data
      const { From, Body, MessageSid, To } = req.body;

      // Normalize phone number
      const normalizedFrom = normalizePhoneNumber(From);

      logger.info(`Received SMS from ${normalizedFrom}: ${Body}`);

      // Validate Twilio signature (skip in development)
      if (
        process.env.NODE_ENV === "production" &&
        !this.validateTwilioSignature(req)
      ) {
        logger.warn(`Invalid Twilio signature from ${normalizedFrom}`);
        return this.sendTwimlResponse(res, "Security validation failed", false);
      }

      // Parse the SMS body
      const parsed = this.parseSMSBody(Body);

      if (!parsed.isValid) {
        logger.info(`Invalid SMS format from ${normalizedFrom}: ${Body}`);
        return this.sendTwimlResponse(
          res,
          "❌ Invalid format. Send: ATTEND [CODE] (e.g., ATTEND AB3X9K) or HELP for assistance.",
          false,
        );
      }

      const { action, sessionCode } = parsed;

      // Handle different commands
      switch (action) {
        case "ATTEND":
          await this.processAttendanceCheckin(normalizedFrom, sessionCode, res);
          break;
        case "HELP":
          this.sendTwimlResponse(
            res,
            "📱 AttendX Commands:\n\n" +
              "ATTEND [CODE] - Check in to class\n" +
              "Example: ATTEND AB3X9K\n\n" +
              "STATUS - Check your attendance record\n\n" +
              "HELP - Show this menu\n\n" +
              "Need help? Contact your lecturer.",
            true,
          );
          break;
        case "STATUS":
          await this.sendAttendanceStatus(normalizedFrom, res);
          break;
        default:
          this.sendTwimlResponse(
            res,
            "❌ Unknown command. Send HELP for available commands.",
            false,
          );
      }
    } catch (error) {
      if (error.message && error.message.includes("rate limit")) {
        return this.sendTwimlResponse(
          res,
          "⚠️ Too many requests. Please wait a minute before sending another message.",
          false,
        );
      }

      logger.error("SMS webhook error:", error);
      this.sendTwimlResponse(
        res,
        "⚠️ System error. Please try again later or contact your lecturer.",
        false,
      );
    }
  }

  /**
   * Process attendance check-in via SMS
   */
  async processAttendanceCheckin(phoneNumber, sessionCode, res) {
    try {
      // 1. Find user by phone number
      const user = await global.prisma.user.findFirst({
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
        return this.sendTwimlResponse(
          res,
          "❌ Phone number not recognized. Please contact your lecturer to register your number for SMS attendance.",
          false,
        );
      }

      // 2. Validate session code format
      if (!/^[A-Z0-9]{6}$/.test(sessionCode)) {
        logger.info(
          `Invalid session code format from ${phoneNumber}: ${sessionCode}`,
        );
        return this.sendTwimlResponse(
          res,
          "❌ Invalid session code format. Session codes are 6 characters (letters and numbers). Example: ATTEND AB3X9K",
          false,
        );
      }

      // 3. Find active session by code
      const session = await global.prisma.session.findFirst({
        where: {
          sessionCode: sessionCode,
          status: "active",
          checkinOpen: true,
          expiresAt: { gt: new Date() },
        },
        include: {
          course: true,
          classroom: true,
        },
      });

      if (!session) {
        logger.info(
          `Invalid or expired session code from ${phoneNumber}: ${sessionCode}`,
        );
        return this.sendTwimlResponse(
          res,
          "❌ Invalid or expired session code. Please check with your lecturer for the correct code.",
          false,
        );
      }

      // 4. Check if student is enrolled
      const enrollment = await global.prisma.enrollment.findUnique({
        where: {
          studentId_courseId: {
            studentId: user.id,
            courseId: session.courseId,
          },
        },
      });

      if (!enrollment) {
        logger.warn(
          `Non-enrolled student attempted check-in: ${user.email} for course ${session.courseId}`,
        );
        return this.sendTwimlResponse(
          res,
          `❌ You are not enrolled in ${session.course.name}. Please contact your lecturer to be added to the course.`,
          false,
        );
      }

      // 5. Check for duplicate check-in
      const existingCheckin = await global.prisma.roomCheckin.findUnique({
        where: {
          sessionId_studentId: {
            sessionId: session.id,
            studentId: user.id,
          },
        },
      });

      if (existingCheckin) {
        const checkinTime = existingCheckin.checkedInAt.toLocaleTimeString();
        return this.sendTwimlResponse(
          res,
          `ℹ️ You have already checked in for ${session.course.name} at ${checkinTime}. Duplicate check-ins are not allowed.`,
          true,
        );
      }

      // 6. Create check-in record (SMS submission)
      const checkin = await global.prisma.roomCheckin.create({
        data: {
          sessionId: session.id,
          studentId: user.id,
          latitude: 0, // No GPS for SMS
          longitude: 0,
          distanceM: null,
          deviceFingerprint: "sms",
          submissionMethod: "sms",
        },
      });

      logger.info(
        `✅ SMS check-in successful: ${user.email} (${phoneNumber}) for session ${session.id} - Course: ${session.course.name}`,
      );

      // 7. Send confirmation SMS
      await twilioService.sendAttendanceConfirmation(
        phoneNumber,
        user.fullName,
        session.course.name,
      );

      // 8. Send email notification if enabled
      if (user.notificationPref?.attendanceConfirmation !== false) {
        await sendEmail(
          user.email,
          "✅ Attendance Confirmed via SMS - AttendX",
          `<div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #4F46E5;">Attendance Confirmed via SMS</h2>
            <p>Dear ${user.fullName},</p>
            <p>You have successfully checked in to <strong>${session.course.name}</strong> via SMS.</p>
            <p><strong>Details:</strong></p>
            <ul>
              <li>Course: ${session.course.name}</li>
              <li>Time: ${checkin.checkedInAt.toLocaleString()}</li>
              <li>Session Code: ${session.sessionCode}</li>
              <li>Method: SMS</li>
            </ul>
            <p>Thank you for using AttendX!</p>
            <hr style="margin: 20px 0;" />
            <p style="color: #666; font-size: 12px;">This is an automated message. Please do not reply.</p>
          </div>`,
        );
      }

      // 9. Emit WebSocket event for live dashboard
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
        });
      }

      // 10. Send success response
      this.sendTwimlResponse(
        res,
        `✅ Attendance recorded for ${session.course.name}, ${user.fullName}! You will receive an email confirmation. Thank you for using AttendX.`,
        true,
      );
    } catch (error) {
      logger.error("Error processing SMS check-in:", error);
      this.sendTwimlResponse(
        res,
        "⚠️ Error processing your request. Please try again or contact your lecturer.",
        false,
      );
    }
  }

  /**
   * Send attendance status for a student
   */
  async sendAttendanceStatus(phoneNumber, res) {
    try {
      const user = await global.prisma.user.findFirst({
        where: { phone: phoneNumber, role: "student" },
        include: { notificationPref: true },
      });

      if (!user) {
        return this.sendTwimlResponse(
          res,
          "❌ Phone number not recognized. Please contact your lecturer to register your number.",
          false,
        );
      }

      // Get attendance statistics
      const totalRecords = await global.prisma.attendanceRecord.count({
        where: { studentId: user.id },
      });

      if (totalRecords === 0) {
        return this.sendTwimlResponse(
          res,
          `📊 No attendance records found for ${user.fullName}. Start attending classes to build your record!`,
          true,
        );
      }

      // Get recent attendance (last 5 sessions)
      const recentAttendance = await global.prisma.attendanceRecord.findMany({
        where: { studentId: user.id },
        include: { session: { include: { course: true } } },
        orderBy: { markedAt: "desc" },
        take: 5,
      });

      // Calculate overall attendance rate
      const presentCount = await global.prisma.attendanceRecord.count({
        where: {
          studentId: user.id,
          status: "present",
        },
      });

      const attendanceRate = ((presentCount / totalRecords) * 100).toFixed(1);

      let message = `📊 Attendance Status for ${user.fullName}\n`;
      message += `Overall Rate: ${attendanceRate}% (${presentCount}/${totalRecords})\n\n`;
      message += `Recent Classes:\n`;

      for (const record of recentAttendance) {
        const date = record.markedAt.toLocaleDateString();
        const status = this.getStatusEmoji(record.status);
        const course = record.session.course.name.substring(0, 20); // Truncate long names
        message += `${date}: ${course} - ${status}\n`;
      }

      message += `\nSend HELP for commands or contact your lecturer for more details.`;

      this.sendTwimlResponse(res, message, true);
    } catch (error) {
      logger.error("Error sending attendance status:", error);
      this.sendTwimlResponse(
        res,
        "⚠️ Error retrieving attendance status. Please try again later.",
        false,
      );
    }
  }

  /**
   * Get emoji for attendance status
   */
  getStatusEmoji(status) {
    const emojis = {
      present: "✅",
      absent: "❌",
      excused: "📝",
      late: "⏰",
    };
    return emojis[status] || "❓";
  }

  /**
   * Parse SMS body to extract command
   * @param {string} body - SMS body text
   * @returns {object} Parsed command
   */
  parseSMSBody(body) {
    if (!body || typeof body !== "string") {
      return { isValid: false };
    }

    const upperBody = body.trim().toUpperCase();

    // Pattern: ATTEND XXXXXX (6-char alphanumeric code)
    const attendMatch = upperBody.match(/^ATTEND\s+([A-Z0-9]{6})$/);
    if (attendMatch) {
      return {
        isValid: true,
        action: "ATTEND",
        sessionCode: attendMatch[1],
      };
    }

    // Help command
    if (upperBody === "HELP" || upperBody === "HELP?") {
      return { isValid: true, action: "HELP" };
    }

    // Status command
    if (upperBody === "STATUS" || upperBody === "STAT") {
      return { isValid: true, action: "STATUS" };
    }

    return { isValid: false };
  }

  /**
   * Send TwiML response to Twilio
   * @param {object} res - Express response object
   * @param {string} message - Message to send
   * @param {boolean} success - Whether operation was successful
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
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
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
   * @param {object} req - Express request object
   * @returns {boolean} Is valid
   */
  validateTwilioSignature(req) {
    const twilio = require("twilio");
    const config = require("../config");

    const twilioSignature = req.headers["x-twilio-signature"];
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

    try {
      return twilio.validateRequest(
        config.twilio.authToken,
        twilioSignature,
        url,
        req.body,
      );
    } catch (error) {
      logger.error("Twilio signature validation error:", error);
      return false;
    }
  }

  /**
   * Broadcast SMS to multiple students (for lecturers)
   * POST /api/sms/broadcast
   */
  async broadcastSMS(req, res, next) {
    try {
      const { courseId, message } = req.body;

      // Validate message length
      if (message.length > 160) {
        return res.status(400).json({
          success: false,
          error: {
            code: "MESSAGE_TOO_LONG",
            message:
              "SMS message cannot exceed 160 characters. Please shorten your message.",
          },
        });
      }

      // Get all enrolled students with phone numbers
      const enrollments = await global.prisma.enrollment.findMany({
        where: { courseId },
        include: {
          student: {
            where: {
              phone: { not: null },
              isActive: true,
            },
          },
        },
      });

      if (enrollments.length === 0) {
        return res.json({
          success: true,
          data: {
            total: 0,
            sent: 0,
            failed: 0,
            message:
              "No students with registered phone numbers found in this course.",
          },
        });
      }

      const results = [];
      let sentCount = 0;
      let failedCount = 0;

      for (const enrollment of enrollments) {
        if (enrollment.student.phone) {
          try {
            const result = await twilioService.sendSMS(
              enrollment.student.phone,
              message,
            );
            results.push({
              phone: enrollment.student.phone,
              name: enrollment.student.fullName,
              success: true,
              sid: result.sid,
            });
            sentCount++;

            // Log successful broadcast
            logger.info(
              `Broadcast SMS sent to ${enrollment.student.phone} for course ${courseId}`,
            );
          } catch (error) {
            results.push({
              phone: enrollment.student.phone,
              name: enrollment.student.fullName,
              success: false,
              error: error.message,
            });
            failedCount++;
            logger.error(
              `Failed to send broadcast SMS to ${enrollment.student.phone}:`,
              error,
            );
          }
        }
      }

      res.json({
        success: true,
        data: {
          total: enrollments.length,
          sent: sentCount,
          failed: failedCount,
          details: results,
          message: `Broadcast sent to ${sentCount} students. Failed: ${failedCount}`,
        },
      });
    } catch (error) {
      logger.error("Broadcast SMS error:", error);
      next(error);
    }
  }

  /**
   * Test endpoint for development
   * POST /api/sms/test
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

      const result = await twilioService.sendSMS(to, message);

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
