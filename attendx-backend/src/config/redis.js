const Redis = require('ioredis');
const config = require('./index');

let redisClient = null;

const initRedis = async () => {
  try {
    redisClient = new Redis(config.redis.url);
    
    redisClient.on('connect', () => {
      console.log('✅ Redis connected successfully');
    });
    
    redisClient.on('error', (error) => {
      console.error('❌ Redis connection error:', error);
    });
    
    // Test connection
    await redisClient.ping();
    return redisClient;
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    throw error;
  }
};

const getRedis = () => {
  if (!redisClient) {
    throw new Error('Redis not initialized. Call initRedis first.');
  }
  return redisClient;
};

module.exports = { initRedis, getRedis };
