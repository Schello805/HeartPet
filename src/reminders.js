const dayjs = require("dayjs");
const nodemailer = require("nodemailer");

async function processDueReminders(db, settings) {
  const now = dayjs().format("YYYY-MM-DDTHH:mm");
  const dueReminders = db.prepare(`
    SELECT reminders.*, animals.name AS animal_name
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND reminders.due_at <= ?
      AND reminders.last_notified_at IS NULL
    ORDER BY reminders.due_at ASC
  `).all(now);

  for (const reminder of dueReminders) {
    const emailEnabled =
      settings.reminder_email_enabled === "true" &&
      settings.smtp_host &&
      settings.smtp_user &&
      settings.smtp_from;

    const telegramEnabled =
      settings.reminder_telegram_enabled === "true" &&
      settings.telegram_bot_token &&
      settings.telegram_chat_id;

    if (reminder.channel_email && emailEnabled) {
      await sendEmailReminder(settings, reminder);
    }

    if (reminder.channel_telegram && telegramEnabled) {
      await sendTelegramReminder(settings, reminder);
    }

    db.prepare("UPDATE reminders SET last_notified_at = CURRENT_TIMESTAMP WHERE id = ?").run(reminder.id);
  }
}

async function sendEmailReminder(settings, reminder) {
  const transporter = nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port || 587),
    secure: settings.smtp_secure === "true",
    auth: settings.smtp_user
      ? {
          user: settings.smtp_user,
          pass: settings.smtp_password || "",
        }
      : undefined,
  });

  const animalPart = reminder.animal_name ? ` für ${reminder.animal_name}` : "";

  await transporter.sendMail({
    from: settings.smtp_from,
    to: settings.smtp_user,
    subject: `[HeartPet] Erinnerung${animalPart}: ${reminder.title}`,
    text: [
      `HeartPet Erinnerung${animalPart}`,
      ``,
      `Titel: ${reminder.title}`,
      `Fälligkeit: ${reminder.due_at}`,
      `Typ: ${reminder.reminder_type}`,
      reminder.notes ? `Notiz: ${reminder.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

async function sendTelegramReminder(settings, reminder) {
  const animalPart = reminder.animal_name ? ` für *${escapeTelegram(reminder.animal_name)}*` : "";
  const text = [
    `HeartPet Erinnerung${animalPart}`,
    ``,
    `*Titel:* ${escapeTelegram(reminder.title)}`,
    `*Fällig:* ${escapeTelegram(reminder.due_at)}`,
    `*Typ:* ${escapeTelegram(reminder.reminder_type)}`,
    reminder.notes ? `*Notiz:* ${escapeTelegram(reminder.notes)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: settings.telegram_chat_id,
      text,
      parse_mode: "MarkdownV2",
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram-Benachrichtigung fehlgeschlagen: ${response.status}`);
  }
}

function escapeTelegram(value) {
  return String(value).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

module.exports = {
  processDueReminders,
};
