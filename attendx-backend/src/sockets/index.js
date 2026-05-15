const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");
const config = require("../config");
const { prisma, redisClient } = require("../config/index");

let io = null;
let connectedUsers = new Map(); // userId -> Set of socketIds
let userSockets = new Map(); // socketId -> userInfo
let sessionRooms = new Map(); // sessionId -> Set of socketIds
let courseRooms = new Map(); // courseId -> Set of socketIds

/**
 * Initialize Socket.IO server
 * @param {http.Server} server - HTTP server instance
 * @returns {Server} Socket.IO instance
 */
const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: config.cors?.origins || "*",
      credentials: true,
      methods: ["GET", "POST"],
      allowedHeaders: ["Authorization", "Content-Type"],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ["websocket", "polling"],
    allowEIO3: true,
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.split(" ")[1];

      if (!token) {
        logger.warn("WebSocket connection attempt without token");
        return next(new Error("Authentication required"));
      }

      // Verify JWT
      const decoded = jwt.verify(
        token,
        config.jwt.accessSecret || config.jwt.secret,
      );

      // Get user from database
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId, isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          regNumber: true,
          staffNumber: true,
        },
      });

      if (!user) {
        logger.warn(
          `WebSocket authentication failed: User ${decoded.userId} not found or inactive`,
        );
        return next(new Error("User not found or inactive"));
      }

      // Attach user info to socket
      socket.user = user;
      socket.userId = user.id;
      socket.userRole = user.role;

      next();
    } catch (error) {
      logger.error("WebSocket authentication error:", error);
      next(new Error("Authentication failed"));
    }
  });

  // Connection handler
  io.on("connection", (socket) => {
    handleConnection(socket);
  });

  logger.info("Socket.IO server initialized");
  return io;
};

/**
 * Handle new socket connection
 */
const handleConnection = (socket) => {
  const { user } = socket;
  logger.info(
    `User connected: ${user.email} (${user.role}) - Socket: ${socket.id}`,
  );

  // Add to connected users
  addUserConnection(user.id, socket.id, socket);

  // Join role-based rooms
  joinRoleRooms(socket, user);

  // Send initial connection success
  socket.emit("connected", {
    message: "Connected to AttendX WebSocket server",
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    },
    timestamp: new Date(),
  });

  // Send initial data based on role
  sendInitialData(socket, user);

  // Setup event handlers
  setupEventHandlers(socket, user);

  // Broadcast user online status
  broadcastUserStatus(user.id, user.fullName, "online");
};

/**
 * Add user connection to tracking maps
 */
const addUserConnection = (userId, socketId, socket) => {
  // Track user's sockets
  if (!connectedUsers.has(userId)) {
    connectedUsers.set(userId, new Set());
  }
  connectedUsers.get(userId).add(socketId);

  // Track socket to user mapping
  userSockets.set(socketId, {
    userId,
    role: socket.user.role,
    userName: socket.user.fullName,
    socket,
  });
};

/**
 * Join role-based rooms
 */
const joinRoleRooms = (socket, user) => {
  // Join role-specific room
  socket.join(`role:${user.role}`);

  // Join user-specific room for private messages
  socket.join(`user:${user.id}`);

  // Join lecturer-specific room if applicable
  if (user.role === "lecturer") {
    socket.join(`lecturer:${user.id}`);
  }
};

/**
 * Send initial data based on user role
 */
const sendInitialData = async (socket, user) => {
  try {
    const initialData = {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        regNumber: user.regNumber,
        staffNumber: user.staffNumber,
      },
      timestamp: new Date(),
      connectedUsers: connectedUsers.size,
    };

    // Role-specific initial data
    if (user.role === "student") {
      initialData.activeSessions = await getStudentActiveSessions(user.id);
      initialData.recentCheckins = await getStudentRecentCheckins(user.id);
      initialData.upcomingSessions = await getStudentUpcomingSessions(user.id);
    } else if (user.role === "lecturer") {
      initialData.activeSessions = await getLecturerActiveSessions(user.id);
      initialData.courses = await getLecturerCourses(user.id);
      initialData.todaySessions = await getLecturerTodaySessions(user.id);
    } else if (user.role === "admin") {
      initialData.systemStats = await getSystemStats();
      initialData.activeUsers = connectedUsers.size;
      initialData.recentAlerts = await getRecentAlerts();
    }

    socket.emit("initial_data", initialData);
  } catch (error) {
    logger.error("Error sending initial data:", error);
  }
};

/**
 * Setup event handlers for socket
 */
const setupEventHandlers = (socket, user) => {
  // Session management
  socket.on("join-session", (data) => handleJoinSession(socket, user, data));
  socket.on("leave-session", (data) => handleLeaveSession(socket, user, data));
  socket.on("session-action", (data) =>
    handleSessionAction(socket, user, data),
  );

  // Course management
  socket.on("join-course", (data) => handleJoinCourse(socket, user, data));
  socket.on("leave-course", (data) => handleLeaveCourse(socket, user, data));

  // Check-in events
  socket.on("request-checkins", (data) =>
    handleRequestCheckins(socket, user, data),
  );
  socket.on("checkin-update", (data) =>
    handleCheckinUpdate(socket, user, data),
  );

  // Chat events
  socket.on("session-message", (data) =>
    handleSessionMessage(socket, user, data),
  );
  socket.on("typing", (data) => handleTyping(socket, user, data));

  // Attendance events
  socket.on("request-summary", (data) =>
    handleRequestSummary(socket, user, data),
  );

  // Notification events
  socket.on("mark-notification-read", (data) =>
    handleMarkNotificationRead(socket, user, data),
  );

  // Ping/Pong for connection health
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: new Date() });
  });

  // Disconnect
  socket.on("disconnect", () => handleDisconnect(socket, user));
};

// ==================== Event Handlers ====================

/**
 * Handle join session room
 */
const handleJoinSession = async (socket, user, { sessionId }) => {
  try {
    // Verify access
    const hasAccess = await verifySessionAccess(user.id, user.role, sessionId);

    if (!hasAccess) {
      socket.emit("error", { message: "Access denied to this session" });
      return;
    }

    // Join room
    socket.join(`session:${sessionId}`);

    // Track session room membership
    if (!sessionRooms.has(sessionId)) {
      sessionRooms.set(sessionId, new Set());
    }
    sessionRooms.get(sessionId).add(socket.id);

    // Get session data
    const sessionData = await getSessionData(sessionId);

    socket.emit("session-joined", {
      sessionId,
      session: sessionData,
      message: `Joined session ${sessionId}`,
    });

    // Notify others in session (for lecturers)
    if (user.role !== "student") {
      socket.to(`session:${sessionId}`).emit("user-joined", {
        userId: user.id,
        userName: user.fullName,
        role: user.role,
        timestamp: new Date(),
      });
    }

    // Send current check-ins if lecturer
    if (user.role === "lecturer") {
      const checkins = await getSessionCheckins(sessionId);
      socket.emit("current-checkins", { sessionId, checkins });
    }

    logger.info(`User ${user.email} joined session ${sessionId}`);
  } catch (error) {
    logger.error("Join session error:", error);
    socket.emit("error", { message: "Failed to join session" });
  }
};

/**
 * Handle leave session room
 */
const handleLeaveSession = (socket, user, { sessionId }) => {
  try {
    socket.leave(`session:${sessionId}`);

    // Remove from tracking
    if (sessionRooms.has(sessionId)) {
      sessionRooms.get(sessionId).delete(socket.id);
      if (sessionRooms.get(sessionId).size === 0) {
        sessionRooms.delete(sessionId);
      }
    }

    socket.emit("session-left", {
      sessionId,
      message: `Left session ${sessionId}`,
    });

    logger.info(`User ${user.email} left session ${sessionId}`);
  } catch (error) {
    logger.error("Leave session error:", error);
  }
};

/**
 * Handle session action (start/close/extend)
 */
const handleSessionAction = async (
  socket,
  user,
  { sessionId, action, data },
) => {
  try {
    // Verify ownership for lecturers
    if (user.role === "lecturer") {
      const session = await prisma.session.findFirst({
        where: { id: sessionId, lecturerId: user.id },
      });
      if (!session) {
        socket.emit("error", { message: "You do not own this session" });
        return;
      }
    }

    switch (action) {
      case "start":
        io.to(`session:${sessionId}`).emit("session-started", {
          sessionId,
          ...data,
          startedBy: user.fullName,
          timestamp: new Date(),
        });
        break;
      case "close":
        io.to(`session:${sessionId}`).emit("session-closed", {
          sessionId,
          ...data,
          closedBy: user.fullName,
          timestamp: new Date(),
        });
        break;
      case "extend":
        io.to(`session:${sessionId}`).emit("session-extended", {
          sessionId,
          ...data,
          extendedBy: user.fullName,
          timestamp: new Date(),
        });
        break;
      default:
        socket.emit("error", { message: "Invalid session action" });
    }
  } catch (error) {
    logger.error("Session action error:", error);
    socket.emit("error", { message: "Failed to process session action" });
  }
};

/**
 * Handle join course room
 */
const handleJoinCourse = async (socket, user, { courseId }) => {
  try {
    // Verify enrollment for students
    if (user.role === "student") {
      const isEnrolled = await checkEnrollment(user.id, courseId);
      if (!isEnrolled) {
        socket.emit("error", {
          message: "You are not enrolled in this course",
        });
        return;
      }
    } else if (user.role === "lecturer") {
      const ownsCourse = await checkCourseOwnership(user.id, courseId);
      if (!ownsCourse) {
        socket.emit("error", { message: "You do not teach this course" });
        return;
      }
    }

    socket.join(`course:${courseId}`);

    if (!courseRooms.has(courseId)) {
      courseRooms.set(courseId, new Set());
    }
    courseRooms.get(courseId).add(socket.id);

    socket.emit("course-joined", {
      courseId,
      message: `Joined course ${courseId}`,
    });

    logger.info(`User ${user.email} joined course ${courseId}`);
  } catch (error) {
    logger.error("Join course error:", error);
  }
};

/**
 * Handle leave course room
 */
const handleLeaveCourse = (socket, user, { courseId }) => {
  try {
    socket.leave(`course:${courseId}`);

    if (courseRooms.has(courseId)) {
      courseRooms.get(courseId).delete(socket.id);
      if (courseRooms.get(courseId).size === 0) {
        courseRooms.delete(courseId);
      }
    }

    socket.emit("course-left", {
      courseId,
      message: `Left course ${courseId}`,
    });
  } catch (error) {
    logger.error("Leave course error:", error);
  }
};

/**
 * Handle request check-ins
 */
const handleRequestCheckins = async (socket, user, { sessionId }) => {
  try {
    const checkins = await getSessionCheckins(sessionId);
    socket.emit("checkins-data", {
      sessionId,
      checkins,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error("Request checkins error:", error);
  }
};

/**
 * Handle check-in update
 */
const handleCheckinUpdate = async (
  socket,
  user,
  { sessionId, studentId, status, distanceM },
) => {
  try {
    const checkinData = {
      sessionId,
      studentId,
      studentName: user.fullName,
      status,
      distanceM,
      timestamp: new Date(),
    };

    // Broadcast to session room
    io.to(`session:${sessionId}`).emit("checkin-updated", checkinData);

    // Also emit to course room
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { courseId: true },
    });
    if (session) {
      io.to(`course:${session.courseId}`).emit(
        "student-checked-in",
        checkinData,
      );
    }
  } catch (error) {
    logger.error("Check-in update error:", error);
  }
};

/**
 * Handle session message (chat)
 */
const handleSessionMessage = async (
  socket,
  user,
  { sessionId, message, type = "text" },
) => {
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
    io.to(`session:${sessionId}`).emit("new-message", messageData);
  } catch (error) {
    logger.error("Session message error:", error);
  }
};

/**
 * Handle typing indicator
 */
const handleTyping = (socket, user, { sessionId, isTyping }) => {
  socket.to(`session:${sessionId}`).emit("user-typing", {
    userId: user.id,
    userName: user.fullName,
    isTyping,
    timestamp: new Date(),
  });
};

/**
 * Handle request summary
 */
const handleRequestSummary = async (socket, user, { sessionId }) => {
  try {
    const summary = await getSessionAttendanceSummary(sessionId);
    socket.emit("attendance-summary", {
      sessionId,
      summary,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error("Request summary error:", error);
  }
};

/**
 * Handle mark notification read
 */
const handleMarkNotificationRead = async (socket, user, { notificationId }) => {
  try {
    // Update notification in database
    // This would depend on your notification model
    socket.emit("notification-marked", { notificationId, read: true });
  } catch (error) {
    logger.error("Mark notification read error:", error);
  }
};

/**
 * Handle disconnect
 */
const handleDisconnect = (socket, user) => {
  logger.info(`User disconnected: ${user.email} - Socket: ${socket.id}`);

  // Remove from tracking maps
  if (connectedUsers.has(user.id)) {
    connectedUsers.get(user.id).delete(socket.id);
    if (connectedUsers.get(user.id).size === 0) {
      connectedUsers.delete(user.id);
    }
  }

  userSockets.delete(socket.id);

  // Remove from session rooms
  for (const [sessionId, sockets] of sessionRooms) {
    if (sockets.has(socket.id)) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        sessionRooms.delete(sessionId);
      }
    }
  }

  // Remove from course rooms
  for (const [courseId, sockets] of courseRooms) {
    if (sockets.has(socket.id)) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        courseRooms.delete(courseId);
      }
    }
  }

  // Broadcast user offline status
  broadcastUserStatus(user.id, user.fullName, "offline");
};

// ==================== Helper Functions ====================

/**
 * Broadcast user status to relevant rooms
 */
const broadcastUserStatus = (userId, userName, status) => {
  io.emit("user-status-changed", {
    userId,
    userName,
    status,
    timestamp: new Date(),
  });
};

/**
 * Verify session access
 */
const verifySessionAccess = async (userId, role, sessionId) => {
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
};

/**
 * Check enrollment
 */
const checkEnrollment = async (studentId, courseId) => {
  const enrollment = await prisma.enrollment.findFirst({
    where: { studentId, courseId, isActive: true },
  });
  return !!enrollment;
};

/**
 * Check course ownership
 */
const checkCourseOwnership = async (lecturerId, courseId) => {
  const course = await prisma.course.findFirst({
    where: { id: courseId, lecturerId },
  });
  return !!course;
};

/**
 * Get session data
 */
const getSessionData = async (sessionId) => {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      course: { select: { id: true, code: true, name: true } },
      classroom: { select: { id: true, name: true, building: true } },
      _count: { select: { roomCheckins: true } },
    },
  });
  return session;
};

/**
 * Get session check-ins
 */
const getSessionCheckins = async (sessionId) => {
  const checkins = await prisma.roomCheckin.findMany({
    where: { sessionId },
    include: {
      student: {
        select: { id: true, fullName: true, regNumber: true },
      },
    },
    orderBy: { checkedInAt: "desc" },
  });
  return checkins;
};

/**
 * Get session attendance summary
 */
const getSessionAttendanceSummary = async (sessionId) => {
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
};

/**
 * Get student active sessions
 */
const getStudentActiveSessions = async (studentId) => {
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
};

/**
 * Get student recent check-ins
 */
const getStudentRecentCheckins = async (studentId) => {
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
};

/**
 * Get student upcoming sessions
 */
const getStudentUpcomingSessions = async (studentId) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId, isActive: true },
    select: { courseId: true },
  });

  const courseIds = enrollments.map((e) => e.courseId);
  if (courseIds.length === 0) return [];

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 7);

  const sessions = await prisma.session.findMany({
    where: {
      courseId: { in: courseIds },
      startedAt: { gt: new Date(), lt: endDate },
      status: { in: ["active", "scheduled"] },
    },
    include: {
      course: { select: { code: true, name: true } },
      classroom: { select: { name: true, building: true } },
    },
    orderBy: { startedAt: "asc" },
    take: 10,
  });

  return sessions;
};

/**
 * Get lecturer active sessions
 */
const getLecturerActiveSessions = async (lecturerId) => {
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
};

/**
 * Get lecturer courses
 */
const getLecturerCourses = async (lecturerId) => {
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
};

/**
 * Get lecturer today sessions
 */
const getLecturerTodaySessions = async (lecturerId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const sessions = await prisma.session.findMany({
    where: {
      lecturerId,
      startedAt: { gte: today, lt: tomorrow },
    },
    include: {
      course: { select: { code: true, name: true } },
      classroom: { select: { name: true, building: true } },
      _count: { select: { roomCheckins: true } },
    },
    orderBy: { startedAt: "asc" },
  });
  return sessions;
};

/**
 * Get system stats
 */
const getSystemStats = async () => {
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
    connectedUsers: connectedUsers.size,
  };
};

/**
 * Get recent alerts
 */
const getRecentAlerts = async () => {
  const recentAlerts = await prisma.auditLog.findMany({
    where: {
      action: { in: ["LOGIN_FAILED", "SUSPICIOUS_ACTIVITY", "RATE_LIMIT_HIT"] },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    take: 10,
    orderBy: { createdAt: "desc" },
  });
  return recentAlerts;
};

// ==================== Public Emitter Functions ====================

/**
 * Emit session started event
 */
const emitSessionStarted = (sessionId, courseId, sessionData) => {
  if (!io) return;
  io.to(`course:${courseId}`).emit("session-started", {
    sessionId,
    ...sessionData,
    timestamp: new Date(),
  });
  io.to(`role:lecturer`).emit("new-session-created", {
    sessionId,
    courseId,
    ...sessionData,
  });
};

/**
 * Emit session closed event
 */
const emitSessionClosed = (sessionId, courseId, summary) => {
  if (!io) return;
  io.to(`session:${sessionId}`).emit("session-closed", {
    sessionId,
    summary,
    timestamp: new Date(),
  });
  io.to(`course:${courseId}`).emit("session-ended", {
    sessionId,
    summary,
  });
};

/**
 * Emit check-in event
 */
const emitCheckin = (sessionId, courseId, checkinData) => {
  if (!io) return;
  io.to(`session:${sessionId}`).emit("new-checkin", {
    ...checkinData,
    timestamp: new Date(),
  });
  io.to(`course:${courseId}`).emit("student-checked-in", {
    sessionId,
    student: checkinData.student,
    timestamp: new Date(),
  });
};

/**
 * Emit announcement to course
 */
const emitCourseAnnouncement = (courseId, announcement) => {
  if (!io) return;
  io.to(`course:${courseId}`).emit("announcement", {
    ...announcement,
    timestamp: new Date(),
  });
};

/**
 * Emit to specific user
 */
const emitToUser = (userId, event, data) => {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
};

/**
 * Emit to role
 */
const emitToRole = (role, event, data) => {
  if (!io) return;
  io.to(`role:${role}`).emit(event, data);
};

/**
 * Get Socket.IO instance
 */
const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized");
  }
  return io;
};

/**
 * Get connected users count
 */
const getConnectedUsersCount = () => {
  return connectedUsers.size;
};

/**
 * Cleanup on server shutdown
 */
const cleanup = () => {
  if (io) {
    io.close(() => {
      logger.info("Socket.IO server closed");
    });
  }
};

module.exports = {
  initSocket,
  getIO,
  getConnectedUsersCount,
  emitSessionStarted,
  emitSessionClosed,
  emitCheckin,
  emitCourseAnnouncement,
  emitToUser,
  emitToRole,
  cleanup,
};
