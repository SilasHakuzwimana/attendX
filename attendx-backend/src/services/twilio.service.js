const twilio = require("twilio");
const logger = require("../utils/logger");
const config = require("../config");

class TwilioService {
  constructor() {
    if (!config.twilio.enabled) {
      logger.warn("Twilio SMS is disabled");
      return;
    }

    this.client = twilio(config.twilio.accountSid, config.twilio.authToken);
    this.phoneNumber = config.twilio.phoneNumber;
  }

  /**
   * Send an SMS message
   * @param {string} to - Recipient phone number (E.164 format)
   * @param {string} body - Message content
   * @returns {Promise<object>} Message resource
   */
  async sendSMS(to, body) {
    try {
      if (!config.twilio.enabled) {
        logger.info(`SMS would be sent to ${to}: ${body}`);
        return { sid: "mock-send", status: "mock" };
      }

      const message = await this.client.messages.create({
        to: to,
        from: this.phoneNumber,
        body: body,
      });

      logger.info(`SMS sent to ${to}: ${message.sid}`);
      return message;
    } catch (error) {
      logger.error(`Failed to send SMS to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send attendance confirmation via SMS
   * @param {string} phoneNumber - Student's phone number
   * @param {string} studentName - Student's full name
   * @param {string} courseName - Course name
   * @returns {Promise<object>}
   */
  async sendAttendanceConfirmation(phoneNumber, studentName, courseName) {
    const message = `✅ Attendance confirmed, ${studentName}! You've been marked present for ${courseName}. Thank you! - AttendX`;
    return this.sendSMS(phoneNumber, message);
  }

  /**
   * Send session started notification (for basic phones)
   * @param {string} phoneNumber - Student's phone number
   * @param {string} courseName - Course name
   * @param {string} sessionCode - Session code for check-in
   * @returns {Promise<object>}
   */
  async sendSessionStartedNotification(phoneNumber, courseName, sessionCode) {
    const message = `📚 ${courseName} attendance session started! Send: ATTEND ${sessionCode} to this number to check in. - AttendX`;
    return this.sendSMS(phoneNumber, message);
  }

  /**
   * Send absence notification
   * @param {string} phoneNumber - Student's phone number
   * @param {string} studentName - Student's name
   * @param {string} courseName - Course name
   * @returns {Promise<object>}
   */
  async sendAbsenceNotification(phoneNumber, studentName, courseName) {
    const message = `⚠️ Attendance Alert, ${studentName}! You were marked absent for ${courseName}. Contact your lecturer if this is an error. - AttendX`;
    return this.sendSMS(phoneNumber, message);
  }

  /**
   * Send warning for consecutive absences
   * @param {string} phoneNumber - Student's phone number
   * @param {string} studentName - Student's name
   * @param {string} courseName - Course name
   * @param {number} consecutiveCount - Number of consecutive absences
   * @returns {Promise<object>}
   */
  async sendAbsenceWarning(
    phoneNumber,
    studentName,
    courseName,
    consecutiveCount,
  ) {
    const message = `⚠️ ATTENDANCE WARNING, ${studentName}! You have ${consecutiveCount} consecutive absences in ${courseName}. Please contact your lecturer immediately. - AttendX`;
    return this.sendSMS(phoneNumber, message);
  }

  /**
   * Validate phone number format (E.164)
   * @param {string} phoneNumber - Phone number to validate
   * @returns {boolean} Is valid
   */
  static validatePhoneNumber(phoneNumber) {
    // E.164 format: + followed by 1-15 digits
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    return e164Regex.test(phoneNumber);
  }

  /**
   * Format phone number to E.164
   * @param {string} phoneNumber - Raw phone number
   * @returns {string} Formatted phone number
   */
  static formatToE164(phoneNumber, countryCode = "250") {
    // Remove all non-digit characters
    let cleaned = phoneNumber.replace(/\D/g, "");

    // Remove leading zero if present
    if (cleaned.startsWith("0")) {
      cleaned = cleaned.substring(1);
    }

    // Add country code if not present
    if (!cleaned.startsWith(countryCode)) {
      cleaned = countryCode + cleaned;
    }

    return `+${cleaned}`;
  }
}

module.exports = TwilioService;
