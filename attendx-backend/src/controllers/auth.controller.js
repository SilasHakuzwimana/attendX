const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const config = require("../config");
const { sendEmail } = require("../services/email.service");
const { prisma, redisClient } = require("../config/index");

class AuthController {
  /**
   * Generate JWT tokens
   */
  static generateTokens(userId, role, deviceFingerprint = null) {
    const accessToken = jwt.sign(
      { userId, role, deviceFingerprint, type: "access" },
      config.jwt.accessSecret || config.jwt.secret,
      { expiresIn: config.jwt.accessExpiresIn || "1h" },
    );

    const refreshToken = jwt.sign(
      { userId, role, deviceFingerprint, type: "refresh" },
      config.jwt.refreshSecret || config.jwt.secret,
      { expiresIn: config.jwt.refreshExpiresIn || "7d" },
    );

    return { accessToken, refreshToken };
  }

  /**
   * Hash refresh token for storage
   */
  static hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Set secure cookies
   */
  static setTokenCookies(res, accessToken, refreshToken) {
    const isProduction = config.nodeEnv === "production";

    // Access token cookie (short-lived)
    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "strict" : "lax",
      maxAge: parseInt(config.jwt.accessExpiresIn) * 1000,
      path: "/",
    });

    // Refresh token cookie (longer-lived)
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "strict" : "lax",
      maxAge: parseInt(config.jwt.refreshExpiresIn) * 1000,
      path: "/api/v1/auth",
    });
  }

  /**
   * Clear cookies on logout
   */
  static clearTokenCookies(res) {
    res.clearCookie("accessToken", { path: "/" });
    res.clearCookie("refreshToken", { path: "/api/v1/auth" });
  }

  /**
   * Login user
   * POST /api/v1/auth/login
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
            details: errors.array(),
          },
        });
      }

      const {
        email,
        password,
        deviceFingerprint,
        fcmToken,
        platform,
        deviceName,
      } = req.body;

      // Find user with relations
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        include: {
          notificationPref: true,
          devices: {
            where: { isActive: true },
            take: 5,
          },
        },
      });

      // Check if user exists and is active
      if (!user) {
        logger.warn(`Login failed: User not found - ${email}`);
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
          },
        });
      }

      if (!user.isActive) {
        logger.warn(`Login failed: Account inactive - ${email}`);
        return res.status(401).json({
          success: false,
          error: {
            code: "ACCOUNT_INACTIVE",
            message:
              "Your account has been deactivated. Please contact support.",
          },
        });
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.passwordHash);
      if (!isValidPassword) {
        logger.warn(`Login failed: Invalid password - ${email}`);
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
          },
        });
      }

      // Device registration/update for mobile
      if (deviceFingerprint) {
        const existingDevice = await prisma.device.findUnique({
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

        // Check device limit
        const deviceCount = await prisma.device.count({
          where: { userId: user.id, isActive: true },
        });

        const maxDevices = 5; // Can be moved to config
        if (!existingDevice && deviceCount >= maxDevices) {
          return res.status(400).json({
            success: false,
            error: {
              code: "DEVICE_LIMIT_EXCEEDED",
              message: `Maximum ${maxDevices} devices allowed. Please remove an existing device first.`,
            },
          });
        }

        await prisma.device.upsert({
          where: { deviceFingerprint },
          update: {
            fcmToken: fcmToken || existingDevice?.fcmToken,
            lastSeenAt: new Date(),
            isActive: true,
            platform: platform || existingDevice?.platform || "web",
            deviceName: deviceName || existingDevice?.deviceName,
          },
          create: {
            deviceFingerprint,
            fcmToken,
            platform: platform || "web",
            userId: user.id,
            deviceName: deviceName || "Unknown Device",
            isActive: true,
            isTrusted: true,
          },
        });
      }

      // Generate tokens with device fingerprint
      const { accessToken, refreshToken } = AuthController.generateTokens(
        user.id,
        user.role,
        deviceFingerprint,
      );

      // Hash and store refresh token in database
      const tokenHash = AuthController.hashToken(refreshToken);
      const refreshTokenExpiry = new Date();
      refreshTokenExpiry.setDate(refreshTokenExpiry.getDate() + 7); // 7 days

      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash,
          deviceFingerprint: deviceFingerprint || null,
          expiresAt: refreshTokenExpiry,
          revoked: false,
        },
      });

      // Also store in Redis for faster access
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(
          `refresh:${user.id}:${deviceFingerprint || "default"}`,
          7 * 24 * 60 * 60, // 7 days in seconds
          refreshToken,
        );
      }

      // Update last login timestamp
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      // Set cookies
      AuthController.setTokenCookies(res, accessToken, refreshToken);

      // Remove sensitive data
      const {
        passwordHash,
        resetToken,
        resetTokenExpires,
        ...userWithoutPassword
      } = user;

      logger.info(
        `User logged in: ${user.email} (${user.role}) - Device: ${deviceFingerprint ? "Mobile" : "Web"}`,
      );

      res.json({
        success: true,
        data: {
          user: userWithoutPassword,
          tokens: {
            accessToken,
            refreshToken,
            expiresIn: config.jwt.accessExpiresIn,
          },
          device: deviceFingerprint
            ? {
                registered: true,
                fingerprint: deviceFingerprint,
              }
            : null,
        },
      });
    } catch (error) {
      logger.error("Login error:", error);
      next(error);
    }
  }

  /**
   * Refresh access token
   * POST /api/v1/auth/refresh
   */
  async refresh(req, res, next) {
    try {
      const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

      if (!refreshToken) {
        return res.status(401).json({
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Refresh token is required",
          },
        });
      }

      // Verify JWT
      let decoded;
      try {
        decoded = jwt.verify(
          refreshToken,
          config.jwt.refreshSecret || config.jwt.secret,
        );
      } catch (err) {
        logger.warn("Invalid refresh token:", err.message);
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_TOKEN",
            message: "Invalid or expired refresh token",
          },
        });
      }

      // Hash the incoming token and check in database
      const tokenHash = AuthController.hashToken(refreshToken);
      const storedToken = await prisma.refreshToken.findFirst({
        where: {
          userId: decoded.userId,
          tokenHash,
          revoked: false,
          expiresAt: { gt: new Date() },
        },
      });

      if (!storedToken) {
        logger.warn(
          `Refresh token not found in DB for user: ${decoded.userId}`,
        );
        return res.status(401).json({
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid refresh token",
          },
        });
      }

      // Get user to verify still active
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId, isActive: true },
        select: { id: true, role: true, isActive: true },
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "User not found or inactive",
          },
        });
      }

      // Revoke the old token (rotation for security)
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revoked: true },
      });

      // Generate new tokens
      const { accessToken, refreshToken: newRefreshToken } =
        AuthController.generateTokens(
          decoded.userId,
          user.role,
          storedToken.deviceFingerprint,
        );

      // Store new refresh token
      const newTokenHash = AuthController.hashToken(newRefreshToken);
      const newExpiry = new Date();
      newExpiry.setDate(newExpiry.getDate() + 7);

      await prisma.refreshToken.create({
        data: {
          userId: decoded.userId,
          tokenHash: newTokenHash,
          deviceFingerprint: storedToken.deviceFingerprint,
          expiresAt: newExpiry,
          revoked: false,
        },
      });

      // Update Redis
      if (redisClient && redisClient.isReady) {
        await redisClient.del(
          `refresh:${decoded.userId}:${storedToken.deviceFingerprint || "default"}`,
        );
        await redisClient.setEx(
          `refresh:${decoded.userId}:${storedToken.deviceFingerprint || "default"}`,
          7 * 24 * 60 * 60,
          newRefreshToken,
        );
      }

      // Set new cookies
      AuthController.setTokenCookies(res, accessToken, newRefreshToken);

      logger.info(`Token refreshed for user: ${decoded.userId}`);

      res.json({
        success: true,
        data: {
          accessToken,
          refreshToken: newRefreshToken,
          expiresIn: config.jwt.accessExpiresIn,
        },
      });
    } catch (error) {
      logger.error("Refresh token error:", error);
      next(error);
    }
  }

  /**
   * Logout user
   * POST /api/v1/auth/logout
   */
  async logout(req, res, next) {
    try {
      const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
      const deviceFingerprint =
        req.deviceFingerprint || req.body?.deviceFingerprint;

      if (refreshToken) {
        const tokenHash = AuthController.hashToken(refreshToken);

        // Revoke the specific refresh token
        await prisma.refreshToken.updateMany({
          where: { tokenHash },
          data: { revoked: true },
        });

        // Remove from Redis
        if (redisClient && redisClient.isReady && req.user?.id) {
          await redisClient.del(
            `refresh:${req.user.id}:${deviceFingerprint || "default"}`,
          );
        }
      } else if (req.user?.id) {
        // If no specific token, revoke all user tokens (logout from all devices)
        await prisma.refreshToken.updateMany({
          where: { userId: req.user.id, revoked: false },
          data: { revoked: true },
        });

        // Clear all Redis refresh tokens for user
        if (redisClient && redisClient.isReady) {
          const keys = await redisClient.keys(`refresh:${req.user.id}:*`);
          if (keys.length > 0) {
            await redisClient.del(keys);
          }
        }
      }

      // Clear cookies
      AuthController.clearTokenCookies(res);

      if (req.user) {
        logger.info(`User logged out: ${req.user.email}`);
      }

      res.json({
        success: true,
        data: { message: "Logged out successfully" },
      });
    } catch (error) {
      logger.error("Logout error:", error);
      next(error);
    }
  }

  /**
   * Forgot password - send reset link
   * POST /api/v1/auth/forgot-password
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
            details: errors.array(),
          },
        });
      }

      const { email } = req.body;
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (user && user.isActive) {
        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto
          .createHash("sha256")
          .update(resetToken)
          .digest("hex");
        const expiresAt = new Date(Date.now() + 3600000); // 1 hour

        // Store hashed token in database
        await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt,
          },
        });

        const resetUrl = `${config.frontend.url}/reset-password?token=${resetToken}`;

        await sendEmail(
          user.email,
          "Reset Your Password - AttendX",
          `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0;">AttendX</h1>
            </div>
            <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
              <h2 style="color: #333;">Reset Your Password</h2>
              <p>Dear ${user.fullName},</p>
              <p>You requested to reset your password. Click the button below to proceed:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
              </div>
              <p>This link will expire in <strong>1 hour</strong>.</p>
              <p>If you didn't request this, please ignore this email.</p>
              <hr style="margin: 20px 0;" />
              <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
            </div>
          </div>
          `,
        );

        logger.info(`Password reset email sent to: ${email}`);
      } else if (user && !user.isActive) {
        logger.warn(`Password reset requested for inactive account: ${email}`);
      } else {
        logger.info(
          `Password reset requested for non-existent email: ${email}`,
        );
      }

      // Always return success to prevent email enumeration
      res.json({
        success: true,
        data: {
          message:
            "If that email exists and is active, a reset link has been sent",
        },
      });
    } catch (error) {
      logger.error("Forgot password error:", error);
      next(error);
    }
  }

  /**
   * Reset password with token
   * POST /api/v1/auth/reset-password
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
            details: errors.array(),
          },
        });
      }

      const { token, newPassword } = req.body;

      // Hash the incoming token to compare with stored hash
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const resetToken = await prisma.passwordResetToken.findFirst({
        where: {
          tokenHash,
          expiresAt: { gt: new Date() },
          usedAt: null, // Token not used yet
        },
        include: { user: true },
      });

      if (!resetToken) {
        return res.status(400).json({
          success: false,
          error: {
            code: "INVALID_TOKEN",
            message: "Invalid or expired reset token",
          },
        });
      }

      if (!resetToken.user.isActive) {
        return res.status(400).json({
          success: false,
          error: {
            code: "ACCOUNT_INACTIVE",
            message: "Account is deactivated. Please contact support.",
          },
        });
      }

      // Hash new password
      const saltRounds = parseInt(config.security?.bcryptRounds) || 10;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

      // Update user password
      await prisma.user.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash: hashedPassword,
        },
      });

      // Mark token as used
      await prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      });

      // Revoke all refresh tokens for security
      await prisma.refreshToken.updateMany({
        where: { userId: resetToken.userId, revoked: false },
        data: { revoked: true },
      });

      // Clear Redis refresh tokens
      if (redisClient && redisClient.isReady) {
        const keys = await redisClient.keys(`refresh:${resetToken.userId}:*`);
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
      }

      logger.info(
        `Password reset successful for user: ${resetToken.user.email}`,
      );

      // Send confirmation email
      await sendEmail(
        resetToken.user.email,
        "Password Reset Successful - AttendX",
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #28a745; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0;">AttendX</h1>
          </div>
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333;">Password Reset Successful</h2>
            <p>Dear ${resetToken.user.fullName},</p>
            <p>Your password has been successfully reset.</p>
            <p>If you did not perform this action, please contact support immediately.</p>
            <hr style="margin: 20px 0;" />
            <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
          </div>
        </div>
        `,
      );

      res.json({
        success: true,
        data: {
          message:
            "Password reset successfully. You can now login with your new password.",
        },
      });
    } catch (error) {
      logger.error("Reset password error:", error);
      next(error);
    }
  }

  /**
   * Change password (authenticated)
   * POST /api/v1/auth/change-password
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
            details: errors.array(),
          },
        });
      }

      const { currentPassword, newPassword } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
      });

      if (!user || !user.isActive) {
        return res.status(404).json({
          success: false,
          error: {
            code: "USER_NOT_FOUND",
            message: "User not found or inactive",
          },
        });
      }

      const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_PASSWORD",
            message: "Current password is incorrect",
          },
        });
      }

      const saltRounds = parseInt(config.security?.bcryptRounds) || 10;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

      await prisma.user.update({
        where: { id: req.user.id },
        data: {
          passwordHash: hashedPassword,
        },
      });

      // Optionally revoke all other sessions (except current)
      const shouldRevokeAllSessions = req.body.revokeAllSessions === true;
      if (shouldRevokeAllSessions) {
        const currentRefreshToken = req.cookies?.refreshToken;
        let currentTokenHash = null;

        if (currentRefreshToken) {
          currentTokenHash = AuthController.hashToken(currentRefreshToken);
        }

        await prisma.refreshToken.updateMany({
          where: {
            userId: req.user.id,
            revoked: false,
            ...(currentTokenHash
              ? { tokenHash: { not: currentTokenHash } }
              : {}),
          },
          data: { revoked: true },
        });

        logger.info(`All other sessions revoked for user: ${user.email}`);
      }

      logger.info(`Password changed for user: ${user.email}`);

      res.json({
        success: true,
        data: {
          message: shouldRevokeAllSessions
            ? "Password changed successfully. You have been logged out from all other devices."
            : "Password changed successfully",
        },
      });
    } catch (error) {
      logger.error("Change password error:", error);
      next(error);
    }
  }

  /**
   * Verify email (if email verification is enabled)
   * POST /api/v1/auth/verify-email
   */
  async verifyEmail(req, res, next) {
    try {
      const { token } = req.body;

      // Implementation depends on your email verification strategy
      // This is a placeholder for future implementation

      res.json({
        success: true,
        data: { message: "Email verified successfully" },
      });
    } catch (error) {
      logger.error("Verify email error:", error);
      next(error);
    }
  }
}

module.exports = new AuthController();
