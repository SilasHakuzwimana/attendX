const logger = require("../utils/logger");

// Try to load node-cron, but don't fail if not installed
let cron;
try {
  cron = require("node-cron");
} catch (error) {
  logger.warn("node-cron not installed. Background jobs disabled.");
  cron = null;
}

// Helper function to check if database is ready
const isDatabaseReady = async () => {
  try {
    await global.prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    return false;
  }
};

// Session expiry worker (every minute)
const startSessionExpiryWorker = () => {
  if (!cron) {
    logger.info("Cron jobs disabled - node-cron not installed");
    return;
  }

  cron.schedule("* * * * *", async () => {
    try {
      // Skip if database is not ready
      if (!(await isDatabaseReady())) {
        logger.debug("Database not ready yet, skipping session expiry check");
        return;
      }

      logger.info("Running session expiry check...");

      const expiredSessions = await global.prisma.Session.findMany({
        where: {
          status: "active",
          expiresAt: { lt: new Date() },
        },
        include: {
          course: {
            include: { enrollments: { include: { student: true } } },
          },
          roomCheckins: true,
        },
      });

      for (const session of expiredSessions) {
        logger.info(`Closing expired session: ${session.id}`);

        await global.prisma.Session.update({
          where: { id: Session.id },
          data: {
            checkinOpen: false,
            status: "expired",
            closedAt: new Date(),
          },
        });

        const checkedInStudentIds = Session.roomCheckins.map(
          (c) => c.studentId,
        );
        const attendanceRecords = [];

        for (const enrollment of Session.course.enrollments) {
          const isPresent = checkedInStudentIds.includes(enrollment.studentId);
          attendanceRecords.push({
            sessionId: Session.id,
            studentId: enrollment.studentId,
            status: isPresent ? "present" : "absent",
            submissionMethod: isPresent ? "app" : null,
            geofencePassed: isPresent ? true : null,
          });
        }

        if (attendanceRecords.length > 0) {
          await global.prisma.attendanceRecord.createMany({
            data: attendanceRecords,
          });
        }

        if (global.io) {
          global.io.to(`session:${Session.id}`).emit("sessionClosed", {
            sessionId: session.id,
            summary: {
              totalEnrolled: session.course.enrollments.length,
              presentCount: attendanceRecords.filter(
                (r) => r.status === "present",
              ).length,
              absentCount: attendanceRecords.filter(
                (r) => r.status === "absent",
              ).length,
            },
          });
        }

        if (global.redis) {
          await global.redis.del(`session:${session.id}`);
        }
      }
    } catch (error) {
      // Don't log table doesn't exist as error
      if (error.code === "P2021") {
        logger.info(
          "Database tables not yet initialized. Session expiry worker waiting...",
        );
      } else {
        logger.error("Session expiry worker error:", error);
      }
    }
  });

  logger.info("Session expiry worker started (runs every minute)");
};

// Absence warning worker (daily at 7 AM)
const startAbsenceWarningWorker = () => {
  if (!cron) {
    logger.info("Cron jobs disabled - node-cron not installed");
    return;
  }

  cron.schedule("0 7 * * *", async () => {
    try {
      // Skip if database is not ready
      if (!(await isDatabaseReady())) {
        logger.debug("Database not ready yet, skipping absence warning check");
        return;
      }

      logger.info("Running absence warning check...");

      // Get system config or use default
      let systemConfig = null;
      try {
        systemConfig = await global.prisma.systemConfig.findUnique({
          where: { id: "singleton" },
        });
      } catch (error) {
        // Table might not exist yet
        logger.info("System config table not ready yet");
      }

      const threshold = systemConfig?.consecutiveAbsenceWarningThreshold || 2;

      const courses = await global.prisma.course.findMany({
        where: { isActive: true },
        include: {
          enrollments: {
            include: {
              student: {
                include: { notificationPref: true },
              },
            },
          },
        },
      });

      for (const course of courses) {
        for (const enrollment of course.enrollments) {
          const recentAttendances =
            await global.prisma.attendanceRecord.findMany({
              where: {
                studentId: enrollment.studentId,
                session: { courseId: course.id },
              },
              orderBy: { markedAt: "desc" },
              take: threshold,
            });

          const consecutiveAbsences =
            recentAttendances.length === threshold &&
            recentAttendances.every((a) => a.status === "absent");

          if (
            consecutiveAbsences &&
            enrollment.student.notificationPref?.absenceWarning !== false
          ) {
            logger.info(
              `Student ${enrollment.student.email} has ${threshold} consecutive absences in ${course.name}`,
            );

            // Here you would send email warning
            // const { sendAbsenceWarning } = require('../services/email.service');
            // await sendAbsenceWarning(...);
          }
        }
      }
    } catch (error) {
      if (error.code === "P2021") {
        logger.info(
          "Database tables not yet initialized. Absence warning worker waiting...",
        );
      } else {
        logger.error("Absence warning worker error:", error);
      }
    }
  });

  logger.info("Absence warning worker started (runs daily at 7 AM)");
};

// Weekly report worker (every Monday at 8 AM)
const startWeeklyReportWorker = () => {
  if (!cron) {
    logger.info("Cron jobs disabled - node-cron not installed");
    return;
  }

  cron.schedule("0 8 * * 1", async () => {
    try {
      if (!(await isDatabaseReady())) {
        return;
      }

      logger.info("Running weekly report generation...");

      // Get last week's date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);

      // Generate weekly attendance report
      const totalCheckins = await global.prisma.roomCheckin.count({
        where: {
          checkedInAt: { gte: startDate, lte: endDate },
        },
      });

      const activeStudents = await global.prisma.user.count({
        where: {
          role: "student",
          lastLoginAt: { gte: startDate },
        },
      });

      logger.info(
        `Weekly report: ${totalCheckins} check-ins, ${activeStudents} active students`,
      );
    } catch (error) {
      if (error.code !== "P2021") {
        logger.error("Weekly report worker error:", error);
      }
    }
  });

  logger.info("Weekly report worker started (runs every Monday at 8 AM)");
};

const startBackgroundJobs = () => {
  logger.info("Starting background jobs...");

  // Delay job start to allow database to initialize
  setTimeout(() => {
    startSessionExpiryWorker();
    startAbsenceWarningWorker();
    startWeeklyReportWorker();
    logger.info("Background jobs started");
  }, 5000); // 5 second delay
};

module.exports = { startBackgroundJobs };
