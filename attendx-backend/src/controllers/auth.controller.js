const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const config = require("../config");
const { sendEmail } = require("../services/email.service");

class AuthController {
  /**
   * Generate JWT tokens
   */
  generateTokens(userId, role) {
    const accessToken = jwt.sign({ userId, role }, config.jwt.secret, {
      expiresIn: config.jwt.accessExpiresIn,
    });
    const refreshToken = jwt.sign({ userId, role }, config.jwt.refreshSecret, {
      expiresIn: config.jwt.refreshExpiresIn,
    });
    return { accessToken, refreshToken };
  }

  /**
   * Login user
   * POST /api/auth/login
   */
  async login(req, res, next) {
    try {
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

      const { email, password, deviceFingerprint, fcmToken, platform } =
        req.body;

      const user = await global.prisma.user.findUnique({
        where: { email },
        include: {
          devices: true,
          notificationPref: true,
        },
      });

      if (!user || !user.isActive) {
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
          },
        });
      }

      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
          },
        });
      }

      // Device registration for mobile
      if (deviceFingerprint) {
        const existingDevice = await global.prisma.device.findUnique({
          where: { deviceFingerprint },
        });

        if (existingDevice && existingDevice.userId !== user.id) {
          return res.status(409).json({
            success: false,
            error: {
              code: "DEVICE_CONFLICT",
              message: "Device already registered to another account",
            },
          });
        }

        await global.prisma.device.upsert({
          where: { deviceFingerprint },
          update: {
            fcmToken: fcmToken || existingDevice?.fcmToken,
            lastSeenAt: new Date(),
            isActive: true,
          },
          create: {
            deviceFingerprint,
            fcmToken,
            platform: platform || "web",
            userId: user.id,
          },
        });
      }

      const { accessToken, refreshToken } = this.generateTokens(
        user.id,
        user.role,
      );

      // Store refresh token in Redis
      await global.redis.setex(
        `refresh:${user.id}`,
        config.jwt.refreshExpiresIn,
        refreshToken,
      );

      const { password: _, ...userWithoutPassword } = user;

      // Log successful login
      logger.info(`User logged in: ${user.email} (${user.role})`);

      res.json({
        success: true,
        data: {
          user: userWithoutPassword,
          tokens: {
            accessToken,
            refreshToken,
            expiresIn: config.jwt.accessExpiresIn,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Refresh access token
   * POST /api/auth/refresh
   */
  async refresh(req, res, next) {
    try {
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

      const { refreshToken } = req.body;

      const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
      const storedToken = await global.redis.get(`refresh:${decoded.userId}`);

      if (!storedToken || storedToken !== refreshToken) {
        return res.status(401).json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Invalid refresh token" },
        });
      }

      const { accessToken, refreshToken: newRefreshToken } =
        this.generateTokens(decoded.userId, decoded.role);
      await global.redis.setex(
        `refresh:${decoded.userId}`,
        config.jwt.refreshExpiresIn,
        newRefreshToken,
      );

      res.json({
        success: true,
        data: {
          accessToken,
          refreshToken: newRefreshToken,
          expiresIn: config.jwt.accessExpiresIn,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Logout user
   * POST /api/auth/logout
   */
  async logout(req, res, next) {
    try {
      await global.redis.del(`refresh:${req.user.id}`);
      logger.info(`User logged out: ${req.user.email}`);
      res.json({ success: true, data: { message: "Logged out successfully" } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Forgot password - send reset link
   * POST /api/auth/forgot-password
   */
  async forgotPassword(req, res, next) {
    try {
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

      const { email } = req.body;
      const user = await global.prisma.user.findUnique({ where: { email } });

      if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 3600000); // 1 hour

        await global.prisma.passwordResetToken.create({
          data: { userId: user.id, token, expiresAt },
        });

        const resetUrl = `${config.frontend.url}/reset-password?token=${token}`;
        await sendEmail(
          email,
          "Reset Your Password - AttendX",
          `<div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #4F46E5;">Reset Your Password</h2>
            <p>Dear ${user.fullName},</p>
            <p>You requested to reset your password. Click the link below to proceed:</p>
            <p><a href="${resetUrl}" style="background: #4F46E5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password</a></p>
            <p>This link will expire in 1 hour.</p>
            <p>If you didn't request this, please ignore this email.</p>
            <hr style="margin: 20px 0;" />
            <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
          </div>`,
        );

        logger.info(`Password reset email sent to: ${email}`);
      }

      // Always return success to prevent email enumeration
      res.json({
        success: true,
        data: { message: "If that email exists, a reset link has been sent" },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reset password with token
   * POST /api/auth/reset-password
   */
  async resetPassword(req, res, next) {
    try {
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

      const { token, newPassword } = req.body;

      const resetToken = await global.prisma.passwordResetToken.findFirst({
        where: {
          token,
          expiresAt: { gt: new Date() },
        },
        include: { user: true },
      });

      if (!resetToken) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_TOKEN", message: "Invalid or expired token" },
        });
      }

      const hashedPassword = await bcrypt.hash(
        newPassword,
        config.security.bcryptRounds,
      );
      await global.prisma.user.update({
        where: { id: resetToken.userId },
        data: { password: hashedPassword },
      });

      await global.prisma.passwordResetToken.deleteMany({
        where: { userId: resetToken.userId },
      });

      logger.info(`Password reset for user: ${resetToken.user.email}`);

      res.json({
        success: true,
        data: { message: "Password reset successfully" },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Change password (authenticated)
   * POST /api/auth/change-password
   */
  async changePassword(req, res, next) {
    try {
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

      const { currentPassword, newPassword } = req.body;

      const user = await global.prisma.user.findUnique({
        where: { id: req.user.id },
      });

      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_PASSWORD",
            message: "Current password is incorrect",
          },
        });
      }

      const hashedPassword = await bcrypt.hash(
        newPassword,
        config.security.bcryptRounds,
      );
      await global.prisma.user.update({
        where: { id: req.user.id },
        data: { password: hashedPassword },
      });

      logger.info(`Password changed for user: ${user.email}`);

      res.json({
        success: true,
        data: { message: "Password changed successfully" },
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
