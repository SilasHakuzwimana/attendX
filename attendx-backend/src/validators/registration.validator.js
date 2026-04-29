const { body } = require("express-validator");

const registerValidator = [
  // Full name
  body("fullName")
    .trim()
    .notEmpty()
    .withMessage("Full name is required")
    .isLength({ min: 2, max: 100 })
    .withMessage("Full name must be between 2 and 100 characters")
    .matches(/^[a-zA-Z\s'-.]+$/)
    .withMessage(
      "Full name can only contain letters, spaces, hyphens, apostrophes, and periods",
    ),

  // Email
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Please provide a valid email")
    .normalizeEmail(),

  // Phone (optional)
  body("phone")
    .optional({ values: "falsy" })
    .trim()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage("Please provide a valid phone number with country code"),

  // Password
  body("password")
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/)
    .withMessage(
      "Password must contain uppercase, lowercase, number, and special character",
    ),

  // Role
  body("role")
    .trim()
    .notEmpty()
    .withMessage("Role is required")
    .isIn(["student", "lecturer", "admin"])
    .withMessage("Role must be: student, lecturer, or admin"),

  // Registration number (required for students)
  body("regNumber")
    .if(body("role").equals("student"))
    .trim()
    .notEmpty()
    .withMessage("Registration number is required for students")
    .matches(/^\d{9}$/)
    .withMessage(
      "Registration number must be exactly 9 digits (e.g., 222001019)",
    ),

  // Staff number (required for lecturers and admins)
  body("staffNumber")
    .if(body("role").isIn(["lecturer", "admin"]))
    .trim()
    .notEmpty()
    .withMessage("Staff number is required for lecturers and admins")
    .matches(/^[A-Z]{3,4}-\d{4}-\d{3}$/)
    .withMessage("Staff number format: XXX-YYYY-NNN (e.g., LEC-2024-001)"),
];

const loginValidator = [
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Please provide a valid email")
    .normalizeEmail(),

  body("password").notEmpty().withMessage("Password is required"),

  body("deviceFingerprint").optional().trim(),

  body("fcmToken").optional().trim(),

  body("platform")
    .optional()
    .isIn(["android", "ios", "web"])
    .withMessage("Platform must be: android, ios, or web"),
];

const forgotPasswordValidator = [
  body("email")
    .trim()
    .notEmpty()
    .withMessage("Email is required")
    .isEmail()
    .withMessage("Please provide a valid email"),
];

const resetPasswordValidator = [
  body("token").trim().notEmpty().withMessage("Reset token is required"),

  body("newPassword")
    .notEmpty()
    .withMessage("New password is required")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/)
    .withMessage(
      "Password must contain uppercase, lowercase, number, and special character",
    ),
];

const changePasswordValidator = [
  body("currentPassword")
    .notEmpty()
    .withMessage("Current password is required"),

  body("newPassword")
    .notEmpty()
    .withMessage("New password is required")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/)
    .withMessage(
      "Password must contain uppercase, lowercase, number, and special character",
    ),
];

module.exports = {
  registerValidator,
  loginValidator,
  forgotPasswordValidator,
  resetPasswordValidator,
  changePasswordValidator,
};
