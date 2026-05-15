const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");

class ConfigController {
  constructor() {
    // Default configuration values
    this.defaultConfig = {
      // Geofence Settings
      defaultGeofenceRadiusM: 50,
      maxGeofenceRadiusM: 500,
      minGeofenceRadiusM: 10,
      
      // Session Settings
      sessionCodeTtlMinutes: 90,
      maxSessionDurationMinutes: 240,
      minSessionDurationMinutes: 15,
      sessionGracePeriodMinutes: 15,
      
      // Attendance Settings
      consecutiveAbsenceWarningThreshold: 2,
      lowAttendanceThreshold: 75,
      criticalAttendanceThreshold: 50,
      attendanceCalculationMethod: "percentage",
      
      // Notification Settings
      smsEnabled: true,
      emailNotificationsEnabled: true,
      pushNotificationsEnabled: true,
      sessionReminderMinutes: [15, 30, 60],
      defaultNotificationPreferences: {
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
      
      // Security Settings
      maxDevicesPerUser: 5,
      sessionTimeoutMinutes: 60,
      maxLoginAttempts: 5,
      passwordExpiryDays: 90,
      mfaRequired: false,
      
      // Academic Settings
      currentAcademicYear: new Date().getFullYear() + "-" + (new Date().getFullYear() + 1),
      currentSemester: 1,
      academicYearStartMonth: 9, // September
      academicYearEndMonth: 6,   // June
      
      // System Settings
      systemName: "AttendX",
      systemEmail: "support@attendx.com",
      systemPhone: "+250788123456",
      timezone: "Africa/Kigali",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "HH:mm:ss",
      
      // Feature Flags
      allowSelfRegistration: false,
      requireEmailVerification: true,
      allowGuestCheckin: false,
      enableGeofencing: true,
      enableSMS: true,
      enablePushNotifications: true,
      enableEmailReports: true,
      
      // Rate Limiting
      rateLimitWindow: 60000, // 1 minute
      rateLimitMax: 100,
      authRateLimitMax: 10,
      
      // Maintenance
      maintenanceMode: false,
      maintenanceMessage: "System under maintenance. Please check back later.",
      lastBackupDate: null,
    };
  }

  /**
   * Get system configuration
   * GET /api/v1/config
   */
  async getConfig(req, res, next) {
    try {
      const cacheKey = "system:config";
      
      // Check cache
      let cachedConfig = null;
      if (redisClient && redisClient.isReady) {
        cachedConfig = await redisClient.get(cacheKey);
        if (cachedConfig) {
          return res.json({
            success: true,
            data: JSON.parse(cachedConfig),
            meta: { cached: true }
          });
        }
      }

      // Get config from database
      let config = await prisma.systemConfig.findUnique({
        where: { id: "singleton" }
      });

      // If no config exists, create with defaults
      if (!config) {
        config = await prisma.systemConfig.create({
          data: {
            id: "singleton",
            defaultGeofenceRadiusM: this.defaultConfig.defaultGeofenceRadiusM,
            sessionCodeTtlMinutes: this.defaultConfig.sessionCodeTtlMinutes,
            consecutiveAbsenceWarningThreshold: this.defaultConfig.consecutiveAbsenceWarningThreshold,
            smsEnabled: this.defaultConfig.smsEnabled,
            emailNotificationsEnabled: this.defaultConfig.emailNotificationsEnabled,
            pushNotificationsEnabled: this.defaultConfig.pushNotificationsEnabled,
            maxConcurrentSessionsPerLecturer: 5,
            maxDevicesPerUser: this.defaultConfig.maxDevicesPerUser,
            sessionCleanupIntervalHours: 24,
            checkinGracePeriodMinutes: this.defaultConfig.sessionGracePeriodMinutes,
          }
        });
      }

      // Merge with defaults for complete config
      const fullConfig = {
        ...this.defaultConfig,
        ...config,
        // Convert JSON fields back to objects
        defaultNotificationPreferences: config.defaultNotificationPreferences 
          ? (typeof config.defaultNotificationPreferences === 'string' 
              ? JSON.parse(config.defaultNotificationPreferences) 
              : config.defaultNotificationPreferences)
          : this.defaultConfig.defaultNotificationPreferences,
        sessionReminderMinutes: config.sessionReminderMinutes
          ? (typeof config.sessionReminderMinutes === 'string'
              ? JSON.parse(config.sessionReminderMinutes)
              : config.sessionReminderMinutes)
          : this.defaultConfig.sessionReminderMinutes,
        maintenanceMessage: config.maintenanceMessage || this.defaultConfig.maintenanceMessage,
        updatedAt: config.updatedAt,
        updatedBy: config.updatedBy,
      };

      // Cache for 10 minutes
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 600, JSON.stringify(fullConfig));
      }

      res.json({
        success: true,
        data: fullConfig,
        meta: {
          version: "1.0.0",
          lastUpdated: config.updatedAt,
        }
      });
    } catch (error) {
      logger.error("Get config error:", error);
      next(error);
    }
  }

  /**
   * Update system configuration
   * PUT /api/v1/config
   */
  async updateConfig(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid input",
            details: errors.array()
          }
        });
      }

      const {
        // Geofence Settings
        defaultGeofenceRadiusM,
        maxGeofenceRadiusM,
        minGeofenceRadiusM,
        
        // Session Settings
        sessionCodeTtlMinutes,
        maxSessionDurationMinutes,
        minSessionDurationMinutes,
        sessionGracePeriodMinutes,
        
        // Attendance Settings
        consecutiveAbsenceWarningThreshold,
        lowAttendanceThreshold,
        criticalAttendanceThreshold,
        
        // Notification Settings
        smsEnabled,
        emailNotificationsEnabled,
        pushNotificationsEnabled,
        sessionReminderMinutes,
        defaultNotificationPreferences,
        
        // Security Settings
        maxDevicesPerUser,
        sessionTimeoutMinutes,
        maxLoginAttempts,
        passwordExpiryDays,
        mfaRequired,
        
        // Academic Settings
        currentAcademicYear,
        currentSemester,
        
        // System Settings
        systemName,
        systemEmail,
        systemPhone,
        timezone,
        
        // Feature Flags
        allowSelfRegistration,
        requireEmailVerification,
        allowGuestCheckin,
        enableGeofencing,
        enableSMS,
        enablePushNotifications,
        enableEmailReports,
        
        // Rate Limiting
        rateLimitWindow,
        rateLimitMax,
        authRateLimitMax,
        
        // Maintenance
        maintenanceMode,
        maintenanceMessage,
      } = req.body;

      // Validate ranges
      if (defaultGeofenceRadiusM !== undefined) {
        if (defaultGeofenceRadiusM < this.defaultConfig.minGeofenceRadiusM || 
            defaultGeofenceRadiusM > this.defaultConfig.maxGeofenceRadiusM) {
          return res.status(400).json({
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: `Geofence radius must be between ${this.defaultConfig.minGeofenceRadiusM} and ${this.defaultConfig.maxGeofenceRadiusM} meters`
            }
          });
        }
      }

      if (sessionCodeTtlMinutes !== undefined) {
        if (sessionCodeTtlMinutes < this.defaultConfig.minSessionDurationMinutes || 
            sessionCodeTtlMinutes > this.defaultConfig.maxSessionDurationMinutes) {
          return res.status(400).json({
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: `Session duration must be between ${this.defaultConfig.minSessionDurationMinutes} and ${this.defaultConfig.maxSessionDurationMinutes} minutes`
            }
          });
        }
      }

      // Get old config for audit
      const oldConfig = await prisma.systemConfig.findUnique({
        where: { id: "singleton" }
      });

      // Prepare update data
      const updateData = {
        ...(defaultGeofenceRadiusM !== undefined && { defaultGeofenceRadiusM }),
        ...(sessionCodeTtlMinutes !== undefined && { sessionCodeTtlMinutes }),
        ...(consecutiveAbsenceWarningThreshold !== undefined && { consecutiveAbsenceWarningThreshold }),
        ...(smsEnabled !== undefined && { smsEnabled }),
        ...(emailNotificationsEnabled !== undefined && { emailNotificationsEnabled }),
        ...(pushNotificationsEnabled !== undefined && { pushNotificationsEnabled }),
        ...(maxDevicesPerUser !== undefined && { maxDevicesPerUser }),
        ...(sessionGracePeriodMinutes !== undefined && { checkinGracePeriodMinutes: sessionGracePeriodMinutes }),
        ...(sessionReminderMinutes !== undefined && { sessionReminderMinutes: JSON.stringify(sessionReminderMinutes) }),
        ...(defaultNotificationPreferences !== undefined && { defaultNotificationPreferences: JSON.stringify(defaultNotificationPreferences) }),
        updatedBy: req.user.id,
        updatedAt: new Date(),
      };

      // Update or create config
      const updatedConfig = await prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: updateData,
        create: {
          id: "singleton",
          ...updateData,
        }
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del("system:config");
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "UPDATE_CONFIG",
          entity: "SystemConfig",
          newValues: updateData,
          oldValues: oldConfig,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      // Emit WebSocket event for config change
      if (global.io) {
        global.io.emit("config_updated", {
          updatedBy: req.user.fullName,
          updatedAt: new Date(),
          changes: Object.keys(updateData)
        });
      }

      logger.info(`System configuration updated by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          config: {
            ...this.defaultConfig,
            ...updatedConfig,
          },
          message: "Configuration updated successfully"
        }
      });
    } catch (error) {
      logger.error("Update config error:", error);
      next(error);
    }
  }

  /**
   * Reset configuration to defaults
   * POST /api/v1/config/reset
   */
  async resetConfig(req, res, next) {
    try {
      const { confirm } = req.body;

      if (!confirm || confirm !== "RESET") {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Please confirm reset by sending 'confirm': 'RESET'"
          }
        });
      }

      // Get old config for audit
      const oldConfig = await prisma.systemConfig.findUnique({
        where: { id: "singleton" }
      });

      // Reset to defaults
      const resetConfig = await prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: {
          defaultGeofenceRadiusM: this.defaultConfig.defaultGeofenceRadiusM,
          sessionCodeTtlMinutes: this.defaultConfig.sessionCodeTtlMinutes,
          consecutiveAbsenceWarningThreshold: this.defaultConfig.consecutiveAbsenceWarningThreshold,
          smsEnabled: this.defaultConfig.smsEnabled,
          emailNotificationsEnabled: this.defaultConfig.emailNotificationsEnabled,
          pushNotificationsEnabled: this.defaultConfig.pushNotificationsEnabled,
          maxDevicesPerUser: this.defaultConfig.maxDevicesPerUser,
          checkinGracePeriodMinutes: this.defaultConfig.sessionGracePeriodMinutes,
          sessionReminderMinutes: JSON.stringify(this.defaultConfig.sessionReminderMinutes),
          defaultNotificationPreferences: JSON.stringify(this.defaultConfig.defaultNotificationPreferences),
          updatedBy: req.user.id,
          updatedAt: new Date(),
        },
        create: {
          id: "singleton",
          defaultGeofenceRadiusM: this.defaultConfig.defaultGeofenceRadiusM,
          sessionCodeTtlMinutes: this.defaultConfig.sessionCodeTtlMinutes,
          consecutiveAbsenceWarningThreshold: this.defaultConfig.consecutiveAbsenceWarningThreshold,
          smsEnabled: this.defaultConfig.smsEnabled,
          emailNotificationsEnabled: this.defaultConfig.emailNotificationsEnabled,
          pushNotificationsEnabled: this.defaultConfig.pushNotificationsEnabled,
          maxDevicesPerUser: this.defaultConfig.maxDevicesPerUser,
          checkinGracePeriodMinutes: this.defaultConfig.sessionGracePeriodMinutes,
          updatedBy: req.user.id,
        }
      });

      // Invalidate cache
      if (redisClient && redisClient.isReady) {
        await redisClient.del("system:config");
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "RESET_CONFIG",
          entity: "SystemConfig",
          oldValues: oldConfig,
          newValues: { reset: true },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`System configuration reset to defaults by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          config: {
            ...this.defaultConfig,
            ...resetConfig,
          },
          message: "Configuration reset to defaults successfully"
        }
      });
    } catch (error) {
      logger.error("Reset config error:", error);
      next(error);
    }
  }

  /**
   * Get public configuration (non-sensitive settings)
   * GET /api/v1/config/public
   */
  async getPublicConfig(req, res, next) {
    try {
      const cacheKey = "system:config:public";
      
      // Check cache
      let cachedConfig = null;
      if (redisClient && redisClient.isReady) {
        cachedConfig = await redisClient.get(cacheKey);
        if (cachedConfig) {
          return res.json({
            success: true,
            data: JSON.parse(cachedConfig),
            meta: { cached: true }
          });
        }
      }

      const config = await prisma.systemConfig.findUnique({
        where: { id: "singleton" }
      });

      // Public settings only (no sensitive data)
      const publicConfig = {
        systemName: this.defaultConfig.systemName,
        systemEmail: this.defaultConfig.systemEmail,
        defaultGeofenceRadiusM: config?.defaultGeofenceRadiusM || this.defaultConfig.defaultGeofenceRadiusM,
        sessionCodeTtlMinutes: config?.sessionCodeTtlMinutes || this.defaultConfig.sessionCodeTtlMinutes,
        sessionGracePeriodMinutes: config?.checkinGracePeriodMinutes || this.defaultConfig.sessionGracePeriodMinutes,
        allowSelfRegistration: this.defaultConfig.allowSelfRegistration,
        requireEmailVerification: this.defaultConfig.requireEmailVerification,
        enableGeofencing: this.defaultConfig.enableGeofencing,
        maintenanceMode: config?.maintenanceMode || this.defaultConfig.maintenanceMode,
        maintenanceMessage: config?.maintenanceMessage || this.defaultConfig.maintenanceMessage,
        currentAcademicYear: this.defaultConfig.currentAcademicYear,
        currentSemester: this.defaultConfig.currentSemester,
        timezone: this.defaultConfig.timezone,
        dateFormat: this.defaultConfig.dateFormat,
        timeFormat: this.defaultConfig.timeFormat,
      };

      // Cache for 1 hour
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(publicConfig));
      }

      res.json({
        success: true,
        data: publicConfig
      });
    } catch (error) {
      logger.error("Get public config error:", error);
      next(error);
    }
  }

  /**
   * Get feature flags
   * GET /api/v1/config/features
   */
  async getFeatureFlags(req, res, next) {
    try {
      const cacheKey = "system:config:features";
      
      let cachedFlags = null;
      if (redisClient && redisClient.isReady) {
        cachedFlags = await redisClient.get(cacheKey);
        if (cachedFlags) {
          return res.json({
            success: true,
            data: JSON.parse(cachedFlags),
            meta: { cached: true }
          });
        }
      }

      const config = await prisma.systemConfig.findUnique({
        where: { id: "singleton" }
      });

      const featureFlags = {
        allowSelfRegistration: this.defaultConfig.allowSelfRegistration,
        requireEmailVerification: this.defaultConfig.requireEmailVerification,
        allowGuestCheckin: this.defaultConfig.allowGuestCheckin,
        enableGeofencing: this.defaultConfig.enableGeofencing,
        enableSMS: config?.smsEnabled ?? this.defaultConfig.enableSMS,
        enablePushNotifications: config?.pushNotificationsEnabled ?? this.defaultConfig.enablePushNotifications,
        enableEmailReports: this.defaultConfig.enableEmailReports,
        mfaRequired: this.defaultConfig.mfaRequired,
        maintenanceMode: config?.maintenanceMode || this.defaultConfig.maintenanceMode,
      };

      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(cacheKey, 300, JSON.stringify(featureFlags));
      }

      res.json({
        success: true,
        data: featureFlags
      });
    } catch (error) {
      logger.error("Get feature flags error:", error);
      next(error);
    }
  }

  /**
   * Toggle maintenance mode
   * POST /api/v1/config/maintenance
   */
  async toggleMaintenanceMode(req, res, next) {
    try {
      const { enabled, message } = req.body;

      const updateData = {
        maintenanceMode: enabled === true || enabled === false ? enabled : !this.defaultConfig.maintenanceMode,
        maintenanceMessage: message || this.defaultConfig.maintenanceMessage,
        updatedBy: req.user.id,
        updatedAt: new Date(),
      };

      const config = await prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: updateData,
        create: {
          id: "singleton",
          ...updateData,
        }
      });

      // Invalidate caches
      if (redisClient && redisClient.isReady) {
        await redisClient.del("system:config");
        await redisClient.del("system:config:public");
        await redisClient.del("system:config:features");
      }

      // Emit WebSocket event
      if (global.io) {
        global.io.emit("maintenance_mode_changed", {
          enabled: config.maintenanceMode,
          message: config.maintenanceMessage,
          updatedBy: req.user.fullName,
        });
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "TOGGLE_MAINTENANCE",
          entity: "SystemConfig",
          newValues: { maintenanceMode: config.maintenanceMode, message: config.maintenanceMessage },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(`Maintenance mode ${config.maintenanceMode ? 'enabled' : 'disabled'} by ${req.user.email}`);

      res.json({
        success: true,
        data: {
          maintenanceMode: config.maintenanceMode,
          maintenanceMessage: config.maintenanceMessage,
        },
        message: `Maintenance mode ${config.maintenanceMode ? 'enabled' : 'disabled'} successfully`
      });
    } catch (error) {
      logger.error("Toggle maintenance mode error:", error);
      next(error);
    }
  }

  /**
   * Get configuration history
   * GET /api/v1/config/history
   */
  async getConfigHistory(req, res, next) {
    try {
      const { page = 1, limit = 20 } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [history, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: { action: "UPDATE_CONFIG", entity: "SystemConfig" },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
              }
            }
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.auditLog.count({
          where: { action: "UPDATE_CONFIG", entity: "SystemConfig" }
        })
      ]);

      res.json({
        success: true,
        data: history,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        }
      });
    } catch (error) {
      logger.error("Get config history error:", error);
      next(error);
    }
  }

  /**
   * Validate configuration before applying
   * POST /api/v1/config/validate
   */
  async validateConfig(req, res, next) {
    try {
      const config = req.body;
      const errors = [];

      // Validate geofence radius
      if (config.defaultGeofenceRadiusM) {
        if (config.defaultGeofenceRadiusM < this.defaultConfig.minGeofenceRadiusM ||
            config.defaultGeofenceRadiusM > this.defaultConfig.maxGeofenceRadiusM) {
          errors.push({
            field: "defaultGeofenceRadiusM",
            message: `Must be between ${this.defaultConfig.minGeofenceRadiusM} and ${this.defaultConfig.maxGeofenceRadiusM} meters`
          });
        }
      }

      // Validate session duration
      if (config.sessionCodeTtlMinutes) {
        if (config.sessionCodeTtlMinutes < this.defaultConfig.minSessionDurationMinutes ||
            config.sessionCodeTtlMinutes > this.defaultConfig.maxSessionDurationMinutes) {
          errors.push({
            field: "sessionCodeTtlMinutes",
            message: `Must be between ${this.defaultConfig.minSessionDurationMinutes} and ${this.defaultConfig.maxSessionDurationMinutes} minutes`
          });
        }
      }

      // Validate device limit
      if (config.maxDevicesPerUser) {
        if (config.maxDevicesPerUser < 1 || config.maxDevicesPerUser > 20) {
          errors.push({
            field: "maxDevicesPerUser",
            message: "Must be between 1 and 20"
          });
        }
      }

      // Validate grace period
      if (config.checkinGracePeriodMinutes) {
        if (config.checkinGracePeriodMinutes < 0 || config.checkinGracePeriodMinutes > 60) {
          errors.push({
            field: "checkinGracePeriodMinutes",
            message: "Must be between 0 and 60 minutes"
          });
        }
      }

      // Validate email format
      if (config.systemEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.systemEmail)) {
        errors.push({
          field: "systemEmail",
          message: "Invalid email format"
        });
      }

      res.json({
        success: errors.length === 0,
        data: {
          isValid: errors.length === 0,
          errors: errors,
          warnings: [] // Add warnings if needed
        }
      });
    } catch (error) {
      logger.error("Validate config error:", error);
      next(error);
    }
  }
}

module.exports = new ConfigController();