const express = require("express");
const { body } = require("express-validator");
const { validate } = require("../middleware/validation.middleware");
const {
  authenticateToken,
  requireRole,
} = require("../middleware/auth.middleware");
const smsController = require("../controllers/sms.controller");

const router = express.Router();

/**
 * @route   POST /api/sms/webhook
 * @desc    Twilio SMS webhook handler
 * @access  Public (Twilio calls this)
 */
router.post("/webhook", smsController.handleIncomingSMS.bind(smsController));

/**
 * @route   POST /api/sms/broadcast
 * @desc    Broadcast SMS to course students
 * @access  Private (Lecturer/Admin only)
 */
router.post(
  "/broadcast",
  authenticateToken,
  requireRole("lecturer", "admin"),
  body("courseId").isUUID().withMessage("Valid course ID is required"),
  body("message")
    .notEmpty()
    .isLength({ max: 160 })
    .withMessage("Message must be between 1 and 160 characters"),
  validate,
  smsController.broadcastSMS.bind(smsController),
);

/**
 * @route   POST /api/sms/test
 * @desc    Test SMS sending (development only)
 * @access  Private (Development only)
 */
if (process.env.NODE_ENV === "development") {
  router.post(
    "/test",
    authenticateToken,
    body("to")
      .matches(/^\+?[1-9]\d{1,14}$/)
      .withMessage("Valid phone number required"),
    body("message").notEmpty().isLength({ max: 160 }),
    validate,
    smsController.testSMS.bind(smsController),
  );
}

/**
 * @route   GET /api/sms/history/:courseId
 * @desc    Get SMS history for a course
 * @access  Private (Lecturer/Admin only)
 */
router.get(
  "/history/:courseId",
  authenticateToken,
  requireRole("lecturer", "admin"),
  async (req, res, next) => {
    try {
      const { courseId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const skip = (page - 1) * limit;

      // Note: You need to create an SMSLog model in Prisma
      // This is a placeholder
      const logs = [];
      const total = 0;

      res.json({
        success: true,
        data: logs,
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
  },
);

/**
 * @route   GET /api/sms/remaining-credits
 * @desc    Get remaining SMS credits (if using prepaid)
 * @access  Private (Admin only)
 */
router.get(
  "/remaining-credits",
  authenticateToken,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      // This would call Twilio API to get balance
      // Placeholder response
      res.json({
        success: true,
        data: {
          remaining: 1000,
          currency: "USD",
          lastUpdated: new Date(),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
