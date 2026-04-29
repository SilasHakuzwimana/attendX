const express = require("express");
const { body } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { loginLimiter } = require("../middleware/rateLimit.middleware");
const { authenticateToken } = require("../middleware/auth.middleware");
const authController = require("../controllers/auth.controller");
const registrationController = require("../controllers/registration.controller");
const config = require("../config");

const {
  registerValidator,
  loginValidator,
  forgotPasswordValidator,
  resetPasswordValidator,
  changePasswordValidator,
} = require("../validators/registration.validator");

const router = express.Router();

// =====================================================
// REGISTRATION ROUTES
// =====================================================

/**
 * @route   POST /api/v1/auth/register
 * @desc    Register a new user (student, lecturer, or admin)
 * @access  Public
 */
router.post("/register", registerValidator, validate, (req, res, next) =>
  registrationController.register(req, res, next),
);

/**
 * @route   GET /api/v1/auth/check-email
 * @desc    Check if email is available for registration
 * @access  Public
 */
router.get("/check-email", (req, res, next) =>
  registrationController.checkEmail(req, res, next),
);

/**
 * @route   GET /api/v1/auth/check-regnumber
 * @desc    Check if student registration number is available
 * @access  Public
 */
router.get("/check-regnumber", (req, res, next) =>
  registrationController.checkRegNumber(req, res, next),
);

/**
 * @route   GET /api/v1/auth/check-staffnumber
 * @desc    Check if staff number is available for lecturers/admins
 * @access  Public
 */
router.get("/check-staffnumber", (req, res, next) =>
  registrationController.checkStaffNumber(req, res, next),
);

// =====================================================
// LOGIN ROUTES
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
  validate,
  authController.login,
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
  body("refreshToken").notEmpty().withMessage("Refresh token is required"),
  validate,
  authController.refresh,
);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout current device
 * @access  Private
 */
router.post("/logout", authenticateToken, authController.logout);

/**
 * @route   POST /api/v1/auth/logout-all
 * @desc    Logout from all devices (clear refresh tokens & deactivate devices)
 * @access  Private
 */
router.post("/logout-all", authenticateToken, async (req, res, next) => {
  try {
    // Delete all refresh tokens for this user from Redis
    const keys = await global.redis.keys(`refresh:${req.user.id}:*`);
    if (keys.length > 0) {
      await global.redis.del(keys);
    }

    // Deactivate all user's devices
    await global.prisma.device.updateMany({
      where: { userId: req.user.id },
      data: { isActive: false },
    });

    // Log the logout
    const logger = require("../utils/logger");
    logger.info(`User logged out from all devices: ${req.user.email}`);

    res.json({
      success: true,
      data: { message: "Logged out from all devices successfully" },
    });
  } catch (error) {
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
  authController.forgotPassword,
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
    .isLength({ min: config.security.passwordMinLength })
    .withMessage(
      `Password must be at least ${config.security.passwordMinLength} characters`,
    )
    .matches(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    )
    .withMessage(
      "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
    ),
  validate,
  authController.resetPassword,
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
    .isLength({ min: config.security.passwordMinLength })
    .withMessage(
      `Password must be at least ${config.security.passwordMinLength} characters`,
    )
    .matches(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
    )
    .withMessage(
      "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
    ),
  validate,
  authController.changePassword,
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
  async (req, res, next) => {
    try {
      const { token } = req.body;

      // Find user by verification token
      const user = await global.prisma.user.findFirst({
        where: { emailVerificationToken: token },
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
      await global.prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
        },
      });

      const logger = require("../utils/logger");
      logger.info(`Email verified for user: ${user.email}`);

      res.json({
        success: true,
        data: { message: "Email verified successfully" },
      });
    } catch (error) {
      next(error);
    }
  },
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
      const user = await global.prisma.user.findUnique({
        where: { id: req.user.id },
      });

      if (user.emailVerified) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ALREADY_VERIFIED",
            message: "Email is already verified",
          },
        });
      }

      // Generate new verification token
      const crypto = require("crypto");
      const verificationToken = crypto.randomBytes(32).toString("hex");

      await global.prisma.user.update({
        where: { id: user.id },
        data: { emailVerificationToken: verificationToken },
      });

      // Send verification email
      const { sendEmail } = require("../services/email.service");
      const verificationUrl = `${config.frontend.url}/verify-email?token=${verificationToken}`;

      await sendEmail(
        user.email,
        "Verify Your Email - AttendX",
        `<div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #4F46E5;">Verify Your Email Address</h2>
          <p>Dear ${user.fullName},</p>
          <p>Please click the button below to verify your email address:</p>
          <p><a href="${verificationUrl}" style="background: #4F46E5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verify Email</a></p>
          <p>If you didn't create an account, please ignore this email.</p>
        </div>`,
      );

      res.json({
        success: true,
        data: { message: "Verification email sent" },
      });
    } catch (error) {
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
    const user = await global.prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        notificationPref: true,
        devices: {
          where: { isActive: true },
        },
        enrollments: {
          include: {
            course: true,
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

    const { password, ...userWithoutPassword } = user;

    res.json({
      success: true,
      data: { user: userWithoutPassword },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;