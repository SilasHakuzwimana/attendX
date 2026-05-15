// src/index.js
const { PrismaClient } = require("@prisma/client");
const { getRedis } = require("./config/redis");

// Initialize Prisma Client
const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"],
  errorFormat: "pretty",
});

// Redis client will be set after initialization
let redisClient = null;

// Function to set Redis client after initialization
const setRedisClient = (client) => {
  redisClient = client;
};

// Function to get Redis client
const getRedisClient = () => {
  return redisClient;
};

// Export all required dependencies
module.exports = {
  prisma,
  redisClient,
  setRedisClient,
  getRedisClient,
  // Alias for backward compatibility
  get redis() {
    return redisClient;
  },
  get io() {
    return global.io;
  },
};
