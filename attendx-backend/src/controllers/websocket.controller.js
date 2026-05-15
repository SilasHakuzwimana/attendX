// socket/websocket.controller.js
const logger = require("../utils/logger");
const { prisma, redisClient } = require("../index");
const jwt = require("jsonwebtoken");

class WebSocketController {
  constructor() {
    this.connectedUsers = new Map(); // userId -> Set of socketIds
    this.userSockets = new Map(); // socketId -> userInfo
    this.sessionRooms = new Map(); // sessionId -> Set of socketIds
    this.courseRooms = new Map(); // courseId -> Set of socketIds
    this.lecturerRooms = new Map(); // lecturerId -> Set of socketIds
  }

  /**
   * Initialize Socket.IO with authentication middleware
   */
  initialize(io) {
    this.io = io;

    // Authentication middleware
    io.use(async (socket, next) => {
      try {
        const token =
          socket.handshake.auth.token ||
          socket.handshake.headers.authorization?.split(" ")[1];

        if (!token) {
          return next(new Error("Authentication required"));
        }

        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId, isActive: true },
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            regNumber: true,
          },
        });

        if (!user) {
          return next(new Error("User not found or inactive"));
        }

        socket.user = user;
        next();
      } catch (error) {
        logger.error("WebSocket authentication error:", error);
        next(new Error("Authentication failed"));
      }
    });

    io.on("connection", (socket) => {
      this.handleConnection(socket);
    });

    logger.info("WebSocket controller initialized");
  }

  /**
   * Handle new socket connection
   */
  handleConnection(socket) {
    const { user } = socket;
    logger.info(
      `User connected: ${user.email} (${user.role}) - Socket: ${socket.id}`,
    );

    // Store connection
    this.addUserConnection(user.id, socket.id, socket);

    // Join role-based rooms
    this.joinRoleRooms(socket, user);

    // Send initial data
    this.sendInitialData(socket, user);

    // Setup event handlers
    this.setupEventHandlers(socket, user);
  }

  /**
   * Add user connection to tracking maps
   */
  addUserConnection(userId, socketId, socket) {
    // Track user's sockets
    if (!this.connectedUsers.has(userId)) {
      this.connectedUsers.set(userId, new Set());
    }
    this.connectedUsers.get(userId).add(socketId);

    // Track socket to user mapping
    this.userSockets.set(socketId, {
      userId,
      role: socket.user.role,
      socket,
    });
  }

  /**
   * Join role-based rooms
   */
  joinRoleRooms(socket, user) {
    // Join role-specific room
    socket.join(`role:${user.role}`);

    // Join user-specific room for private messages
    socket.join(`user:${user.id}`);

    // Join lecturer-specific room if applicable
    if (user.role === "lecturer") {
      socket.join(`lecturer:${user.id}`);
      if (!this.lecturerRooms.has(user.id)) {
        this.lecturerRooms.set(user.id, new Set());
      }
      this.lecturerRooms.get(user.id).add(socket.id);
    }
  }

  /**
   * Send initial data based on user role
   */
  async sendInitialData(socket, user) {
    try {
      const initialData = {
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          regNumber: user.regNumber,
        },
        timestamp: new Date(),
      };

      // Role-specific initial data
      if (user.role === "student") {
        initialData.activeSessions = await this.getStudentActiveSessions(
          user.id,
        );
        initialData.recentCheckins = await this.getStudentRecentCheckins(
          user.id,
        );
      } else if (user.role === "lecturer") {
        initialData.activeSessions = await this.getLecturerActiveSessions(
          user.id,
        );
        initialData.courses = await this.getLecturerCourses(user.id);
      } else if (user.role === "admin") {
        initialData.systemStats = await this.getSystemStats();
        initialData.activeUsers = this.connectedUsers.size;
      }

      socket.emit("initial_data", initialData);
    } catch (error) {
      logger.error("Error sending initial data:", error);
    }
  }

  /**
   * Setup event handlers for socket
   */
  setupEventHandlers(socket, user) {
    // Join session room
    socket.on("join_session", async (data) => {
      await this.handleJoinSession(socket, user, data);
    });

    // Leave session room
    socket.on("leave_session", async (data) => {
      await this.handleLeaveSession(socket, user, data);
    });

    // Join course room
    socket.on("join_course", async (data) => {
      await this.handleJoinCourse(socket, user, data);
    });

    // Request live check-ins
    socket.on("request_live_checkins", async (data) => {
      await this.handleRequestLiveCheckins(socket, user, data);
    });

    // Send message to session
    socket.on("session_message", async (data) => {
      await this.handleSessionMessage(socket, user, data);
    });

    // Request attendance summary
    socket.on("request_attendance_summary", async (data) => {
      await this.handleAttendanceSummary(socket, user, data);
    });

    // Typing indicator
    socket.on("typing", (data) => {
      this.handleTyping(socket, user, data);
    });

    // Disconnect
    socket.on("disconnect", () => {
      this.handleDisconnect(socket, user);
    });
  }

  /**
   * Handle join session room
   */
  async handleJoinSession(socket, user, { sessionId }) {
    try {
      // Verify access
      const hasAccess = await this.verifySessionAccess(
        user.id,
        user.role,
        sessionId,
      );

      if (!hasAccess) {
        socket.emit("error", { message: "Access denied to this session" });
        return;
      }

      // Join room
      socket.join(`session:${sessionId}`);

      // Track session room membership
      if (!this.sessionRooms.has(sessionId)) {
        this.sessionRooms.set(sessionId, new Set());
      }
      this.sessionRooms.get(sessionId).add(socket.id);

      // Get session data
      const sessionData = await this.getSessionData(sessionId);

      socket.emit("session_joined", {
        sessionId,
        session: sessionData,
        message: `Joined session ${sessionId}`,
      });

      // Notify others in session (for lecturers)
      if (user.role !== "student") {
        socket.to(`session:${sessionId}`).emit("user_joined", {
          userId: user.id,
          userName: user.fullName,
          role: user.role,
          timestamp: new Date(),
        });
      }

      // Send current check-ins if lecturer
      if (user.role === "lecturer") {
        const checkins = await this.getSessionCheckins(sessionId);
        socket.emit("current_checkins", { sessionId, checkins });
      }

      logger.info(`User ${user.email} joined session ${sessionId}`);
    } catch (error) {
      logger.error("Join session error:", error);
      socket.emit("error", { message: "Failed to join session" });
    }
  }

  /**
   * Handle leave session room
   */
  async handleLeaveSession(socket, user, { sessionId }) {
    try {
      socket.leave(`session:${sessionId}`);

      // Remove from tracking
      if (this.sessionRooms.has(sessionId)) {
        this.sessionRooms.get(sessionId).delete(socket.id);
        if (this.sessionRooms.get(sessionId).size === 0) {
          this.sessionRooms.delete(sessionId);
        }
      }

      socket.emit("session_left", {
        sessionId,
        message: `Left session ${sessionId}`,
      });

      logger.info(`User ${user.email} left session ${sessionId}`);
    } catch (error) {
      logger.error("Leave session error:", error);
    }
  }

  /**
   * Handle join course room
   */
  async handleJoinCourse(socket, user, { courseId }) {
    try {
      // Verify enrollment for students
      if (user.role === "student") {
        const isEnrolled = await this.checkEnrollment(user.id, courseId);
        if (!isEnrolled) {
          socket.emit("error", {
            message: "You are not enrolled in this course",
          });
          return;
        }
      } else if (user.role === "lecturer") {
        const ownsCourse = await this.checkCourseOwnership(user.id, courseId);
        if (!ownsCourse) {
          socket.emit("error", { message: "You don't teach this course" });
          return;
        }
      }

      socket.join(`course:${courseId}`);

      if (!this.courseRooms.has(courseId)) {
        this.courseRooms.set(courseId, new Set());
      }
      this.courseRooms.get(courseId).add(socket.id);

      socket.emit("course_joined", {
        courseId,
        message: `Joined course room`,
      });

      logger.info(`User ${user.email} joined course ${courseId}`);
    } catch (error) {
      logger.error("Join course error:", error);
    }
  }

  /**
   * Handle request for live check-ins
   */
  async handleRequestLiveCheckins(socket, user, { sessionId }) {
    try {
      const checkins = await this.getSessionCheckins(sessionId);
      socket.emit("live_checkins", {
        sessionId,
        checkins,
        timestamp: new Date(),
      });
    } catch (error) {
      logger.error("Live checkins error:", error);
    }
  }

  /**
   * Handle session message (chat)
   */
  async handleSessionMessage(
    socket,
    user,
    { sessionId, message, type = "text" },
  ) {
    try {
      const messageData = {
        id: `${Date.now()}-${socket.id}`,
        userId: user.id,
        userName: user.fullName,
        userRole: user.role,
        message,
        type,
        timestamp: new Date(),
      };

      // Store message in Redis (optional)
      if (redisClient && redisClient.isReady) {
        const key = `session:messages:${sessionId}`;
        await redisClient.lPush(key, JSON.stringify(messageData));
        await redisClient.lTrim(key, 0, 99); // Keep last 100 messages
      }

      // Broadcast to session room
      this.io.to(`session:${sessionId}`).emit("new_message", messageData);

      logger.debug(`Message in session ${sessionId} from ${user.email}`);
    } catch (error) {
      logger.error("Session message error:", error);
    }
  }

  /**
   * Handle typing indicator
   */
  handleTyping(socket, user, { sessionId, isTyping }) {
    socket.to(`session:${sessionId}`).emit("user_typing", {
      userId: user.id,
      userName: user.fullName,
      isTyping,
      timestamp: new Date(),
    });
  }

  /**
   * Handle attendance summary request
   */
  async handleAttendanceSummary(socket, user, { sessionId }) {
    try {
      const summary = await this.getSessionAttendanceSummary(sessionId);
      socket.emit("attendance_summary", {
        sessionId,
        summary,
        timestamp: new Date(),
      });
    } catch (error) {
      logger.error("Attendance summary error:", error);
    }
  }

  /**
   * Handle disconnect
   */
  handleDisconnect(socket, user) {
    logger.info(`User disconnected: ${user.email} - Socket: ${socket.id}`);

    // Remove from all tracking maps
    if (this.connectedUsers.has(user.id)) {
      this.connectedUsers.get(user.id).delete(socket.id);
      if (this.connectedUsers.get(user.id).size === 0) {
        this.connectedUsers.delete(user.id);
      }
    }

    this.userSockets.delete(socket.id);

    // Remove from session rooms
    for (const [sessionId, sockets] of this.sessionRooms) {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          this.sessionRooms.delete(sessionId);
        }
      }
    }

    // Remove from course rooms
    for (const [courseId, sockets] of this.courseRooms) {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          this.courseRooms.delete(courseId);
        }
      }
    }

    // Remove from lecturer rooms
    if (user.role === "lecturer" && this.lecturerRooms.has(user.id)) {
      this.lecturerRooms.get(user.id).delete(socket.id);
      if (this.lecturerRooms.get(user.id).size === 0) {
        this.lecturerRooms.delete(user.id);
      }
    }

    // Broadcast user left to relevant rooms
    this.io.emit("user_disconnected", {
      userId: user.id,
      userName: user.fullName,
      timestamp: new Date(),
    });
  }

  // ==================== Public Event Emitters ====================

  /**
   * Emit check-in event to session room
   */
  emitCheckin(sessionId, checkinData) {
    this.io.to(`session:${sessionId}`).emit("new_checkin", {
      ...checkinData,
      timestamp: new Date(),
    });

    // Also emit to course room
    this.emitToCourse(checkinData.courseId, "student_checked_in", {
      sessionId,
      student: checkinData.student,
      timestamp: new Date(),
    });
  }

  /**
   * Emit session started event
   */
  emitSessionStarted(sessionId, courseId, sessionData) {
    this.io.to(`course:${courseId}`).emit("session_started", {
      sessionId,
      ...sessionData,
      timestamp: new Date(),
    });

    // Notify lecturers
    this.io.to(`role:lecturer`).emit("new_session_created", {
      sessionId,
      courseId,
      ...sessionData,
    });
  }

  /**
   * Emit session closed event
   */
  emitSessionClosed(sessionId, courseId, summary) {
    this.io.to(`session:${sessionId}`).emit("session_closed", {
      sessionId,
      summary,
      timestamp: new Date(),
    });

    this.io.to(`course:${courseId}`).emit("session_ended", {
      sessionId,
      summary,
    });
  }

  /**
   * Emit session extended event
   */
  emitSessionExtended(sessionId, newExpiresAt, additionalMinutes) {
    this.io.to(`session:${sessionId}`).emit("session_extended", {
      sessionId,
      newExpiresAt,
      additionalMinutes,
      timestamp: new Date(),
    });
  }

  /**
   * Emit attendance overridden event
   */
  emitAttendanceOverridden(
    sessionId,
    studentId,
    oldStatus,
    newStatus,
    overriddenBy,
  ) {
    this.io.to(`session:${sessionId}`).emit("attendance_overridden", {
      sessionId,
      studentId,
      oldStatus,
      newStatus,
      overriddenBy,
      timestamp: new Date(),
    });

    // Notify student privately
    this.io.to(`user:${studentId}`).emit("attendance_updated", {
      sessionId,
      status: newStatus,
      message: `Your attendance has been updated to ${newStatus}`,
    });
  }

  /**
   * Emit announcement to course
   */
  emitCourseAnnouncement(courseId, announcement) {
    this.io.to(`course:${courseId}`).emit("announcement", {
      ...announcement,
      timestamp: new Date(),
    });
  }

  /**
   * Emit to specific user
   */
  emitToUser(userId, event, data) {
    this.io.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Emit to course room
   */
  emitToCourse(courseId, event, data) {
    this.io.to(`course:${courseId}`).emit(event, data);
  }

  /**
   * Emit to session room
   */
  emitToSession(sessionId, event, data) {
    this.io.to(`session:${sessionId}`).emit(event, data);
  }

  /**
   * Emit to role
   */
  emitToRole(role, event, data) {
    this.io.to(`role:${role}`).emit(event, data);
  }

  /**
   * Get connected users count
   */
  getConnectedUsersCount() {
    return this.connectedUsers.size;
  }

  /**
   * Get users in session
   */
  getSessionUsers(sessionId) {
    const sockets = this.sessionRooms.get(sessionId);
    if (!sockets) return [];

    const users = [];
    for (const socketId of sockets) {
      const userInfo = this.userSockets.get(socketId);
      if (userInfo) {
        users.push({
          userId: userInfo.userId,
          role: userInfo.role,
        });
      }
    }
    return users;
  }

  // ==================== Helper Methods ====================

  /**
   * Verify session access
   */
  async verifySessionAccess(userId, role, sessionId) {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { courseId: true, lecturerId: true },
      });

      if (!session) return false;

      if (role === "admin") return true;
      if (role === "lecturer") return session.lecturerId === userId;

      if (role === "student") {
        const enrollment = await prisma.enrollment.findFirst({
          where: {
            studentId: userId,
            courseId: session.courseId,
            isActive: true,
          },
        });
        return !!enrollment;
      }

      return false;
    } catch (error) {
      logger.error("Verify session access error:", error);
      return false;
    }
  }

  /**
   * Check enrollment
   */
  async checkEnrollment(studentId, courseId) {
    const enrollment = await prisma.enrollment.findFirst({
      where: { studentId, courseId, isActive: true },
    });
    return !!enrollment;
  }

  /**
   * Check course ownership
   */
  async checkCourseOwnership(lecturerId, courseId) {
    const course = await prisma.course.findFirst({
      where: { id: courseId, lecturerId },
    });
    return !!course;
  }

  /**
   * Get session data
   */
  async getSessionData(sessionId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        course: { select: { id: true, code: true, name: true } },
        classroom: { select: { id: true, name: true, building: true } },
        _count: { select: { roomCheckins: true } },
      },
    });
    return session;
  }

  /**
   * Get session check-ins
   */
  async getSessionCheckins(sessionId) {
    const checkins = await prisma.roomCheckin.findMany({
      where: { sessionId },
      include: {
        student: {
          select: {
            id: true,
            fullName: true,
            regNumber: true,
          },
        },
      },
      orderBy: { checkedInAt: "desc" },
    });
    return checkins;
  }

  /**
   * Get session attendance summary
   */
  async getSessionAttendanceSummary(sessionId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        course: {
          include: {
            enrollments: {
              where: { isActive: true },
              select: { studentId: true },
            },
          },
        },
        roomCheckins: true,
      },
    });

    const totalEnrolled = session.course.enrollments.length;
    const checkedIn = session.roomCheckins.length;
    const attendanceRate =
      totalEnrolled > 0 ? (checkedIn / totalEnrolled) * 100 : 0;

    return {
      totalEnrolled,
      checkedIn,
      notCheckedIn: totalEnrolled - checkedIn,
      attendanceRate: parseFloat(attendanceRate.toFixed(1)),
    };
  }

  /**
   * Get student active sessions
   */
  async getStudentActiveSessions(studentId) {
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId, isActive: true },
      select: { courseId: true },
    });

    const courseIds = enrollments.map((e) => e.courseId);

    if (courseIds.length === 0) return [];

    const sessions = await prisma.session.findMany({
      where: {
        courseId: { in: courseIds },
        status: "active",
        checkinOpen: true,
        expiresAt: { gt: new Date() },
      },
      include: {
        course: { select: { code: true, name: true } },
        classroom: { select: { name: true } },
      },
      take: 5,
    });

    return sessions;
  }

  /**
   * Get student recent check-ins
   */
  async getStudentRecentCheckins(studentId) {
    const checkins = await prisma.roomCheckin.findMany({
      where: { studentId },
      include: {
        session: {
          include: {
            course: { select: { name: true, code: true } },
          },
        },
      },
      orderBy: { checkedInAt: "desc" },
      take: 5,
    });
    return checkins;
  }

  /**
   * Get lecturer active sessions
   */
  async getLecturerActiveSessions(lecturerId) {
    const sessions = await prisma.session.findMany({
      where: {
        lecturerId,
        status: "active",
        checkinOpen: true,
      },
      include: {
        course: { select: { code: true, name: true } },
        classroom: { select: { name: true } },
        _count: { select: { roomCheckins: true } },
      },
      orderBy: { expiresAt: "asc" },
    });
    return sessions;
  }

  /**
   * Get lecturer courses
   */
  async getLecturerCourses(lecturerId) {
    const courses = await prisma.course.findMany({
      where: { lecturerId, isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        _count: {
          select: {
            enrollments: {
              where: { isActive: true },
            },
          },
        },
      },
    });
    return courses;
  }

  /**
   * Get system stats
   */
  async getSystemStats() {
    const [totalUsers, activeSessions, totalCheckinsToday] = await Promise.all([
      prisma.user.count(),
      prisma.session.count({ where: { status: "active" } }),
      prisma.roomCheckin.count({
        where: {
          checkedInAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    return {
      totalUsers,
      activeSessions,
      totalCheckinsToday,
      connectedUsers: this.connectedUsers.size,
    };
  }
}

module.exports = new WebSocketController();
