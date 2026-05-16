const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const prisma = new PrismaClient();

module.exports = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000"),
  appName: process.env.APP_NAME || "AttendX API",
  apiVersion: process.env.API_VERSION || "v1",

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD,
    ttl: {
      session: parseInt(process.env.REDIS_TTL_SESSION || "3600"),
      refreshToken: parseInt(process.env.REDIS_TTL_REFRESH_TOKEN || "604800"),
    },
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: parseInt(process.env.JWT_ACCESS_EXPIRES_IN || "3600"),
    refreshExpiresIn: parseInt(process.env.JWT_REFRESH_EXPIRES_IN || "604800"),
  },

  email: {
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || "587"),
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
    from: process.env.EMAIL_FROM || "AttendX <hakusilasgmail.com>",
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    enabled: process.env.SMS_ENABLED === "true",
  },

  frontend: {
    url: process.env.FRONTEND_URL || "http://localhost:3000",
  },

  cors: {
    origins: process.env.CORS_ORIGINS?.split(",") || [
      "http://localhost:3000",
      "http://localhost:5000",
    ],
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"),
  },

  geofence: {
    defaultRadiusM: parseInt(process.env.DEFAULT_GEOFENCE_RADIUS_M || "30"),
  },

  session: {
    codeLength: parseInt(process.env.SESSION_CODE_LENGTH || "6"),
    defaultDurationMinutes: parseInt(
      process.env.SESSION_DEFAULT_DURATION_MINUTES || "90",
    ),
  },

  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || "10"),
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || "8"),
  },
  prisma,
};
