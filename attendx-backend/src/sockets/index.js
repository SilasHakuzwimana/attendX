const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config');

let io = null;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: config.cors.origins,
      credentials: true
    }
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User ${socket.userId} connected`);

    // Join session room
    socket.on('join-session', (sessionId) => {
      socket.join(`session:${sessionId}`);
      console.log(`User ${socket.userId} joined session ${sessionId}`);
    });

    // Leave session room
    socket.on('leave-session', (sessionId) => {
      socket.leave(`session:${sessionId}`);
      console.log(`User ${socket.userId} left session ${sessionId}`);
    });

    // Join course room
    socket.on('join-course', (courseId) => {
      socket.join(`course:${courseId}`);
      console.log(`User ${socket.userId} joined course ${courseId}`);
    });

    socket.on('disconnect', () => {
      console.log(`User ${socket.userId} disconnected`);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

module.exports = { initSocket, getIO };
