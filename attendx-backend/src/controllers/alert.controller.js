const { validationResult } = require("express-validator");
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const { sendEmail } = require("../services/email.service");
const { sendPushNotification } = require("../services/notification.service");

class AlertController {
  constructor() {
    this.alertTypes = {
      LOW_ATTENDANCE: "low_attendance",
      CONSECUTIVE_ABSENCE: "consecutive_absence",
      SESSION_REMINDER: "session_reminder",
      SESSION_STARTED: "session_started",
      SESSION_EXTENDED: "session_extended",
      SESSION_CLOSING: "session_closing",
      ATTENDANCE_OVERRIDE: "attendance_override",
      COURSE_ANNOUNCEMENT: "course_announcement",
      SYSTEM_MAINTENANCE: "system_maintenance",
      ACHIEVEMENT: "achievement",
      WARNING: "warning",
      INFO: "info",
    };
  }

  /**
   * Check and generate attendance alerts for students
   * GET /api/v1/alerts/check-attendance
   */
  async checkAttendanceAlerts(req, res, next) {
    try {
      const { studentId, courseId } = req.query;
      const targetStudentId = studentId || req.user.id;

      // Check permission
      if (req.user.role === "student" && req.user.id !== targetStudentId) {
        return res.status(403).json({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You can only check your own alerts",
          },
        });
      }

      const alerts = [];

      // Get student's courses
      const enrollments = await prisma.enrollment.findMany({
        where: {
          studentId: targetStudentId,
          isActive: true,
          ...(courseId && { courseId }),
        },
        include: {
          course: {
            select: {
              id: true,
              code: true,
              name: true,
              credits: true,
            },
          },
        },
      });

      for (const enrollment of enrollments) {
        // Get attendance records
        const records = await prisma.attendanceRecord.findMany({
          where: {
            studentId: targetStudentId,
            session: { courseId: enrollment.courseId },
          },
          select: { status: true, markedAt: true },
          orderBy: { markedAt: "desc" },
        });

        const totalSessions = records.length;
        if (totalSessions === 0) continue;

        const attended = records.filter(
          (r) => r.status === "present" || r.status === "late",
        ).length;
        const attendanceRate = (attended / totalSessions) * 100;

        // Check low attendance (below 75%)
        if (attendanceRate < 75) {
          const severity = attendanceRate < 50 ? "critical" : "warning";

          // Check if alert was already sent recently
          const alertKey = `alert:low_attendance:${targetStudentId}:${enrollment.courseId}`;
          let lastAlertSent = null;

          if (redisClient && redisClient.isReady) {
            lastAlertSent = await redisClient.get(alertKey);
          }

          if (!lastAlertSent) {
            alerts.push({
              type: this.alertTypes.LOW_ATTENDANCE,
              severity,
              course: enrollment.course,
              attendanceRate: parseFloat(attendanceRate.toFixed(1)),
              totalSessions,
              attended,
              message: `Your attendance in ${enrollment.course.name} is ${attendanceRate.toFixed(1)}%. Please attend more classes to improve your standing.`,
              actionRequired: true,
            });

            // Set cooldown (7 days for warnings, 3 days for critical)
            const cooldown = severity === "critical" ? 3 : 7;
            if (redisClient && redisClient.isReady) {
              await redisClient.setEx(
                alertKey,
                cooldown * 24 * 60 * 60,
                "sent",
              );
            }
          }
        }

        // Check consecutive absences
        let consecutiveAbsences = 0;
        for (const record of records) {
          if (record.status === "absent") consecutiveAbsences++;
          else break;
        }

        if (consecutiveAbsences >= 2) {
          const alertKey = `alert:consecutive_absence:${targetStudentId}:${enrollment.courseId}`;
          let lastAlertSent = null;

          if (redisClient && redisClient.isReady) {
            lastAlertSent = await redisClient.get(alertKey);
          }

          if (!lastAlertSent) {
            alerts.push({
              type: this.alertTypes.CONSECUTIVE_ABSENCE,
              severity: consecutiveAbsences >= 3 ? "critical" : "warning",
              course: enrollment.course,
              consecutiveAbsences,
              message: `You have missed ${consecutiveAbsences} consecutive sessions in ${enrollment.course.name}. Please contact your lecturer to discuss your attendance.`,
              actionRequired: true,
            });

            if (redisClient && redisClient.isReady) {
              await redisClient.setEx(alertKey, 5 * 24 * 60 * 60, "sent");
            }
          }
        }
      }

      res.json({
        success: true,
        data: {
          alerts,
          totalAlerts: alerts.length,
          hasCriticalAlerts: alerts.some((a) => a.severity === "critical"),
        },
      });
    } catch (error) {
      logger.error("Check attendance alerts error:", error);
      next(error);
    }
  }

  /**
   * Send session reminder alerts to students
   * POST /api/v1/alerts/session-reminder
   */
  async sendSessionReminders(req, res, next) {
    try {
      const { sessionId, minutesBefore = 30 } = req.body;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          status: "active",
          startedAt: { gt: new Date() },
        },
        include: {
          course: {
            include: {
              enrollments: {
                where: { isActive: true },
                include: {
                  student: {
                    include: {
                      devices: {
                        where: { isActive: true, fcmToken: { not: null } },
                      },
                      notificationPref: true,
                    },
                  },
                },
              },
            },
          },
          classroom: true,
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Active session not found" },
        });
      }

      const startTime = new Date(session.startedAt);
      const reminderTime = new Date(
        startTime.getTime() - minutesBefore * 60000,
      );

      // Only send if current time is past reminder time
      if (new Date() < reminderTime) {
        return res.json({
          success: true,
          data: {
            message: `Reminders will be sent at ${reminderTime.toLocaleTimeString()}`,
            scheduled: true,
          },
        });
      }

      let emailSent = 0;
      let pushSent = 0;
      const recipients = [];

      for (const enrollment of session.course.enrollments) {
        const student = enrollment.student;
        const preferences = student.notificationPref;

        if (preferences?.sessionReminders !== false) {
          recipients.push({
            id: student.id,
            name: student.fullName,
            email: student.email,
          });

          // Send email
          if (preferences?.emailNotifications !== false) {
            await sendEmail(
              student.email,
              `⏰ Session Reminder: ${session.course.name} - AttendX`,
              this.getSessionReminderEmail(student, session, minutesBefore),
            );
            emailSent++;
          }

          // Send push notification
          if (preferences?.pushNotifications !== false) {
            for (const device of student.devices) {
              if (device.fcmToken) {
                await sendPushNotification(device.fcmToken, {
                  title: "Session Reminder",
                  body: `${session.course.name} starts in ${minutesBefore} minutes at ${session.classroom?.name || "classroom"}. Session code: ${session.sessionCode}`,
                  data: {
                    type: "session_reminder",
                    sessionId: session.id,
                    sessionCode: session.sessionCode,
                    courseName: session.course.name,
                    startTime: session.startedAt.toISOString(),
                  },
                });
                pushSent++;
              }
            }
          }
        }
      }

      // Log alert
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SEND_SESSION_REMINDERS",
          entity: "Session",
          entityId: sessionId,
          newValues: {
            recipients: recipients.length,
            minutesBefore,
            emailSent,
            pushSent,
          },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `Session reminders sent for session ${sessionId}: ${emailSent} emails, ${pushSent} pushes`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          courseName: session.course.name,
          minutesBefore,
          recipients: recipients.length,
          emailSent,
          pushSent,
          message: `Reminders sent to ${recipients.length} students`,
        },
      });
    } catch (error) {
      logger.error("Send session reminders error:", error);
      next(error);
    }
  }

  /**
   * Send session closing warning
   * POST /api/v1/alerts/session-closing
   */
  async sendSessionClosingWarning(req, res, next) {
    try {
      const { sessionId, minutesBefore = 5 } = req.body;

      const session = await prisma.session.findFirst({
        where: {
          id: sessionId,
          status: "active",
          checkinOpen: true,
        },
        include: {
          course: {
            include: {
              enrollments: {
                where: { isActive: true },
                include: {
                  student: {
                    include: {
                      devices: {
                        where: { isActive: true, fcmToken: { not: null } },
                      },
                      notificationPref: true,
                    },
                  },
                },
              },
            },
          },
          classroom: true,
          roomCheckins: {
            where: { studentId: { not: undefined } },
          },
        },
      });

      if (!session) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Active session not found" },
        });
      }

      const checkedInStudentIds = new Set(
        session.roomCheckins.map((c) => c.studentId),
      );
      const notCheckedIn = session.course.enrollments.filter(
        (e) => !checkedInStudentIds.has(e.studentId),
      );

      let emailSent = 0;
      let pushSent = 0;

      for (const enrollment of notCheckedIn) {
        const student = enrollment.student;
        const preferences = student.notificationPref;

        if (preferences?.missedAttendance !== false) {
          // Send email
          if (preferences?.emailNotifications !== false) {
            await sendEmail(
              student.email,
              `⚠️ Session Closing Soon: ${session.course.name} - AttendX`,
              this.getSessionClosingEmail(student, session, minutesBefore),
            );
            emailSent++;
          }

          // Send push notification
          if (preferences?.pushNotifications !== false) {
            for (const device of student.devices) {
              if (device.fcmToken) {
                await sendPushNotification(device.fcmToken, {
                  title: "Session Closing Soon",
                  body: `${session.course.name} session closes in ${minutesBefore} minutes. Check in now to avoid being marked absent!`,
                  data: {
                    type: "session_closing",
                    sessionId: session.id,
                    sessionCode: session.sessionCode,
                    courseName: session.course.name,
                  },
                });
                pushSent++;
              }
            }
          }
        }
      }

      logger.info(
        `Session closing warnings sent for session ${sessionId}: ${emailSent} emails, ${pushSent} pushes`,
      );

      res.json({
        success: true,
        data: {
          sessionId,
          courseName: session.course.name,
          minutesBefore,
          notCheckedInCount: notCheckedIn.length,
          emailSent,
          pushSent,
          message: `Closing warnings sent to ${notCheckedIn.length} students`,
        },
      });
    } catch (error) {
      logger.error("Send session closing warning error:", error);
      next(error);
    }
  }

  /**
   * Get user's alert history
   * GET /api/v1/alerts/history
   */
  async getAlertHistory(req, res, next) {
    try {
      const { page = 1, limit = 20, type, severity, from, to } = req.query;

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const userId = req.user.id;

      // Get notification logs from database
      const where = {
        userId,
        ...(type && { type }),
        ...(severity && { severity }),
        ...(from && { createdAt: { gte: new Date(from) } }),
        ...(to && { createdAt: { lte: new Date(to) } }),
      };

      // For now, fetch from audit logs (in production, have a dedicated notification_logs table)
      const [alerts, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: {
            userId,
            action: {
              in: [
                "LOW_ATTENDANCE_ALERT",
                "CONSECUTIVE_ABSENCE_ALERT",
                "SESSION_REMINDER",
              ],
            },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: parseInt(limit),
        }),
        prisma.auditLog.count({
          where: {
            userId,
            action: {
              in: [
                "LOW_ATTENDANCE_ALERT",
                "CONSECUTIVE_ABSENCE_ALERT",
                "SESSION_REMINDER",
              ],
            },
          },
        }),
      ]);

      res.json({
        success: true,
        data: alerts,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) {
      logger.error("Get alert history error:", error);
      next(error);
    }
  }

  /**
   * Mark alert as read
   * PATCH /api/v1/alerts/:alertId/read
   */
  async markAlertRead(req, res, next) {
    try {
      const { alertId } = req.params;

      // In production, update notification_logs table
      // For now, just return success

      res.json({
        success: true,
        data: { message: "Alert marked as read" },
      });
    } catch (error) {
      logger.error("Mark alert read error:", error);
      next(error);
    }
  }

  /**
   * Get lecturer's at-risk students alerts
   * GET /api/v1/alerts/lecturer/at-risk
   */
  async getLecturerAtRiskAlerts(req, res, next) {
    try {
      const { courseId, threshold = 75 } = req.query;
      const lecturerId = req.user.id;

      const where = {
        lecturerId,
        isActive: true,
        ...(courseId && { id: courseId }),
      };

      const courses = await prisma.course.findMany({
        where,
        include: {
          enrollments: {
            where: { isActive: true },
            include: {
              student: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  regNumber: true,
                  phone: true,
                },
              },
            },
          },
        },
      });

      const atRiskStudents = [];

      for (const course of courses) {
        for (const enrollment of course.enrollments) {
          const records = await prisma.attendanceRecord.findMany({
            where: {
              studentId: enrollment.studentId,
              session: { courseId: course.id },
            },
            select: { status: true, markedAt: true },
            orderBy: { markedAt: "desc" },
          });

          const totalSessions = records.length;
          if (totalSessions === 0) continue;

          const attended = records.filter(
            (r) => r.status === "present" || r.status === "late",
          ).length;
          const attendanceRate = (attended / totalSessions) * 100;

          // Count consecutive absences
          let consecutiveAbsences = 0;
          for (const record of records) {
            if (record.status === "absent") consecutiveAbsences++;
            else break;
          }

          if (attendanceRate < threshold || consecutiveAbsences >= 2) {
            // Check if alert was already sent this week
            let alertSent = false;
            let lastAlertDate = null;

            if (redisClient && redisClient.isReady) {
              const lastAlert = await redisClient.get(
                `alert:lecturer:${course.id}:${enrollment.studentId}`,
              );
              if (lastAlert) {
                alertSent = true;
                lastAlertDate = new Date(parseInt(lastAlert));
              }
            }

            atRiskStudents.push({
              student: enrollment.student,
              course: {
                id: course.id,
                code: course.code,
                name: course.name,
              },
              statistics: {
                totalSessions,
                attended,
                attendanceRate: parseFloat(attendanceRate.toFixed(1)),
                consecutiveAbsences,
                missedSessions: totalSessions - attended,
              },
              alert: {
                sent: alertSent,
                lastSentAt: lastAlertDate,
                recommended: !alertSent,
              },
              riskLevel: attendanceRate < 50 ? "critical" : "warning",
            });
          }
        }
      }

      // Sort by risk level
      atRiskStudents.sort((a, b) => {
        if (a.riskLevel !== b.riskLevel) {
          return a.riskLevel === "critical" ? -1 : 1;
        }
        return a.statistics.attendanceRate - b.statistics.attendanceRate;
      });

      res.json({
        success: true,
        data: {
          totalAtRisk: atRiskStudents.length,
          criticalCount: atRiskStudents.filter(
            (s) => s.riskLevel === "critical",
          ).length,
          warningCount: atRiskStudents.filter((s) => s.riskLevel === "warning")
            .length,
          students: atRiskStudents,
        },
      });
    } catch (error) {
      logger.error("Get lecturer at-risk alerts error:", error);
      next(error);
    }
  }

  /**
   * Send alert to at-risk students (Lecturer)
   * POST /api/v1/alerts/send-at-risk-alert
   */
  async sendAtRiskAlert(req, res, next) {
    try {
      const {
        courseId,
        studentIds,
        message,
        sendEmail = true,
        sendPush = true,
      } = req.body;

      if (!courseId || !studentIds || studentIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Course ID and student IDs are required",
          },
        });
      }

      // Verify course ownership
      const course = await prisma.course.findFirst({
        where: { id: courseId, lecturerId: req.user.id, isActive: true },
        select: { id: true, code: true, name: true, lecturerId: true },
      });

      if (!course) {
        return res.status(404).json({
          success: false,
          error: {
            code: "NOT_FOUND",
            message: "Course not found or you don't have access",
          },
        });
      }

      // Get students
      const students = await prisma.user.findMany({
        where: {
          id: { in: studentIds },
          role: "student",
          isActive: true,
        },
        include: {
          devices: {
            where: { isActive: true, fcmToken: { not: null } },
          },
          notificationPref: true,
        },
      });

      const defaultMessage =
        message ||
        `⚠️ Attendance Alert: Your attendance in ${course.name} is below the required threshold. Please attend classes regularly to maintain good standing. Contact your lecturer if you have concerns.`;

      let emailSent = 0;
      let pushSent = 0;

      for (const student of students) {
        const preferences = student.notificationPref;

        // Send email
        if (sendEmail && preferences?.emailNotifications !== false) {
          await sendEmail(
            student.email,
            `⚠️ Attendance Alert: ${course.name} - AttendX`,
            this.getAtRiskAlertEmail(student, course, defaultMessage),
          );
          emailSent++;
        }

        // Send push notification
        if (sendPush && preferences?.pushNotifications !== false) {
          for (const device of student.devices) {
            if (device.fcmToken) {
              await sendPushNotification(device.fcmToken, {
                title: "Attendance Alert",
                body: `Your attendance in ${course.name} needs attention. Please check your attendance record.`,
                data: {
                  type: "attendance_alert",
                  courseId: course.id,
                  courseCode: course.code,
                },
              });
              pushSent++;
            }
          }
        }

        // Track alert sent
        if (redisClient && redisClient.isReady) {
          await redisClient.setEx(
            `alert:lecturer:${course.id}:${student.id}`,
            7 * 24 * 60 * 60,
            Date.now().toString(),
          );
        }
      }

      // Create audit log
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: "SEND_AT_RISK_ALERT",
          entity: "Course",
          entityId: courseId,
          newValues: { recipients: students.length, emailSent, pushSent },
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        },
      });

      logger.info(
        `At-risk alert sent for course ${courseId} to ${students.length} students`,
      );

      res.json({
        success: true,
        data: {
          course,
          recipients: students.length,
          emailSent,
          pushSent,
          message: `Alert sent to ${students.length} students`,
        },
      });
    } catch (error) {
      logger.error("Send at-risk alert error:", error);
      next(error);
    }
  }

  /**
   * Get system alerts (Admin only)
   * GET /api/v1/alerts/system
   */
  async getSystemAlerts(req, res, next) {
    try {
      const alerts = [];

      // Check database connection
      let dbConnected = true;
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        dbConnected = false;
        alerts.push({
          type: "system",
          severity: "critical",
          title: "Database Connection Issue",
          message: "Database connection is unstable. Please check immediately.",
          timestamp: new Date(),
        });
      }

      // Check Redis connection
      let redisConnected = false;
      if (redisClient && redisClient.isReady) {
        try {
          await redisClient.ping();
          redisConnected = true;
        } catch (error) {
          redisConnected = false;
        }
      }

      if (!redisConnected) {
        alerts.push({
          type: "system",
          severity: "warning",
          title: "Redis Connection Issue",
          message:
            "Redis cache is not responding. Performance may be affected.",
          timestamp: new Date(),
        });
      }

      // Check active sessions count
      const activeSessions = await prisma.session.count({
        where: { status: "active" },
      });

      if (activeSessions > 50) {
        alerts.push({
          type: "system",
          severity: "info",
          title: "High Session Load",
          message: `${activeSessions} active sessions are currently running. Monitor system performance.`,
          timestamp: new Date(),
        });
      }

      // Check pending bulk imports
      const pendingImports = await prisma.bulkImportJob.count({
        where: { status: "pending" },
      });

      if (pendingImports > 5) {
        alerts.push({
          type: "system",
          severity: "warning",
          title: "Pending Bulk Imports",
          message: `${pendingImports} bulk import jobs are pending. Process them to avoid backlog.`,
          timestamp: new Date(),
        });
      }

      // Check low disk space (placeholder - implement actual check)
      // This would require system monitoring integration

      res.json({
        success: true,
        data: {
          alerts,
          totalAlerts: alerts.length,
          criticalCount: alerts.filter((a) => a.severity === "critical").length,
          warningCount: alerts.filter((a) => a.severity === "warning").length,
        },
      });
    } catch (error) {
      logger.error("Get system alerts error:", error);
      next(error);
    }
  }

  /**
   * Dismiss system alert (Admin only)
   * POST /api/v1/alerts/system/:alertId/dismiss
   */
  async dismissSystemAlert(req, res, next) {
    try {
      const { alertId } = req.params;

      // In production, store dismissed alerts in Redis or database
      if (redisClient && redisClient.isReady) {
        await redisClient.setEx(
          `alert:dismissed:${alertId}`,
          24 * 60 * 60,
          "dismissed",
        );
      }

      logger.info(`System alert ${alertId} dismissed by ${req.user.email}`);

      res.json({
        success: true,
        data: { message: "Alert dismissed successfully" },
      });
    } catch (error) {
      logger.error("Dismiss system alert error:", error);
      next(error);
    }
  }

  /**
   * Get email template for session reminder
   */
  getSessionReminderEmail(student, session, minutesBefore) {
    const startTime = new Date(session.startedAt).toLocaleTimeString();
    const startDate = new Date(session.startedAt).toLocaleDateString();

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #333;">⏰ Session Reminder</h2>
          <p>Dear ${student.fullName},</p>
          <p>This is a reminder that your session starts in <strong>${minutesBefore} minutes</strong>.</p>
          <div style="background: white; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Session Details:</strong></p>
            <ul>
              <li>Course: ${session.course.name} (${session.course.code})</li>
              <li>Session Code: <strong>${session.sessionCode}</strong></li>
              <li>Date: ${startDate}</li>
              <li>Time: ${startTime}</li>
              <li>Location: ${session.classroom?.building || ""} ${session.classroom?.name || "Classroom"}</li>
            </ul>
          </div>
          <p>Please arrive on time and have your device ready for check-in.</p>
          <p>To check in, use the AttendX app or send: <strong>ATTEND ${session.sessionCode}</strong> via SMS.</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }

  /**
   * Get email template for session closing warning
   */
  getSessionClosingEmail(student, session, minutesBefore) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #FF9800; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #FF9800;">⚠️ Session Closing Soon</h2>
          <p>Dear ${student.fullName},</p>
          <p>The session for <strong>${session.course.name}</strong> will close in <strong>${minutesBefore} minutes</strong>.</p>
          <div style="background: #FFF3E0; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Action Required:</strong></p>
            <p>If you haven't checked in yet, please do so immediately to avoid being marked as <strong>absent</strong>.</p>
            <p style="text-align: center; margin-top: 15px;">
              <strong>Session Code: ${session.sessionCode}</strong>
            </p>
          </div>
          <p>To check in, open the AttendX app or reply with: <strong>ATTEND ${session.sessionCode}</strong></p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }

  /**
   * Get email template for at-risk alert
   */
  getAtRiskAlertEmail(student, course, message) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #F44336; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="color: white; margin: 0;">AttendX</h1>
        </div>
        <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
          <h2 style="color: #F44336;">⚠️ Attendance Alert</h2>
          <p>Dear ${student.fullName},</p>
          <div style="background: #FFEBEE; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Course:</strong> ${course.name} (${course.code})</p>
            <p>${message}</p>
          </div>
          <p><strong>What you can do:</strong></p>
          <ul>
            <li>Attend all remaining sessions</li>
            <li>Check your attendance record in the AttendX app</li>
            <li>Contact your lecturer if you have extenuating circumstances</li>
          </ul>
          <p>We're here to help you succeed!</p>
          <hr style="margin: 20px 0;" />
          <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
        </div>
      </div>
    `;
  }
}

module.exports = new AlertController();
