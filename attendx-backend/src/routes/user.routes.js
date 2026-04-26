const express = require("express");
const { body } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const { authenticateToken } = require("../middleware/auth.middleware");
const userController = require("../controllers/user.controller");

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * @route   GET /api/users/me
 * @desc    Get own profile
 * @access  Private
 */
router.get("/me", userController.getProfile);

/**
 * @route   PATCH /api/users/me
 * @desc    Update own profile
 * @access  Private
 */
router.patch(
  "/me",
  body("fullName").optional().isString().trim().notEmpty(),
  body("phone")
    .optional()
    .isString()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Invalid phone number format"),
  validate,
  userController.updateProfile,
);

/**
 * @route   GET /api/users/me/notification-preferences
 * @desc    Get notification preferences
 * @access  Private
 */
router.get(
  "/me/notification-preferences",
  userController.getNotificationPreferences,
);

/**
 * @route   PUT /api/users/me/notification-preferences
 * @desc    Update notification preferences
 * @access  Private
 */
router.put(
  "/me/notification-preferences",
  body("attendanceConfirmation").optional().isBoolean(),
  body("missedAttendance").optional().isBoolean(),
  body("absenceWarning").optional().isBoolean(),
  body("sessionStarted").optional().isBoolean(),
  validate,
  userController.updateNotificationPreferences,
);

/**
 * @route   GET /api/users/me/sessions
 * @desc    Get user's sessions (attendance history)
 * @access  Private
 */
router.get("/me/sessions", async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const [sessions, total] = await Promise.all([
      global.prisma.session.findMany({
        where: { lecturerId: req.user.id },
        include: {
          course: true,
          classroom: true,
          _count: { select: { roomCheckins: true } },
        },
        orderBy: { startedAt: "desc" },
        skip: parseInt(skip),
        take: parseInt(limit),
      }),
      global.prisma.session.count({ where: { lecturerId: req.user.id } }),
    ]);

    res.json({
      success: true,
      data: sessions,
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
});

/**
 * @route   DELETE /api/users/me/account
 * @desc    Request account deletion
 * @access  Private
 */
router.delete("/me/account", async (req, res, next) => {
  try {
    // Soft delete - just deactivate
    await global.prisma.user.update({
      where: { id: req.user.id },
      data: { isActive: false },
    });

    // Invalidate all tokens
    await global.redis.del(`refresh:${req.user.id}`);

    res.json({
      success: true,
      data: { message: "Account deactivated successfully" },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
