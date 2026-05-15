const jwt = require("jsonwebtoken");
const config = require("../config");
const { prisma } = require("../config/index");

const authenticateToken = async (req, res, next) => {
  let token = null;
  // 1. Check cookie first (most secure)
  if (req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }
  // 2. Fallback to Authorization header (for mobile apps)
  else if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Access token required" },
    });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    const user = await global.prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        regNumber: true,
        staffNumber: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "User not found or inactive" },
      });
    }

    req.user = user;
    req.deviceFingerprint = decoded.deviceFingerprint;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: {
          code: "TOKEN_EXPIRED",
          message: "Access token has expired",
        },
      });
    }
    next(error);
  }
};

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Not authenticated" },
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: `Role '${req.user.role}' not allowed. Required: ${allowedRoles.join(", ")}`,
        },
      });
    }
    next();
  };
};

module.exports = { authenticateToken, requireRole };
