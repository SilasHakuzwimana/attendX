const express = require("express");
const { body, query } = require("express-validator");
const crypto = require("crypto");
const { validate } = require("../middleware/validation.middleware");
const { loginLimiter } = require("../middleware/rateLimit.middleware");
const { authenticateToken } = require("../middleware/auth.middleware");
const authController = require("../controllers/auth.controller");
const registrationController = require("../controllers/registration.controller");
const config = require("../config");
const { prisma, redisClient } = require("../config/index");
const { sendEmail } = require("../services/email.service");
const logger = require("../utils/logger");

const router = express.Router();

// =====================================================
// REGISTRATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/auth/register
 * @desc    Register a new user (student, lecturer, or admin)
 * @access  Public (Admin only for lecturer/admin creation)
 */
router.post(
  "/register",
  body("fullName")
    .notEmpty()
    .withMessage("Full name is required")
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage("Full name must be between 2 and 100 characters"),
  body("email")
    .isEmail()
    .withMessage("Valid email is required")
    .normalizeEmail(),
  body("password")
    .isLength({ min: config.security.passwordMinLength || 8 })
    .withMessage(
      `Password must be at least ${config.security.passwordMinLength || 8} characters`,
    )
    .matches(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    )
    .withMessage(
      "Password must contain uppercase, lowercase, number, and special character",
    ),
  body("role")
    .isIn(["student", "lecturer", "admin"])
    .withMessage("Valid role is required"),
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  body("regNumber").optional().isString().trim().isLength({ min: 5, max: 20 }),
  body("staffNumber")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 5, max: 20 }),
  body("deviceFingerprint").optional().isString(),
  body("platform").optional().isIn(["android", "ios", "web"]),
  validate,
  registrationController.register.bind(registrationController),
);

/**
 * @route   GET /api/v1/auth/check-email
 * @desc    Check if email is available for registration
 * @access  Public
 */
router.get(
  "/check-email",
  query("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Valid email is required"),
  validate,
  registrationController.checkEmail.bind(registrationController),
);

/**
 * @route   GET /api/v1/auth/check-phone
 * @desc    Check if phone number is available
 * @access  Public
 */
router.get(
  "/check-phone",
  query("phone")
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  validate,
  registrationController.checkPhone?.bind(registrationController) ||
    ((req, res) => {
      res.json({ success: true, data: { available: true } });
    }),
);

/**
 * @route   GET /api/v1/auth/check-regnumber
 * @desc    Check if student registration number is available
 * @access  Public
 */
router.get(
  "/check-regnumber",
  query("regNumber").isString().trim().notEmpty(),
  validate,
  registrationController.checkRegNumber.bind(registrationController),
);

/**
 * @route   GET /api/v1/auth/check-staffnumber
 * @desc    Check if staff number is available for lecturers/admins
 * @access  Public
 */
router.get(
  "/check-staffnumber",
  query("staffNumber").isString().trim().notEmpty(),
  validate,
  registrationController.checkStaffNumber.bind(registrationController),
);

// =====================================================
// LOGIN & AUTHENTICATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/auth/login
 * @desc    Login user with email and password
 * @access  Public
 */
router.post(
  "/login",
  loginLimiter,
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Valid email is required"),
  body("password").notEmpty().withMessage("Password is required"),
  body("deviceFingerprint").optional().isString(),
  body("fcmToken").optional().isString(),
  body("platform").optional().isIn(["android", "ios", "web"]),
  body("deviceName").optional().isString().trim(),
  validate,
  authController.login.bind(authController),
);

// =====================================================
// TOKEN MANAGEMENT ROUTES
// =====================================================

/**
 * @route   POST /api/v1/auth/refresh
 * @desc    Refresh access token using refresh token
 * @access  Public
 */
router.post(
  "/refresh",
  body("refreshToken").optional().isString(),
  validate,
  authController.refresh.bind(authController),
);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout current device
 * @access  Private
 */
router.post(
  "/logout",
  authenticateToken,
  body("refreshToken").optional().isString(),
  body("deviceFingerprint").optional().isString(),
  validate,
  authController.logout.bind(authController),
);

/**
 * @route   POST /api/v1/auth/logout-all
 * @desc    Logout from all devices (clear refresh tokens & deactivate devices)
 * @access  Private
 */
router.post("/logout-all", authenticateToken, async (req, res, next) => {
  try {
    // Delete all refresh tokens for this user from Redis
    if (redisClient && redisClient.isReady) {
      const keys = await redisClient.keys(`refresh:${req.user.id}:*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    }

    // Revoke all refresh tokens in database
    await prisma.refreshToken.updateMany({
      where: { userId: req.user.id, revoked: false },
      data: { revoked: true },
    });

    // Deactivate all user's devices (optional)
    await prisma.device.updateMany({
      where: { userId: req.user.id },
      data: { isActive: false },
    });

    // Clear cookies
    authController.constructor.clearTokenCookies(res);

    logger.info(`User logged out from all devices: ${req.user.email}`);

    res.json({
      success: true,
      data: { message: "Logged out from all devices successfully" },
    });
  } catch (error) {
    logger.error("Logout all devices error:", error);
    next(error);
  }
});

// =====================================================
// PASSWORD MANAGEMENT ROUTES
// =====================================================

/**
 * @route   POST /api/v1/auth/forgot-password
 * @desc    Send password reset link to email
 * @access  Public
 */
router.post(
  "/forgot-password",
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Valid email is required"),
  validate,
  authController.forgotPassword.bind(authController),
);

/**
 * @route   POST /api/v1/auth/reset-password
 * @desc    Reset password using token from email
 * @access  Public
 */
router.post(
  "/reset-password",
  body("token").notEmpty().withMessage("Reset token is required"),
  body("newPassword")
    .isLength({ min: config.security.passwordMinLength || 8 })
    .withMessage(
      `Password must be at least ${config.security.passwordMinLength || 8} characters`,
    )
    .matches(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    )
    .withMessage(
      "Password must contain uppercase, lowercase, number, and special character",
    ),
  validate,
  authController.resetPassword.bind(authController),
);

/**
 * @route   POST /api/v1/auth/change-password
 * @desc    Change password while authenticated
 * @access  Private
 */
router.post(
  "/change-password",
  authenticateToken,
  body("currentPassword")
    .notEmpty()
    .withMessage("Current password is required"),
  body("newPassword")
    .isLength({ min: config.security.passwordMinLength || 8 })
    .withMessage(
      `Password must be at least ${config.security.passwordMinLength || 8} characters`,
    )
    .matches(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    )
    .withMessage(
      "Password must contain uppercase, lowercase, number, and special character",
    ),
  body("revokeAllSessions").optional().isBoolean(),
  validate,
  authController.changePassword.bind(authController),
);

// =====================================================
// EMAIL VERIFICATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/auth/verify-email
 * @desc    Verify email address with token
 * @access  Public
 */
router.post(
  "/verify-email",
  body("token").notEmpty().withMessage("Verification token is required"),
  validate,
  authController.verifyEmail.bind(authController),
);

/**
 * @route   POST /api/v1/auth/resend-verification
 * @desc    Resend email verification link
 * @access  Private
 */
router.post(
  "/resend-verification",
  authenticateToken,
  async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "User not found" },
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

      // Generate new verification token
      const verificationToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto
        .createHash("sha256")
        .update(verificationToken)
        .digest("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // Store token (you'll need an EmailVerificationToken model)
      // For now, store in user table
      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerificationToken: tokenHash,
          emailVerificationExpires: expiresAt,
        },
      });

      const verificationUrl = `${config.frontend.url}/verify-email?token=${verificationToken}`;

      await sendEmail(
        user.email,
        "Verify Your Email - AttendX",
        `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333;">Verify Your Email Address</h2>
          <p>Dear ${user.fullName},</p>
          <p>Please click the button below to verify your email address:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Verify Email</a>
          </div>
          <p>This link will expire in <strong>24 hours</strong>.</p>
          <p>If you didn't create an account, please ignore this email.</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
      `,
      );

      // Set rate limit
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(rateLimitKey, 300, "sent");
      }

      logger.info(`Verification email resent to: ${user.email}`);

      res.json({
        success: true,
        data: { message: "Verification email sent. Please check your inbox." },
      });
    } catch (error) {
      logger.error("Resend verification error:", error);
      next(error);
    }
  },
);

// =====================================================
// PROFILE ROUTES
// =====================================================

/**
 * @route   GET /api/v1/auth/me
 * @desc    Get current authenticated user's profile
 * @access  Private
 */
router.get("/me", authenticateToken, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        regNumber: true,
        staffNumber: true,
        isActive: true,
        emailVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        notificationPref: true,
        devices: {
          where: { isActive: true },
          select: {
            id: true,
            deviceName: true,
            platform: true,
            lastSeenAt: true,
            isTrusted: true,
          },
        },
        _count: {
          select: {
            enrollments: {
              where: { isActive: true },
            },
            taughtCourses: {
              where: { isActive: true },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "User not found" },
      });
    }

    res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    logger.error("Get profile error:", error);
    next(error);
  }
});

/**
 * @route   PUT /api/v1/auth/me
 * @desc    Update current user's profile
 * @access  Private
 */
router.put(
  "/me",
  authenticateToken,
  body("fullName").optional().trim().isLength({ min: 2, max: 100 }),
  body("phone")
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  validate,
  async (req, res, next) => {
    try {
      const { fullName, phone } = req.body;
      const userId = req.user.id;

      // Check if phone is already used
      if (phone) {
        const existingUser = await prisma.user.findFirst({
          where: {
            phone,
            id: { not: userId },
          },
        });

        if (existingUser) {
          return res.status(409).json({
            success: false,
            error: {
              code: "PHONE_EXISTS",
              message: "Phone number already in use",
            },
          });
        }
      }

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          ...(fullName && { fullName }),
          ...(phone && { phone }),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          regNumber: true,
          staffNumber: true,
          updatedAt: true,
        },
      });

      logger.info(`Profile updated for user: ${user.email}`);

      res.json({
        success: true,
        data: { user },
        message: "Profile updated successfully",
      });
    } catch (error) {
      logger.error("Update profile error:", error);
      next(error);
    }
  },
);

// =====================================================
// SESSION MANAGEMENT ROUTES
// =====================================================

/**
 * @route   GET /api/v1/auth/sessions
 * @desc    Get all active sessions for current user
 * @access  Private
 */
router.get("/sessions", authenticateToken, async (req, res, next) => {
  try {
    const sessions = await prisma.refreshToken.findMany({
      where: {
        userId: req.user.id,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
      include: {
        device: {
          select: {
            deviceName: true,
            platform: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      data: sessions,
      meta: {
        total: sessions.length,
        currentSession: req.deviceFingerprint,
      },
    });
  } catch (error) {
    logger.error("Get sessions error:", error);
    next(error);
  }
});

/**
 * @route   DELETE /api/v1/auth/sessions/:sessionId
 * @desc    Revoke a specific session
 * @access  Private
 */
router.delete(
  "/sessions/:sessionId",
  authenticateToken,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;

      const session = await prisma.refreshToken.findFirst({
        where: {
          id: sessionId,
          userId: req.user.id,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Session not found" },
        });
      }

      await prisma.refreshToken.update({
        where: { id: sessionId },
        data: { revoked: true },
      });

      // Clear from Redis
      if (redisClient && redisClient.isReady && session.deviceFingerprint) {
        await redisClient.del(
          `refresh:${req.user.id}:${session.deviceFingerprint}`,
        );
      }

      logger.info(`Session ${sessionId} revoked for user: ${req.user.email}`);

      res.json({
        success: true,
        data: { message: "Session revoked successfully" },
      });
    } catch (error) {
      logger.error("Revoke session error:", error);
      next(error);
    }
  },
);

module.exports = router;
