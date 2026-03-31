const dayjs = require("dayjs");
const nodemailer = require("nodemailer");
const fs = require("node:fs");
const path = require("node:path");

async function processDueReminders(db, settings, hooks = {}) {
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
        if (typeof hooks.onNotification === "function") {
          hooks.onNotification({
            channel: "email",
            type: "reminder",
            recipient: settings.notification_email_to || settings.smtp_user || "",
            subject: `Erinnerung: ${reminder.title}`,
            status: "sent",
            error: "",
            reminder,
          });
        }
        deliveryState.notified = true;
      }

      if (reminder.channel_telegram && telegramEnabled) {
        await sendTelegramReminder(settings, reminder);
        if (typeof hooks.onNotification === "function") {
          hooks.onNotification({
            channel: "telegram",
            type: "reminder",
            recipient: settings.telegram_chat_id || "",
            subject: `Erinnerung: ${reminder.title}`,
            status: "sent",
            error: "",
            reminder,
          });
        }
        deliveryState.notified = true;
      }

      deliveryState.status = deliveryState.notified ? "sent" : "skipped";
    } catch (error) {
      deliveryState.status = "error";
      deliveryState.error = error.message;
      if (typeof hooks.onNotification === "function") {
        hooks.onNotification({
          channel: reminder.channel_email ? "email" : reminder.channel_telegram ? "telegram" : "none",
          type: "reminder",
          recipient: settings.notification_email_to || settings.smtp_user || settings.telegram_chat_id || "",
          subject: `Erinnerung: ${reminder.title}`,
          status: "error",
          error: error.message,
          reminder,
        });
      }
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

  const transporter = createSmtpTransport(settings);

  const animalPart = reminder.animal_name ? ` für ${reminder.animal_name}` : "";
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const logoFilePath = path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
  const logoCid = "heartpet-logo";
  const { attachments, logoUrl } = resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl });
  const animalUrl = appBaseUrl && reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : "";
  const dashboardUrl = appBaseUrl ? `${appBaseUrl}/` : "";
  const dueLabel = formatReminderDate(reminder.due_at);
  const html = buildReminderEmailHtml({
    appName,
    logoUrl,
    animalName: reminder.animal_name || "",
    title: reminder.title,
    type: reminder.reminder_type || "Allgemein",
    dueLabel,
    notes: reminder.notes || "",
    animalUrl,
    dashboardUrl,
  });
  const text = [
    `${appName} Erinnerung${animalPart}`,
    "",
    `Titel: ${reminder.title}`,
    `Fälligkeit: ${dueLabel}`,
    `Typ: ${reminder.reminder_type}`,
    reminder.notes ? `Notiz: ${reminder.notes}` : "",
    animalUrl ? `Direkt zur Tierakte: ${animalUrl}` : "",
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : "",
    "",
    "Hinweis: Diese Benachrichtigung wurde automatisch aus HeartPet versendet.",
  ]
    .filter(Boolean)
    .join("\n");

  await transporter.sendMail({
    from: settings.smtp_from,
    to: recipient,
    subject: `[${appName}] Erinnerung${animalPart}: ${reminder.title}`,
    text,
    html,
    attachments,
  });
}

async function sendUserInviteEmail(settings, payload) {
  const recipient = String(payload?.email || "").trim();
  if (!recipient) {
    throw new Error("Keine E-Mail-Adresse für die Einladung angegeben.");
  }
  if (!settings.smtp_host || !settings.smtp_from) {
    throw new Error("SMTP ist nicht vollständig konfiguriert.");
  }

  const transporter = createSmtpTransport(settings);
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const loginUrl = appBaseUrl ? `${appBaseUrl}/login` : "";
  const logoFilePath = path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
  const logoCid = "heartpet-invite-logo";
  const { attachments, logoUrl } = resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl });
  const html = buildUserInviteEmailHtml({
    appName,
    logoUrl,
    name: payload.name || "Nutzer",
    email: recipient,
    role: payload.roleLabel || "Benutzer",
    temporaryPassword: payload.temporaryPassword || "",
    loginUrl,
  });
  const text = [
    `${appName} - Zugang eingerichtet`,
    "",
    `Hallo ${payload.name || "Nutzer"},`,
    `für dich wurde ein Zugang zu ${appName} angelegt.`,
    `Rolle: ${payload.roleLabel || "Benutzer"}`,
    `E-Mail: ${recipient}`,
    payload.temporaryPassword ? `Startpasswort: ${payload.temporaryPassword}` : "",
    "",
    loginUrl ? `Login: ${loginUrl}` : "Login: Bitte beim Administrator nach der Login-URL fragen.",
    "",
    "Wichtig: Bitte das Startpasswort direkt nach dem ersten Login ändern.",
  ]
    .filter(Boolean)
    .join("\n");

  await transporter.sendMail({
    from: settings.smtp_from,
    to: recipient,
    subject: `[${appName}] Dein Zugang wurde eingerichtet`,
    text,
    html,
    attachments,
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

async function sendEmailChangeConfirmation(settings, payload) {
  const recipient = String(payload?.recipient || "").trim();
  const confirmUrl = String(payload?.confirmUrl || "").trim();
  if (!recipient || !confirmUrl) {
    throw new Error("Bestätigungs-E-Mail konnte nicht erstellt werden.");
  }
  if (!settings.smtp_host || !settings.smtp_from) {
    throw new Error("SMTP ist nicht vollständig konfiguriert.");
  }

  const transporter = createSmtpTransport(settings);
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const logoFilePath = path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
  const logoCid = "heartpet-email-change-logo";
  const { attachments, logoUrl } = resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl });
  const html = buildEmailChangeConfirmationHtml({
    appName,
    logoUrl,
    name: payload.name || "Nutzer",
    newEmail: recipient,
    confirmUrl,
  });
  const text = [
    `${appName} - E-Mail-Änderung bestätigen`,
    "",
    `Hallo ${payload.name || "Nutzer"},`,
    "bitte bestätige die Änderung deiner E-Mail-Adresse.",
    `Neue E-Mail: ${recipient}`,
    "",
    `Bestätigen: ${confirmUrl}`,
    "",
    "Erst nach Bestätigung wird die neue E-Mail-Adresse aktiv.",
  ].join("\n");

  await transporter.sendMail({
    from: settings.smtp_from,
    to: recipient,
    subject: `[${appName}] Bitte E-Mail-Änderung bestätigen`,
    text,
    html,
    attachments,
  });
}

async function sendTelegramReminder(settings, reminder) {
  const animalPart = reminder.animal_name ? ` fuer *${escapeTelegram(reminder.animal_name)}*` : "";
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const animalUrl = appBaseUrl && reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : "";
  const dashboardUrl = appBaseUrl ? `${appBaseUrl}/` : "";
  const text = [
    `*${escapeTelegram(appName)}* Erinnerung${animalPart}`,
    ``,
    `*Titel:* ${escapeTelegram(reminder.title)}`,
    `*Faellig:* ${escapeTelegram(formatReminderDate(reminder.due_at))}`,
    `*Typ:* ${escapeTelegram(reminder.reminder_type)}`,
    reminder.notes ? `*Notiz:* ${escapeTelegram(reminder.notes)}` : "",
    animalUrl ? `*Tierakte:* ${escapeTelegram(animalUrl)}` : "",
    dashboardUrl ? `*Dashboard:* ${escapeTelegram(dashboardUrl)}` : "",
    "",
    `_Hinweis: Automatische Benachrichtigung aus HeartPet_`,
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

function createSmtpTransport(settings) {
  return nodemailer.createTransport({
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
}

function resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl }) {
  const attachments = [];
  let logoUrl = appBaseUrl ? `${appBaseUrl}/static/images/logo-heartpet.png` : "";
  if (fs.existsSync(logoFilePath)) {
    attachments.push({
      filename: "logo-heartpet.png",
      path: logoFilePath,
      cid: logoCid,
    });
    logoUrl = `cid:${logoCid}`;
  }
  return { attachments, logoUrl };
}

function escapeTelegram(value) {
  return String(value).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function getAppBaseUrl(settings) {
  const raw = String(settings.app_domain || "").trim();
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, "");
  }
  return `https://${raw}`.replace(/\/+$/, "");
}

function formatReminderDate(value) {
  return dayjs(value).format("DD.MM.YYYY HH:mm");
}

function buildReminderEmailHtml(payload) {
  const {
    appName,
    logoUrl,
    animalName,
    title,
    type,
    dueLabel,
    notes,
    animalUrl,
    dashboardUrl,
  } = payload;

  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const cardRow = (label, value) => `
    <tr>
      <td style="padding:8px 0;color:#5f7b6f;font-size:13px;">${safe(label)}</td>
      <td style="padding:8px 0;color:#1d3128;font-size:14px;font-weight:600;text-align:right;">${safe(value)}</td>
    </tr>
  `;

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div>
                      <div style="font-size:22px;font-weight:800;color:#1d3128;margin-top:4px;">Erinnerung</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 20px;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#31483f;">
                  Fuer <strong>${safe(animalName || "ein Tier")}</strong> ist eine Erinnerung eingegangen.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${cardRow("Titel", title)}
                  ${cardRow("Faelligkeit", dueLabel)}
                  ${cardRow("Typ", type)}
                </table>
                ${notes ? `<div style="margin-top:14px;padding:12px;border:1px solid #d8ebdf;background:#f6fcf9;border-radius:8px;color:#395247;font-size:13px;line-height:1.5;"><strong>Hinweis:</strong><br/>${safe(notes).replaceAll("\n", "<br/>")}</div>` : ""}
                <div style="margin-top:18px;display:flex;flex-wrap:wrap;gap:10px;">
                  ${animalUrl ? `<a href="${safe(animalUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">Zur Tierakte</a>` : ""}
                  ${dashboardUrl ? `<a href="${safe(dashboardUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:#edf7f2;color:#1d3128;border:1px solid #cfe5d8;text-decoration:none;font-weight:700;font-size:13px;">Dashboard</a>` : ""}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #e1f0e8;background:#f8fdfb;">
                <div style="font-size:12px;color:#6f897d;line-height:1.5;">
                  Diese Nachricht wurde automatisch von ${safe(appName)} versendet.<br/>
                  Wenn bereits erledigt, kannst du die Erinnerung in der Tierakte als erledigt markieren.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

function buildUserInviteEmailHtml(payload) {
  const { appName, logoUrl, name, email, role, temporaryPassword, loginUrl } = payload;

  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const dataRow = (label, value) => `
    <tr>
      <td style="padding:7px 0;color:#5f7b6f;font-size:13px;">${safe(label)}</td>
      <td style="padding:7px 0;color:#1d3128;font-size:14px;font-weight:600;text-align:right;">${safe(value)}</td>
    </tr>
  `;

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div>
                      <div style="font-size:22px;font-weight:800;color:#1d3128;margin-top:4px;">Zugang eingerichtet</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 20px;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#31483f;">
                  Hallo <strong>${safe(name || "Nutzer")}</strong>, für dich wurde ein Zugang in <strong>${safe(appName)}</strong> angelegt.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${dataRow("Name", name || "-")}
                  ${dataRow("E-Mail", email || "-")}
                  ${dataRow("Rolle", role || "-")}
                  ${dataRow("Startpasswort", temporaryPassword || "-")}
                </table>
                ${loginUrl ? `<div style="margin-top:18px;"><a href="${safe(loginUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">Zum Login</a></div>` : ""}
                <div style="margin-top:14px;padding:12px;border:1px solid #d8ebdf;background:#f6fcf9;border-radius:8px;color:#395247;font-size:13px;line-height:1.5;">
                  <strong>Wichtig:</strong> Bitte das Startpasswort direkt nach dem ersten Login ändern.
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #e1f0e8;background:#f8fdfb;">
                <div style="font-size:12px;color:#6f897d;line-height:1.5;">
                  Diese Nachricht wurde automatisch von ${safe(appName)} versendet.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

function buildEmailChangeConfirmationHtml(payload) {
  const { appName, logoUrl, name, newEmail, confirmUrl } = payload;
  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div>
                      <div style="font-size:22px;font-weight:800;color:#1d3128;margin-top:4px;">E-Mail bestätigen</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 20px;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#31483f;">
                  Hallo <strong>${safe(name)}</strong>, bitte bestätige die Änderung auf <strong>${safe(newEmail)}</strong>.
                </p>
                <a href="${safe(confirmUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">E-Mail jetzt bestätigen</a>
                <div style="margin-top:14px;padding:12px;border:1px solid #d8ebdf;background:#f6fcf9;border-radius:8px;color:#395247;font-size:13px;line-height:1.5;">
                  Erst nach Klick auf den Button wird die neue E-Mail-Adresse in HeartPet übernommen.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

module.exports = {
  processDueReminders,
  sendEmailReminder,
  sendTelegramReminder,
  sendUserInviteEmail,
  sendEmailChangeConfirmation,
  sendTestEmail,
  sendTestTelegram,
  isEmailEnabled,
  isTelegramEnabled,
};
