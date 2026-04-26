const express = require("express");
const { body } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { loginLimiter } = require("../middleware/rateLimit.middleware");
const { authenticateToken } = require("../middleware/auth.middleware");
const authController = require("../controllers/auth.controller");
const config = require("../config");

const router = express.Router();

/**
 * @route   POST /api/auth/login
 * @desc    Login user
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

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post(
  "/refresh",
  body("refreshToken").notEmpty().withMessage("Refresh token is required"),
  validate,
  authController.refresh,
);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user
 * @access  Private
 */
router.post("/logout", authenticateToken, authController.logout);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request password reset
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
 * @route   POST /api/auth/reset-password
 * @desc    Reset password with token
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
 * @route   POST /api/auth/change-password
 * @desc    Change password (authenticated)
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

/**
 * @route   POST /api/auth/logout-all
 * @desc    Logout from all devices
 * @access  Private
 */
router.post("/logout-all", authenticateToken, async (req, res, next) => {
  try {
    // Delete all refresh tokens for this user
    const keys = await global.redis.keys(`refresh:${req.user.id}:*`);
    if (keys.length > 0) {
      await global.redis.del(keys);
    }

    // Deactivate all devices
    await global.prisma.device.updateMany({
      where: { userId: req.user.id },
      data: { isActive: false },
    });

    res.json({
      success: true,
      data: { message: "Logged out from all devices successfully" },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/verify-email
 * @desc    Verify email address
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

      // Update user as verified
      await global.prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerified: true,
          emailVerificationToken: null,
        },
      });

      res.json({
        success: true,
        data: { message: "Email verified successfully" },
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
