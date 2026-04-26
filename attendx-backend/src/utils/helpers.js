const crypto = require('crypto');

/**
 * Generate random session code
 * @returns {string} 6-character alphanumeric code
 */
const generateSessionCode = async (prisma) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
  let code;
  let attempts = 0;
  const maxAttempts = 5;

  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    attempts++;
    const existing = await prisma.session.findUnique({
      where: { sessionCode: code }
    });
    if (!existing) break;
  } while (attempts < maxAttempts);

  return code;
};

/**
 * Generate random UUID
 * @returns {string} UUID v4
 */
const generateUUID = () => {
  return crypto.randomUUID();
};

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 */
const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Format date to ISO string with timezone
 * @param {Date} date - Date object
 * @returns {string} ISO string
 */
const formatDate = (date) => {
  return date.toISOString();
};

/**
 * Calculate pagination
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {number} total - Total items
 * @returns {object} Pagination metadata
 */
const getPagination = (page, limit, total) => {
  const currentPage = parseInt(page) || 1;
  const itemsPerPage = parseInt(limit) || 20;
  const totalPages = Math.ceil(total / itemsPerPage);
  
  return {
    page: currentPage,
    limit: itemsPerPage,
    total,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1
  };
};

module.exports = {
  generateSessionCode,
  generateUUID,
  sleep,
  formatDate,
  getPagination
};
