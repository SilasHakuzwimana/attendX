const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../config/index");
const { sendEmail } = require("../services/email.service");
const crypto = require("crypto");

class RegistrationController {
  /**
   * Register a new user
   * POST /api/v1/auth/register
   */
  async register(req, res, next) {
    try {
      // Validate input
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

      const {
        fullName,
        email,
        phone,
        password,
        role,
        regNumber,
        staffNumber,
        deviceFingerprint,
        platform = "web",
      } = req.body;

      // Validate role
      const validRoles = ["student", "lecturer", "admin"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid role. Must be student, lecturer, or admin",
          },
        });
      }

      // Check if only admins can create admin accounts
      if (role === "admin" && req.user?.role !== "admin") {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "Only administrators can create admin accounts",
          },
        });
      }

      // Check if email already exists
      const existingEmail = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (existingEmail) {
        return res.status(409).json({
          success: false,
          error: {
            code: "EMAIL_EXISTS",
            message: "A user with this email already exists",
          },
        });
      }

      // Check if phone already exists (if provided)
      if (phone) {
        const existingPhone = await prisma.user.findUnique({
          where: { phone },
        });
        if (existingPhone) {
          return res.status(409).json({
            success: false,
            error: {
              code: "PHONE_EXISTS",
              message: "A user with this phone number already exists",
            },
          });
        }
      }

      // Role-specific validations
      if (role === "student") {
        // Students MUST have regNumber
        if (!regNumber) {
          return res.status(400).json({
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "Registration number is required for students",
            },
          });
        }

        // Validate regNumber format (e.g., S2024-001)
        const regNumberRegex = /^[A-Za-z0-9\-_]{5,20}$/;
        if (!regNumberRegex.test(regNumber)) {
          return res.status(400).json({
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message:
                "Invalid registration number format. Use 5-20 alphanumeric characters, hyphens, or underscores",
            },
          });
        }

        // Check if regNumber already exists
        const existingRegNumber = await prisma.user.findUnique({
          where: { regNumber },
        });

        if (existingRegNumber) {
          return res.status(409).json({
            success: false,
            error: {
              code: "REG_NUMBER_EXISTS",
              message: "A student with this registration number already exists",
            },
          });
        }
      }

      if (["lecturer", "admin"].includes(role)) {
        // Lecturers and admins MUST have staffNumber
        if (!staffNumber) {
          return res.status(400).json({
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: `Staff number is required for ${role}s`,
            },
          });
        }

        // Validate staffNumber format
        const staffNumberRegex = /^[A-Za-z0-9\-_]{5,20}$/;
        if (!staffNumberRegex.test(staffNumber)) {
          return res.status(400).json({
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message:
                "Invalid staff number format. Use 5-20 alphanumeric characters, hyphens, or underscores",
            },
          });
        }

        // Check if staffNumber already exists
        const existingStaffNumber = await prisma.user.findUnique({
          where: { staffNumber },
        });

        if (existingStaffNumber) {
          return res.status(409).json({
            success: false,
            error: {
              code: "STAFF_NUMBER_EXISTS",
              message: `A ${role} with this staff number already exists`,
            },
          });
        }
      }

      // Validate password strength
      const passwordStrength = this.validatePasswordStrength(password);
      if (!passwordStrength.isValid) {
        return res.status(400).json({
          success: false,
          error: {
            code: "WEAK_PASSWORD",
            message: passwordStrength.message,
          },
        });
      }

      // Hash password
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);

      // Generate email verification token
      const emailVerificationToken = crypto.randomBytes(32).toString("hex");
      const emailVerificationExpires = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ); // 24 hours

      // Create user
      const user = await prisma.user.create({
        data: {
          fullName,
          email: email.toLowerCase(),
          phone: phone || null,
          passwordHash: hashedPassword,
          role,
          regNumber: role === "student" ? regNumber.toUpperCase() : null,
          staffNumber: ["lecturer", "admin"].includes(role)
            ? staffNumber.toUpperCase()
            : null,
          isActive: true,
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          staffNumber: true,
          isActive: true,
          createdAt: true,
        },
      });

      // Create default notification preferences
      await prisma.notificationPreference.create({
        data: {
          userId: user.id,
          emailNotifications: true,
          pushNotifications: true,
          smsNotifications: false,
          sessionReminders: true,
          attendanceReports: false,
          sessionStarted: true,
          sessionClosed: false,
          attendanceConfirmation: true,
          missedAttendance: true,
          absenceWarning: true,
          weeklyDigest: false,
        },
      });

      // Register device if fingerprint provided
      if (deviceFingerprint) {
        await prisma.device.upsert({
          where: { deviceFingerprint },
          update: {
            lastSeenAt: new Date(),
            isActive: true,
            platform,
          },
          create: {
            deviceFingerprint,
            platform,
            userId: user.id,
            deviceName: `${platform} - ${new Date().toLocaleDateString()}`,
            isActive: true,
            isTrusted: true,
          },
        });
      }

      // Generate JWT token (auto-login after registration)
      const accessToken = jwt.sign(
        {
          userId: user.id,
          role: user.role,
          deviceFingerprint: deviceFingerprint || null,
        },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: process.env.JWT_ACCESS_EXPIRY || "1h" },
      );

      const refreshToken = jwt.sign(
        { userId: user.id, role: user.role, type: "refresh" },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: process.env.JWT_REFRESH_EXPIRY || "7d" },
      );

      // Store refresh token hash in database
      const tokenHash = crypto
        .createHash("sha256")
        .update(refreshToken)
        .digest("hex");
      const refreshTokenExpiry = new Date();
      refreshTokenExpiry.setDate(refreshTokenExpiry.getDate() + 7);

      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash,
          deviceFingerprint: deviceFingerprint || null,
          expiresAt: refreshTokenExpiry,
          revoked: false,
        },
      });

      // Store in Redis
      if (redisClient && redisClient.isReady && deviceFingerprint) {
        await redisClient.setEx(
          `refresh:${user.id}:${deviceFingerprint}`,
          7 * 24 * 60 * 60,
          refreshToken,
        );
      }

      // Send welcome email
      try {
        await sendEmail(
          email,
          `Welcome to AttendX, ${fullName}!`,
          this.getWelcomeEmailTemplate(fullName, role, emailVerificationToken),
        );
      } catch (emailError) {
        logger.warn(
          `Welcome email failed to send to ${email}: ${emailError.message}`,
        );
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "REGISTER",
          entity: "User",
          entityId: user.id,
          newValues: { email: user.email, role: user.role },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Log registration
      logger.info(
        `New ${role} registered: ${email} (${fullName}) - ${role === "student" ? regNumber : staffNumber}`,
      );

      // Respond with user data and tokens
      res.status(201).json({
        success: true,
        message: "Registration successful",
        data: {
          user,
          tokens: {
            accessToken,
            refreshToken,
            expiresIn: process.env.JWT_ACCESS_EXPIRY || "1h",
          },
        },
      });
    } catch (error) {
      // Handle Prisma unique constraint errors
      if (error.code === "P2002") {
        const field = error.meta?.target?.[0];
        const fieldNames = {
          email: "email",
          phone: "phone number",
          regNumber: "registration number",
          staffNumber: "staff number",
        };

        return res.status(409).json({
          success: false,
          error: {
            code: "UNIQUE_CONSTRAINT",
            message: `A user with this ${fieldNames[field] || field} already exists`,
          },
        });
      }

      logger.error("Registration error:", error);
      next(error);
    }
  }

  /**
   * Verify email address
   * POST /api/v1/auth/verify-email
   */
  async verifyEmail(req, res, next) {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Verification token is required",
          },
        });
      }

      // Find user with valid token
      const user = await prisma.user.findFirst({
        where: {
          emailVerificationToken: token,
          emailVerificationExpires: { gt: new Date() },
        },
      });

      if (!user) {
        return res.status(400).json({
          success: false,
          error: {
            code: "INVALID_TOKEN",
            message: "Invalid or expired verification token",
          },
        });
      }

      // Mark email as verified
      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
          emailVerificationExpires: null,
        },
      });

      logger.info(`Email verified for user: ${user.email}`);

      res.json({
        success: true,
        data: {
          message: "Email verified successfully. You can now log in.",
        },
      });
    } catch (error) {
      logger.error("Email verification error:", error);
      next(error);
    }
  }

  /**
   * Resend verification email
   * POST /api/v1/auth/resend-verification
   */
  async resendVerification(req, res, next) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Email is required",
          },
        });
      }

      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "User not found",
          },
        });
      }

      if (user.emailVerified) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ALREADY_VERIFIED",
            message: "Email is already verified",
          },
        });
      }

      // Check rate limiting
      const rateLimitKey = `verify:resend:${user.id}`;
      if (redisClient && redisClient.isReady) {
        const lastSent = await redisClient.get(rateLimitKey);
        if (lastSent) {
          return res.status(429).json({
            success: false,
            error: {
              code: "RATE_LIMITED",
              message:
                "Please wait 5 minutes before requesting another verification email",
            },
          });
        }
      }

      // Generate new token
      const newToken = crypto.randomBytes(32).toString("hex");
      const newExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerificationToken: newToken,
          emailVerificationExpires: newExpires,
        },
      });

      // Send verification email
      await sendEmail(
        email,
        "Verify Your Email Address - AttendX",
        this.getVerificationEmailTemplate(user.fullName, newToken),
      );

      // Set rate limit
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(rateLimitKey, 300, "sent"); // 5 minutes
      }

      logger.info(`Verification email resent to: ${email}`);

      res.json({
        success: true,
        data: {
          message: "Verification email sent. Please check your inbox.",
        },
      });
    } catch (error) {
      logger.error("Resend verification error:", error);
      next(error);
    }
  }

  /**
   * Check if email is available
   * GET /api/v1/auth/check-email
   */
  async checkEmail(req, res, next) {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Email is required" },
        });
      }

      const existingUser = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, email: true },
      });

      res.json({
        success: true,
        data: {
          available: !existingUser,
          message: existingUser
            ? "Email is already taken"
            : "Email is available",
        },
      });
    } catch (error) {
      logger.error("Check email error:", error);
      next(error);
    }
  }

  /**
   * Check if registration number is available
   * GET /api/v1/auth/check-regnumber
   */
  async checkRegNumber(req, res, next) {
    try {
      const { regNumber } = req.query;

      if (!regNumber) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Registration number is required",
          },
        });
      }

      const existingStudent = await prisma.user.findUnique({
        where: { regNumber: regNumber.toUpperCase() },
        select: { id: true, regNumber: true },
      });

      res.json({
        success: true,
        data: {
          available: !existingStudent,
          message: existingStudent
            ? "Registration number is already taken"
            : "Registration number is available",
        },
      });
    } catch (error) {
      logger.error("Check reg number error:", error);
      next(error);
    }
  }

  /**
   * Check if staff number is available
   * GET /api/v1/auth/check-staffnumber
   */
  async checkStaffNumber(req, res, next) {
    try {
      const { staffNumber } = req.query;

      if (!staffNumber) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Staff number is required",
          },
        });
      }

      const existingStaff = await prisma.user.findUnique({
        where: { staffNumber: staffNumber.toUpperCase() },
        select: { id: true, staffNumber: true },
      });

      res.json({
        success: true,
        data: {
          available: !existingStaff,
          message: existingStaff
            ? "Staff number is already taken"
            : "Staff number is available",
        },
      });
    } catch (error) {
      logger.error("Check staff number error:", error);
      next(error);
    }
  }

  /**
   * Check if phone is available
   * GET /api/v1/auth/check-phone
   */
  async checkPhone(req, res, next) {
    try {
      const { phone } = req.query;

      if (!phone) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Phone number is required",
          },
        });
      }

      const existingUser = await prisma.user.findUnique({
        where: { phone },
        select: { id: true, phone: true },
      });

      res.json({
        success: true,
        data: {
          available: !existingUser,
          message: existingUser
            ? "Phone number is already registered"
            : "Phone number is available",
        },
      });
    } catch (error) {
      logger.error("Check phone error:", error);
      next(error);
    }
  }

  /**
   * Validate password strength
   */
  validatePasswordStrength(password) {
    const checks = {
      length: password.length >= 8,
      uppercase: /[A-Z]/.test(password),
      lowercase: /[a-z]/.test(password),
      number: /[0-9]/.test(password),
      special: /[!@#$%^&*(),.?":{}|<>]/.test(password),
    };

    const passedChecks = Object.values(checks).filter(Boolean).length;

    if (passedChecks < 3) {
      return {
        isValid: false,
        message:
          "Password must contain at least 8 characters with a mix of uppercase, lowercase, numbers, and special characters",
      };
    }

    return { isValid: true, message: "Password is strong" };
  }

  /**
   * Get welcome email HTML template
   */
  getWelcomeEmailTemplate(fullName, role, verificationToken) {
    const roleColors = {
      student: "#4F46E5",
      lecturer: "#059669",
      admin: "#D97706",
    };

    const roleLabels = {
      student: "Student",
      lecturer: "Lecturer",
      admin: "Administrator",
    };

    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f5;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
          <!-- Header -->
          <div style="background: ${roleColors[role]}; padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Welcome to AttendX!</h1>
          </div>
          
          <!-- Content -->
          <div style="padding: 30px;">
            <h2 style="color: #1F2937; margin-top: 0;">Hello, ${fullName}!</h2>
            
            <p style="color: #4B5563; font-size: 16px; line-height: 1.6;">
              Your AttendX account has been created successfully as a <strong style="color: ${roleColors[role]}">${roleLabels[role]}</strong>.
            </p>
            
            <!-- Role-specific features -->
            <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="color: ${roleColors[role]}; margin-top: 0; margin-bottom: 15px;">Your Features:</h3>
              <ul style="color: #4B5563; line-height: 1.8; margin: 0; padding-left: 20px;">
                ${
                  role === "student"
                    ? `
                  <li>✅ Check-in to classes with GPS location</li>
                  <li>📊 View your attendance history and trends</li>
                  <li>🔔 Get instant notifications for sessions</li>
                  <li>📱 Use mobile app for quick check-ins</li>
                  <li>📧 Receive attendance confirmations via email</li>
                `
                    : role === "lecturer"
                      ? `
                  <li>📋 Create and manage attendance sessions</li>
                  <li>👥 Track student attendance in real-time</li>
                  <li>📊 View detailed class analytics</li>
                  <li>🔔 Receive absence alerts for at-risk students</li>
                  <li>📧 Send announcements to your students</li>
                `
                      : `
                  <li>👥 Manage all users (students, lecturers, admins)</li>
                  <li>🏫 Configure classrooms and geofences</li>
                  <li>📚 Manage courses and enrollments</li>
                  <li>📊 Access system-wide analytics</li>
                  <li>⚙️ Configure system settings</li>
                `
                }
              </ul>
            </div>
            
            <!-- Email Verification -->
            <div style="background: #EFF6FF; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${roleColors[role]};">
              <p style="margin: 0 0 10px 0; color: #1F2937; font-weight: bold;">📧 Verify Your Email Address</p>
              <p style="margin: 0 0 15px 0; color: #4B5563;">Please verify your email address to ensure you receive important notifications.</p>
              <a href="${verificationUrl}" 
                 style="background: ${roleColors[role]}; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                Verify Email
              </a>
              <p style="margin: 10px 0 0 0; font-size: 12px; color: #6B7280;">This link expires in 24 hours</p>
            </div>
            
            <!-- Getting Started -->
            <div style="margin: 20px 0;">
              <h3 style="color: #1F2937;">🚀 Getting Started</h3>
              <ol style="color: #4B5563; line-height: 1.8;">
                <li>Download the AttendX mobile app from your app store</li>
                <li>Log in using your email and password</li>
                <li>Complete your profile setup</li>
                <li>${role === "student" ? "Check in to your first session" : role === "lecturer" ? "Create your first attendance session" : "Start managing the system"}</li>
              </ol>
            </div>
            
            <!-- Action Button -->
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL}/login" 
                 style="background: ${roleColors[role]}; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-size: 16px; display: inline-block;">
                Go to Dashboard →
              </a>
            </div>
            
            <!-- Footer -->
            <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
            
            <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
              <strong>AttendX</strong> - Smart Hybrid Attendance Management System<br/>
              This is an automated message. Please do not reply.<br/>
              Need help? Contact support at ${process.env.SUPPORT_EMAIL || "support@attendx.com"}
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Get verification email template
   */
  getVerificationEmailTemplate(fullName, verificationToken) {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f5;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0;">Verify Your Email</h1>
          </div>
          
          <div style="padding: 30px;">
            <h2>Hello, ${fullName}!</h2>
            
            <p style="color: #4B5563; font-size: 16px; line-height: 1.6;">
              Please verify your email address to complete your registration and start using AttendX.
            </p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verificationUrl}" 
                 style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-size: 16px; display: inline-block;">
                Verify Email Address
              </a>
            </div>
            
            <p style="color: #6B7280; font-size: 14px;">
              If you didn't create an account with AttendX, please ignore this email.
            </p>
            
            <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
            
            <p style="color: #9CA3AF; font-size: 12px; text-align: center;">
              This verification link expires in 24 hours.<br/>
              AttendX - Smart Attendance System
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = new RegistrationController();
