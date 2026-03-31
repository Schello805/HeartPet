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
    const deliveryState = {
      status: "skipped",
      error: "",
      notified: false,
    };

    try {
      const emailEnabled = isEmailEnabled(settings);
      const telegramEnabled = isTelegramEnabled(settings);

      if (reminder.channel_email && emailEnabled) {
        await sendEmailReminder(settings, reminder);
        deliveryState.notified = true;
      }

      if (reminder.channel_telegram && telegramEnabled) {
        await sendTelegramReminder(settings, reminder);
        deliveryState.notified = true;
      }

      deliveryState.status = deliveryState.notified ? "sent" : "skipped";
    } catch (error) {
      deliveryState.status = "error";
      deliveryState.error = error.message;
    }

    db.prepare(`
      UPDATE reminders
      SET last_notified_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_notified_at END,
          last_delivery_status = ?,
          last_delivery_error = ?
      WHERE id = ?
    `).run(
      deliveryState.notified ? 1 : 0,
      deliveryState.status,
      deliveryState.error || "",
      reminder.id
    );
  }
}

async function sendEmailReminder(settings, reminder) {
  const recipient = settings.notification_email_to || settings.smtp_user;
  if (!recipient) {
    throw new Error("Keine Empfängeradresse für Erinnerungen konfiguriert.");
  }

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
    to: recipient,
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

async function sendTestEmail(settings) {
  await sendEmailReminder(settings, {
    animal_name: "Testtier",
    title: "SMTP-Test",
    due_at: dayjs().format("YYYY-MM-DDTHH:mm"),
    reminder_type: "Test",
    notes: "Diese Testnachricht wurde direkt aus dem HeartPet-Adminbereich versendet.",
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

async function sendTestTelegram(settings) {
  await sendTelegramReminder(settings, {
    animal_name: "Testtier",
    title: "Telegram-Test",
    due_at: dayjs().format("YYYY-MM-DDTHH:mm"),
    reminder_type: "Test",
    notes: "Diese Testnachricht wurde direkt aus dem HeartPet-Adminbereich versendet.",
  });
}

function isEmailEnabled(settings) {
  return Boolean(
    settings.reminder_email_enabled === "true" &&
      settings.smtp_host &&
      settings.smtp_from &&
      (settings.notification_email_to || settings.smtp_user)
  );
}

function isTelegramEnabled(settings) {
  return Boolean(
    settings.reminder_telegram_enabled === "true" &&
      settings.telegram_bot_token &&
      settings.telegram_chat_id
  );
}

function escapeTelegram(value) {
  return String(value).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

module.exports = {
  processDueReminders,
  sendEmailReminder,
  sendTelegramReminder,
  sendTestEmail,
  sendTestTelegram,
  isEmailEnabled,
  isTelegramEnabled,
};
