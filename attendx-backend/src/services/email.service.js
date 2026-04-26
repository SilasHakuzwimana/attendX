const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger');

let transporter = null;

const initTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: false,
      auth: {
        user: config.email.user,
        pass: config.email.pass
      }
    });
  }
  return transporter;
};

const sendEmail = async (to, subject, html) => {
  try {
    const transporter = initTransporter();
    const info = await transporter.sendMail({
      from: config.email.from,
      to,
      subject,
      html
    });
    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (error) {
    logger.error(`Failed to send email to ${to}:`, error);
    throw error;
  }
};

const sendAttendanceConfirmation = async (email, name, courseName, date) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #4F46E5;">Attendance Confirmation</h2>
      <p>Dear ${name},</p>
      <p>Your attendance has been confirmed for <strong>${courseName}</strong> on ${date}.</p>
      <p>Thank you for your presence!</p>
      <hr style="margin: 20px 0;" />
      <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
    </div>
  `;
  return sendEmail(email, 'Attendance Confirmation - AttendX', html);
};

const sendAbsenceNotice = async (email, name, courseName, date) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #EF4444;">Attendance Notice</h2>
      <p>Dear ${name},</p>
      <p>You were marked <strong>absent</strong> for <strong>${courseName}</strong> on ${date}.</p>
      <p>If this is an error, please contact your lecturer.</p>
      <hr style="margin: 20px 0;" />
      <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
    </div>
  `;
  return sendEmail(email, 'Attendance Notice - AttendX', html);
};

const sendAbsenceWarning = async (email, name, courseName, consecutiveCount) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #F59E0B;">Attendance Warning</h2>
      <p>Dear ${name},</p>
      <p>You have been absent for <strong>${consecutiveCount} consecutive sessions</strong> in <strong>${courseName}</strong>.</p>
      <p>Please contact your lecturer to discuss your attendance.</p>
      <hr style="margin: 20px 0;" />
      <p style="color: #666; font-size: 12px;">AttendX - Smart Attendance System</p>
    </div>
  `;
  return sendEmail(email, 'Attendance Warning - AttendX', html);
};

module.exports = {
  sendEmail,
  sendAttendanceConfirmation,
  sendAbsenceNotice,
  sendAbsenceWarning
};
