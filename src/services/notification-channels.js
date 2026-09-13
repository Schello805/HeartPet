function createNotificationChannels({
  isEmailEnabled,
  isTelegramEnabled,
  isNtfyEnabled,
  sendEmailReminder,
  sendTelegramReminder,
  sendNtfyReminder,
  sendDailyDigestEmail,
  sendDailyDigestTelegram,
  sendDailyDigestNtfy,
}) {
  return {
    email: {
      enabled: isEmailEnabled,
      sendReminder: sendEmailReminder,
      sendDigest: sendDailyDigestEmail,
      selected: (reminder) => Boolean(reminder.channel_email),
      recipient: (settings) => settings.notification_email_to || settings.smtp_user || "",
    },
    telegram: {
      enabled: isTelegramEnabled,
      sendReminder: sendTelegramReminder,
      sendDigest: sendDailyDigestTelegram,
      selected: (reminder) => Boolean(reminder.channel_telegram),
      recipient: (settings) => settings.telegram_chat_id || "",
    },
    ntfy: {
      enabled: isNtfyEnabled,
      sendReminder: sendNtfyReminder,
      sendDigest: sendDailyDigestNtfy,
      selected: () => true,
      recipient: (settings) => settings.ntfy_topic || "",
    },
  };
}

module.exports = { createNotificationChannels };
