const admin = require("firebase-admin");
const logger = require("../utils/logger");

// Initialize Firebase Admin (if credentials available)
let initialized = false;

const initFirebase = () => {
  if (!initialized && process.env.FCM_SERVICE_ACCOUNT_PATH) {
    try {
      const serviceAccount = require(process.env.FCM_SERVICE_ACCOUNT_PATH);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      initialized = true;
      logger.info("Firebase Admin initialized");
    } catch (error) {
      logger.warn("Firebase not configured:", error.message);
    }
  }
};

/**
 * Send push notification via FCM
 * @param {string} fcmToken - FCM device token
 * @param {object} payload - Notification payload
 */
const sendPushNotification = async (fcmToken, payload) => {
  try {
    if (!fcmToken) {
      logger.warn("No FCM token provided");
      return null;
    }

    initFirebase();

    if (!initialized) {
      logger.warn("Firebase not configured, skipping push notification");
      return null;
    }

    const message = {
      token: fcmToken,
      notification: {
        title: payload.title || "AttendX Notification",
        body: payload.body || "",
      },
      data: payload.data || {},
      android: {
        priority: "high",
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    logger.info(`Push notification sent: ${response}`);
    return response;
  } catch (error) {
    logger.error("Failed to send push notification:", error);

    // If token is invalid, mark device as inactive
    if (error.code === "messaging/registration-token-not-registered") {
      logger.warn("Invalid FCM token, should mark device as inactive");
    }

    return null;
  }
};

/**
 * Send push notification to multiple devices
 * @param {string[]} fcmTokens - Array of FCM tokens
 * @param {object} payload - Notification payload
 */
const sendMulticastNotification = async (fcmTokens, payload) => {
  try {
    if (!fcmTokens || fcmTokens.length === 0) {
      return null;
    }

    initFirebase();

    if (!initialized) {
      logger.warn("Firebase not configured, skipping push notification");
      return null;
    }

    const message = {
      tokens: fcmTokens.filter((t) => t),
      notification: {
        title: payload.title || "AttendX Notification",
        body: payload.body || "",
      },
      data: payload.data || {},
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    logger.info(
      `Multicast notification sent: ${response.successCount} successful, ${response.failureCount} failed`,
    );
    return response;
  } catch (error) {
    logger.error("Failed to send multicast notification:", error);
    return null;
  }
};

module.exports = {
  sendPushNotification,
  sendMulticastNotification,
  initFirebase,
};
