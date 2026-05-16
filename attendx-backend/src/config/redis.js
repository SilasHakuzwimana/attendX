const Redis = require("ioredis");
const config = require("../config/index");
const logger = require("../utils/logger");

let redisClient = null;
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000;

/**
 * Initialize Redis connection
 * @returns {Promise<Redis>} Redis client instance
 */
const initRedis = async () => {
  if (redisClient && redisClient.status === "ready") {
    logger.info("Redis already connected");
    return redisClient;
  }

  if (isConnecting) {
    logger.info("Redis connection already in progress, waiting...");
    // Wait for existing connection attempt
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return redisClient;
  }

  isConnecting = true;

  try {
    const redisPass = process.env.REDIS_PASSWORD || config.redis?.password;
    const redisHost =
      process.env.REDIS_HOST || config.redis?.host || "localhost";
    const redisPort = process.env.REDIS_PORT || config.redis?.port || 6379;

    // Fix: Proper Redis URL format
    let redisUrl;
    if (redisPass) {
      redisUrl = `redis://:${redisPass}@${redisHost}:${redisPort}`;
    } else {
      redisUrl = `redis://${redisHost}:${redisPort}`;
    }

    const finalRedisUrl = process.env.REDIS_URL || redisUrl;

    logger.info(
      `Connecting to Redis at ${redisHost}:${redisPort}${redisPass ? " with password" : ""}`,
    );

    redisClient = new Redis(finalRedisUrl, {
      // Connection settings
      retryStrategy: (times) => {
        if (times > MAX_RECONNECT_ATTEMPTS) {
          logger.error(
            `Redis max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached`,
          );
          return null; // Stop retrying
        }

        const delay = Math.min(
          INITIAL_RECONNECT_DELAY * Math.pow(1.5, times - 1),
          30000,
        );
        logger.warn(
          `Redis reconnecting... Attempt ${times}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
        );
        return delay;
      },

      // Timeout settings
      connectTimeout: 10000,
      commandTimeout: 5000,
      keepAlive: 30000,

      // Performance settings
      enableReadyCheck: true,
      lazyConnect: false,
      enableOfflineQueue: true,

      // TLS/SSL (if enabled)
      ...(config.redis?.tls && { tls: {} }),

      // Retry settings
      maxRetriesPerRequest: 3,

      // Connection name for monitoring
      connectionName: "attendx-backend",

      // Password authentication
      ...(config.redis?.password && { password: config.redis.password }),

      // Database selection
      ...(config.redis?.db && { db: config.redis.db }),
    });

    // Event handlers
    redisClient.on("connect", () => {
      reconnectAttempts = 0;
      logger.info("🔌 Redis connecting...");
    });

    redisClient.on("ready", () => {
      isConnecting = false;
      reconnectAttempts = 0;
      logger.info("✅ Redis connected successfully");

      // Log Redis server info
      redisClient.info((err, info) => {
        if (!err && info) {
          const version = info.match(/redis_version:(\d+\.\d+\.\d+)/)?.[1];
          const usedMemory = info.match(/used_memory_human:([^\r\n]+)/)?.[1];
          if (version) logger.info(`📀 Redis version: ${version}`);
          if (usedMemory) logger.info(`💾 Redis memory usage: ${usedMemory}`);
        }
      });
    });

    redisClient.on("error", (error) => {
      isConnecting = false;
      logger.error("❌ Redis error:", error.message);

      // Handle specific error types
      if (error.code === "ECONNREFUSED") {
        logger.error(
          "Redis connection refused. Make sure Redis server is running.",
        );
      } else if (error.code === "NOAUTH") {
        logger.error(
          "Redis authentication failed. Check password configuration.",
        );
      } else if (error.code === "LOADING") {
        logger.warn("Redis is loading dataset. Waiting...");
      }
    });

    redisClient.on("reconnecting", () => {
      reconnectAttempts++;
      logger.warn(`Redis reconnecting... Attempt ${reconnectAttempts}`);
    });

    redisClient.on("close", () => {
      logger.warn("Redis connection closed");
    });

    redisClient.on("end", () => {
      logger.warn("Redis connection ended");
      isConnecting = false;
    });

    // Test connection with retry
    await testConnectionWithRetry(redisClient, 3);

    return redisClient;
  } catch (error) {
    isConnecting = false;
    logger.error("Failed to initialize Redis:", error);
    throw error;
  }
};

/**
 * Test Redis connection with retry logic
 * @param {Redis} client - Redis client
 * @param {number} retries - Number of retries
 * @returns {Promise<void>}
 */
const testConnectionWithRetry = async (client, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      await client.ping();
      logger.info("✅ Redis ping successful");
      return;
    } catch (error) {
      if (i === retries - 1) throw error;
      logger.warn(`Redis ping failed, retrying... (${i + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

/**
 * Get Redis client instance
 * @returns {Redis} Redis client
 * @throws {Error} If Redis not initialized
 */
const getRedis = () => {
  if (!redisClient) {
    throw new Error("Redis not initialized. Call initRedis first.");
  }

  if (redisClient.status !== "ready") {
    logger.warn(`Redis status: ${redisClient.status}`);
  }

  return redisClient;
};

/**
 * Check if Redis is ready
 * @returns {boolean} True if Redis is ready
 */
const isRedisReady = () => {
  return redisClient && redisClient.status === "ready";
};

/**
 * Get Redis health status
 * @returns {Promise<Object>} Health status
 */
const getRedisHealth = async () => {
  if (!redisClient) {
    return { status: "not_initialized", error: "Redis client not initialized" };
  }

  try {
    const startTime = Date.now();
    await redisClient.ping();
    const latency = Date.now() - startTime;

    const info = await redisClient.info();
    const memory = await redisClient.info("memory");

    return {
      status: redisClient.status === "ready" ? "healthy" : "degraded",
      latency: `${latency}ms`,
      info: {
        version: info.match(/redis_version:([^\r\n]+)/)?.[1] || "unknown",
        connectedClients:
          info.match(/connected_clients:([^\r\n]+)/)?.[1] || "0",
        usedMemory:
          memory.match(/used_memory_human:([^\r\n]+)/)?.[1] || "unknown",
        totalCommands:
          info.match(/total_commands_processed:([^\r\n]+)/)?.[1] || "0",
        uptime: info.match(/uptime_in_seconds:([^\r\n]+)/)?.[1] || "0",
      },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
};

/**
 * Get Redis metrics
 * @returns {Promise<Object>} Redis metrics
 */
const getRedisMetrics = async () => {
  if (!redisClient || redisClient.status !== "ready") {
    return { error: "Redis not ready" };
  }

  try {
    const info = await redisClient.info();
    const memory = await redisClient.info("memory");
    const stats = await redisClient.info("stats");
    const keyspace = await redisClient.info("keyspace");

    return {
      server: {
        version: info.match(/redis_version:([^\r\n]+)/)?.[1] || "unknown",
        mode: info.match(/redis_mode:([^\r\n]+)/)?.[1] || "unknown",
        os: info.match(/os:([^\r\n]+)/)?.[1] || "unknown",
        uptime: parseInt(info.match(/uptime_in_seconds:([^\r\n]+)/)?.[1] || 0),
      },
      memory: {
        used: memory.match(/used_memory_human:([^\r\n]+)/)?.[1] || "unknown",
        usedRss:
          memory.match(/used_memory_rss_human:([^\r\n]+)/)?.[1] || "unknown",
        peak:
          memory.match(/used_memory_peak_human:([^\r\n]+)/)?.[1] || "unknown",
        fragmentation:
          memory.match(/mem_fragmentation_ratio:([^\r\n]+)/)?.[1] || "unknown",
      },
      performance: {
        totalCommands: parseInt(
          stats.match(/total_commands_processed:([^\r\n]+)/)?.[1] || 0,
        ),
        opsPerSecond: parseInt(
          stats.match(/instantaneous_ops_per_sec:([^\r\n]+)/)?.[1] || 0,
        ),
        hitRate:
          stats.match(/keyspace_hits:(\d+)/) &&
          stats.match(/keyspace_misses:(\d+)/)
            ? (
                (parseInt(stats.match(/keyspace_hits:(\d+)/)[1]) /
                  (parseInt(stats.match(/keyspace_hits:(\d+)/)[1]) +
                    parseInt(stats.match(/keyspace_misses:(\d+)/)[1]))) *
                100
              ).toFixed(2) + "%"
            : "0%",
      },
      keyspace:
        keyspace.match(/db\d+:keys=\d+/g)?.map((db) => {
          const match = db.match(/db(\d+):keys=(\d+)/);
          return { db: match[1], keys: parseInt(match[2]) };
        }) || [],
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error("Failed to get Redis metrics:", error);
    throw error;
  }
};

/**
 * Flush all Redis data (use with caution!)
 * @returns {Promise<void>}
 */
const flushRedis = async () => {
  if (!redisClient || redisClient.status !== "ready") {
    throw new Error("Redis not ready");
  }

  try {
    await redisClient.flushall();
    logger.warn("Redis database flushed");
  } catch (error) {
    logger.error("Failed to flush Redis:", error);
    throw error;
  }
};

/**
 * Close Redis connection
 * @returns {Promise<void>}
 */
const closeRedis = async () => {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info("Redis connection closed");
      redisClient = null;
      isConnecting = false;
      reconnectAttempts = 0;
    } catch (error) {
      logger.error("Error closing Redis connection:", error);
      // Force disconnect if quit fails
      if (redisClient) {
        redisClient.disconnect();
        redisClient = null;
      }
    }
  }
};

/**
 * Get Redis key with TTL
 * @param {string} key - Redis key
 * @returns {Promise<{value: string, ttl: number}>}
 */
const getWithTTL = async (key) => {
  const client = getRedis();
  const [value, ttl] = await Promise.all([client.get(key), client.ttl(key)]);
  return { value, ttl };
};

/**
 * Set Redis key with expiration if not exists
 * @param {string} key - Redis key
 * @param {string} value - Value to set
 * @param {number} ttl - Time to live in seconds
 * @returns {Promise<boolean>} True if set, false if already exists
 */
const setNX = async (key, value, ttl) => {
  const client = getRedis();
  const result = await client.setnx(key, value);
  if (result && ttl) {
    await client.expire(key, ttl);
  }
  return result === 1;
};

/**
 * Get multiple keys by pattern
 * @param {string} pattern - Key pattern
 * @returns {Promise<string[]>} Array of keys
 */
const getKeysByPattern = async (pattern) => {
  const client = getRedis();
  const keys = [];
  let cursor = "0";

  do {
    const [nextCursor, foundKeys] = await client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== "0");

  return keys;
};

/**
 * Delete multiple keys by pattern
 * @param {string} pattern - Key pattern
 * @returns {Promise<number>} Number of deleted keys
 */
const deleteKeysByPattern = async (pattern) => {
  const client = getRedis();
  const keys = await getKeysByPattern(pattern);
  if (keys.length > 0) {
    return await client.del(keys);
  }
  return 0;
};

module.exports = {
  initRedis,
  getRedis,
  isRedisReady,
  getRedisHealth,
  getRedisMetrics,
  flushRedis,
  closeRedis,
  getWithTTL,
  setNX,
  getKeysByPattern,
  deleteKeysByPattern,
};
