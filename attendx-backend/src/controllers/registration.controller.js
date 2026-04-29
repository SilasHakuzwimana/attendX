const bcrypt = require("bcryptjs");
const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const config = require("../config");
const { sendEmail } = require("../services/email.service");

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
            fields: errors.array(),
          },
        });
      }

      const { fullName, email, phone, password, role, regNumber, staffNumber } =
        req.body;

      // Check if email already exists
      const existingEmail = await global.prisma.user.findUnique({
        where: { email },
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
        const existingPhone = await global.prisma.user.findUnique({
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
              fields: [
                { field: "regNumber", message: "Required for students" },
              ],
            },
          });
        }

        // Check if regNumber already exists
        const existingRegNumber = await global.prisma.user.findUnique({
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
              fields: [
                {
                  field: "staffNumber",
                  message: `Required for ${role}s`,
                },
              ],
            },
          });
        }

        // Check if staffNumber already exists
        const existingStaffNumber = await global.prisma.user.findUnique({
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

      // Hash password
      const hashedPassword = await bcrypt.hash(
        password,
        config.security.bcryptRounds,
      );

      // Create user
      const user = await global.prisma.user.create({
        data: {
          fullName,
          email,
          phone: phone || null,
          password: hashedPassword,
          role,
          regNumber: role === "student" ? regNumber : null,
          staffNumber: ["lecturer", "admin"].includes(role)
            ? staffNumber
            : null,
          isActive: true,
        },
      });

      // Create default notification preferences
      await global.prisma.notificationPreference.create({
        data: {
          userId: user.id,
          attendanceConfirmation: true,
          missedAttendance: true,
          absenceWarning: true,
          sessionStarted: true,
        },
      });

      // Generate JWT token (auto-login after registration)
      const jwt = require("jsonwebtoken");
      const token = jwt.sign(
        { userId: user.id, role: user.role },
        config.jwt.secret,
        { expiresIn: config.jwt.accessExpiresIn },
      );

      // Remove password from response
      const { password: _, ...userWithoutPassword } = user;

      // Send welcome email
      try {
        await sendEmail(
          email,
          `Welcome to AttendX, ${fullName}!`,
          this.getWelcomeEmailTemplate(fullName, role),
        );
      } catch (emailError) {
        logger.warn(
          `Welcome email failed to send to ${email}: ${emailError.message}`,
        );
      }

      // Log registration
      logger.info(
        `New ${role} registered: ${email} (${fullName}) - ${role === "student" ? regNumber : staffNumber}`,
      );

      // Respond with user data and token
      res.status(201).json({
        success: true,
        message: "Registration successful",
        data: {
          user: userWithoutPassword,
          token,
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

      next(error);
    }
  }

  /**
   * Get welcome email HTML template
   */
  getWelcomeEmailTemplate(fullName, role) {
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

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: ${roleColors[role]}; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">Welcome to AttendX! 🎉</h1>
        </div>
        
        <div style="background: white; padding: 30px; border: 1px solid #e5e7eb; border-radius: 0 0 10px 10px;">
          <h2 style="color: #1F2937;">Hello, ${fullName}!</h2>
          <p style="color: #4B5563; font-size: 16px; line-height: 1.6;">
            Your AttendX account has been created successfully as a <strong>${roleLabels[role]}</strong>.
          </p>
          
          <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="color: ${roleColors[role]}; margin-top: 0;">Your Role: ${roleLabels[role]}</h3>
            <ul style="color: #4B5563; line-height: 1.8;">
              ${
                role === "student"
                  ? `
                <li>✅ Check-in to classes with GPS location</li>
                <li>📊 View your attendance history</li>
                <li>🔔 Get notifications for classes</li>
                <li>📱 Use mobile app for quick check-ins</li>
              `
                  : role === "lecturer"
                    ? `
                <li>📋 Create attendance sessions</li>
                <li>👥 Track student attendance</li>
                <li>📊 View class analytics</li>
                <li>🔔 Get absence alerts</li>
              `
                    : `
                <li>👥 Manage all users</li>
                <li>🏫 Configure classrooms</li>
                <li>📚 Manage courses & enrollments</li>
                <li>📊 System-wide analytics</li>
              `
              }
            </ul>
          </div>
          
          <p style="color: #4B5563; font-size: 16px; line-height: 1.6;">
            Get started by downloading the AttendX mobile app or accessing the web portal.
          </p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${config.frontend.url}/login" 
               style="background: ${roleColors[role]}; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-size: 16px; display: inline-block;">
              Go to Dashboard
            </a>
          </div>
          
          <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
          
          <p style="color: #9CA3AF; font-size: 12px; text-align: center;">
            AttendX - Smart Hybrid Attendance Management System<br/>
            If you didn't create this account, please contact support immediately.
          </p>
        </div>
      </div>
    `;
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

      const existingUser = await global.prisma.user.findUnique({
        where: { email },
      });

      res.json({
        success: true,
        data: {
          available: !existingUser,
        },
      });
    } catch (error) {
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

      const existingStudent = await global.prisma.user.findUnique({
        where: { regNumber },
      });

      res.json({
        success: true,
        data: {
          available: !existingStudent,
        },
      });
    } catch (error) {
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

      const existingStaff = await global.prisma.user.findUnique({
        where: { staffNumber },
      });

      res.json({
        success: true,
        data: {
          available: !existingStaff,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new RegistrationController();
