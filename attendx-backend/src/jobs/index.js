const logger = require("../utils/logger");

// Try to load node-cron, but don't fail if not installed
let cron;
try {
  cron = require("node-cron");
} catch (error) {
  logger.warn("node-cron not installed. Background jobs disabled.");
  cron = null;
}

// Session expiry worker (every minute)
const startSessionExpiryWorker = () => {
  if (!cron) {
    logger.info("Cron jobs disabled - node-cron not installed");
    return;
  }

  cron.schedule("* * * * *", async () => {
    try {
      logger.info("Running session expiry check...");

      const expiredSessions = await global.prisma.session.findMany({
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

        await global.prisma.session.update({
          where: { id: session.id },
          data: {
            checkinOpen: false,
            status: "expired",
            closedAt: new Date(),
          },
        });

        const checkedInStudentIds = session.roomCheckins.map(
          (c) => c.studentId,
        );
        const attendanceRecords = [];

        for (const enrollment of session.course.enrollments) {
          const isPresent = checkedInStudentIds.includes(enrollment.studentId);
          attendanceRecords.push({
            sessionId: session.id,
            studentId: enrollment.studentId,
            status: isPresent ? "present" : "absent",
            submissionMethod: isPresent ? "app" : null,
            geofencePassed: isPresent ? true : null,
          });
        }

        await global.prisma.attendanceRecord.createMany({
          data: attendanceRecords,
        });

        if (global.io) {
          global.io.to(`session:${session.id}`).emit("sessionClosed", {
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

        await global.redis.del(`session:${session.id}`);
      }
    } catch (error) {
      logger.error("Session expiry worker error:", error);
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
      logger.info("Running absence warning check...");

      const systemConfig = await global.prisma.systemConfig.findUnique({
        where: { id: "singleton" },
      });
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
      logger.error("Absence warning worker error:", error);
    }
  });

  logger.info("Absence warning worker started (runs daily at 7 AM)");
};

const startBackgroundJobs = () => {
  logger.info("Starting background jobs...");
  startSessionExpiryWorker();
  startAbsenceWarningWorker();
  logger.info("Background jobs started");
};

module.exports = { startBackgroundJobs };
