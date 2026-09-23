const dayjs = require("dayjs");
const nodemailer = require("nodemailer");
const fs = require("node:fs");
const path = require("node:path");
const { resolveStoredFilePath } = require("./storage-paths");
const { getInstanceDateTime } = require("./instance-timezone");
const { createReminderRepository } = require("./repositories/reminder-repository");
const { createNotificationChannels } = require("./services/notification-channels");
const { createReminderDeliveryService } = require("./services/reminder-delivery");
const { resolveAppBaseUrl } = require("./app-url");
const {
  buildReminderEmailHtml,
  buildUserInviteEmailHtml,
  buildUserCreatedAdminEmailHtml,
  buildEmailChangeConfirmationHtml,
  buildDailyDigestEmailHtml,
} = require("./services/reminder-email-templates");
const {
  buildReminderActionUrl,
  buildReminderActionToken,
  verifyReminderActionToken,
} = require("./services/reminder-action-links");

async function processDueReminders(db, settings, hooks = {}) {
  const now = getInstanceDateTime(settings).format("YYYY-MM-DDTHH:mm");
  const service = createReminderDeliveryService({
    repository: createReminderRepository(db),
    channels: createNotificationChannels({
      isEmailEnabled,
      isTelegramEnabled,
      isNtfyEnabled,
      sendEmailReminder,
      sendTelegramReminder,
      sendNtfyReminder,
      sendDailyDigestEmail,
      sendDailyDigestTelegram,
      sendDailyDigestNtfy,
    }),
  });
  await service.processDue(now, settings, hooks);
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
  const logoFilePath = getAppLogoFilePath(settings);
  const logoCid = "heartpet-logo";
  const { attachments, logoUrl } = resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl });
  const animalUrl = appBaseUrl && reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : "";
  const dashboardUrl = appBaseUrl ? `${appBaseUrl}/` : "";
  const completeUrl =
    appBaseUrl && reminder && reminder.id ? buildReminderActionUrl(appBaseUrl, reminder, "complete") : "";
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
    completeUrl,
  });
  const text = [
    `${appName} Erinnerung${animalPart}`,
    "",
    `Titel: ${reminder.title}`,
    `Fälligkeit: ${dueLabel}`,
    `Typ: ${reminder.reminder_type}`,
    reminder.notes ? `Notiz: ${reminder.notes}` : "",
    completeUrl ? `Direkt als erledigt markieren: ${completeUrl}` : "",
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
  const inviteUrl = String(payload?.inviteUrl || "").trim();
  const logoFilePath = getAppLogoFilePath(settings);
  const logoCid = "heartpet-invite-logo";
  const { attachments, logoUrl } = resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl });
  const html = buildUserInviteEmailHtml({
    appName,
    logoUrl,
    name: payload.name || "Nutzer",
    email: recipient,
    role: payload.roleLabel || "Benutzer",
    inviteUrl,
  });
  const text = [
    `${appName} - Zugang eingerichtet`,
    "",
    `Hallo ${payload.name || "Nutzer"},`,
    `für dich wurde ein Zugang zu ${appName} angelegt.`,
    `Rolle: ${payload.roleLabel || "Benutzer"}`,
    `E-Mail: ${recipient}`,
    "",
    inviteUrl ? `Passwort festlegen: ${inviteUrl}` : "Passwort festlegen: Bitte beim Administrator nach einem Einladungslink fragen.",
    "",
    "Wichtig: Lege zuerst dein eigenes Passwort fest. Erst danach kannst du dich einloggen.",
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

async function sendUserCreatedAdminEmail(settings, payload) {
  const recipients = Array.isArray(payload?.recipients)
    ? payload.recipients.map((email) => String(email || "").trim()).filter(Boolean)
    : [];
  if (!recipients.length) {
    throw new Error("Keine Administrator-Adresse für die Benachrichtigung angegeben.");
  }
  if (!settings.smtp_host || !settings.smtp_from) {
    throw new Error("SMTP ist nicht vollständig konfiguriert.");
  }

  const transporter = createSmtpTransport(settings);
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const logoFilePath = getAppLogoFilePath(settings);
  const logoCid = "heartpet-admin-user-logo";
  const { attachments, logoUrl } = resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl });
  const html = buildUserCreatedAdminEmailHtml({
    appName,
    logoUrl,
    name: payload.name || "-",
    email: payload.email || "-",
    role: payload.roleLabel || "Benutzer",
    createdBy: payload.createdBy || "Administrator",
    usersUrl: payload.usersUrl || `${appBaseUrl}/admin/benutzer`,
  });
  const text = [
    `${appName} - Neuer Benutzer angelegt`,
    "",
    `Name: ${payload.name || "-"}`,
    `E-Mail: ${payload.email || "-"}`,
    `Rolle: ${payload.roleLabel || "Benutzer"}`,
    `Angelegt von: ${payload.createdBy || "Administrator"}`,
    "",
    `Benutzer verwalten: ${payload.usersUrl || `${appBaseUrl}/admin/benutzer`}`,
  ].join("\n");

  await transporter.sendMail({
    from: settings.smtp_from,
    to: recipients,
    subject: `[${appName}] Neuer Benutzer angelegt: ${payload.name || payload.email || "Benutzer"}`,
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

async function verifySmtpConnection(settings) {
  if (!settings.smtp_host || !settings.smtp_from) {
    throw new Error("SMTP ist nicht vollständig konfiguriert.");
  }
  const transporter = createSmtpTransport(settings);
  await transporter.verify();
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
  const logoFilePath = getAppLogoFilePath(settings);
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

async function sendPasswordResetEmail(settings, payload) {
  const recipient = String(payload?.recipient || "").trim();
  const resetUrl = String(payload?.resetUrl || "").trim();
  if (!recipient || !resetUrl) throw new Error("Passwort-Reset-E-Mail konnte nicht erstellt werden.");
  if (!settings.smtp_host || !settings.smtp_from) throw new Error("SMTP ist nicht vollständig konfiguriert.");

  const transporter = createSmtpTransport(settings);
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const { attachments, logoUrl } = resolveEmailLogo({
    logoFilePath: getAppLogoFilePath(settings),
    logoCid: "heartpet-password-reset-logo",
    appBaseUrl,
  });
  const safe = (value) => String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const html = `<!doctype html><html lang="de"><body style="margin:0;padding:24px 12px;background:#f2faf6;font-family:Segoe UI,Arial,sans-serif;color:#1d3128;"><table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="100%" style="max-width:600px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;"><tr><td style="padding:20px;"><div style="display:flex;align-items:center;justify-content:space-between;gap:16px;"><div><div style="font-size:12px;color:#5f7b6f;text-transform:uppercase;letter-spacing:.08em;">${safe(appName)}</div><h1 style="font-size:22px;margin:5px 0 0;">Passwort zurücksetzen</h1></div>${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:56px;height:56px;object-fit:contain;" />` : ""}</div><p style="line-height:1.55;margin:20px 0;">Hallo ${safe(payload.name || "")}, über diesen einmalig nutzbaren Link kannst du dein Passwort neu festlegen. Der Link ist 30 Minuten gültig.</p><a href="${safe(resetUrl)}" style="display:inline-block;padding:11px 16px;border-radius:8px;background:#2e9a6f;color:#fff;text-decoration:none;font-weight:700;">Neues Passwort festlegen</a><p style="font-size:12px;color:#6f897d;line-height:1.5;margin:20px 0 0;">Falls du das nicht angefordert hast, kannst du diese Nachricht ignorieren. Dein bisheriges Passwort bleibt unverändert.</p></td></tr></table></td></tr></table></body></html>`;
  const text = [
    `${appName} - Passwort zurücksetzen`,
    "",
    `Hallo ${payload.name || ""},`,
    "über diesen einmalig nutzbaren Link kannst du dein Passwort neu festlegen. Er ist 30 Minuten gültig:",
    resetUrl,
    "",
    "Falls du das nicht angefordert hast, kannst du diese Nachricht ignorieren.",
  ].join("\n");

  await transporter.sendMail({
    from: settings.smtp_from,
    to: recipient,
    subject: `[${appName}] Passwort zurücksetzen`,
    text,
    html,
    attachments,
  });
}

async function sendTelegramReminder(settings, reminder) {
  const animalPart = reminder.animal_name ? ` für *${escapeTelegram(reminder.animal_name)}*` : "";
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const animalUrl = appBaseUrl && reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : "";
  const dashboardUrl = appBaseUrl ? `${appBaseUrl}/` : "";
  const completeUrl =
    appBaseUrl && reminder && reminder.id ? buildReminderActionUrl(appBaseUrl, reminder, "complete") : "";
  const snoozePresets = [
    { label: "+60 Min", minutes: 60 },
    { label: "+6 Std", minutes: 360 },
    { label: "+1 Tag", minutes: 1440 },
    { label: "+3 Tage", minutes: 4320 },
  ];
  const text = [
    `*${escapeTelegram(appName)}* Erinnerung${animalPart}`,
    ``,
    `*Titel:* ${escapeTelegram(reminder.title)}`,
    `*Fällig:* ${escapeTelegram(formatReminderDate(reminder.due_at))}`,
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
      reply_markup:
        completeUrl
          ? {
              inline_keyboard: [
                [{ text: "Als erledigt markieren", url: completeUrl }],
                snoozePresets.map((preset) => ({
                  text: preset.label,
                  url: buildReminderActionUrl(appBaseUrl, reminder, "snooze", preset.minutes),
                })),
                ...(animalUrl ? [[{ text: "Zur Tierakte", url: animalUrl }]] : []),
              ],
            }
          : undefined,
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
      isEmailConfigured(settings)
  );
}

function isTelegramEnabled(settings) {
  return Boolean(
    settings.reminder_telegram_enabled === "true" &&
      isTelegramConfigured(settings)
  );
}

function isNtfyEnabled(settings) {
  return Boolean(settings.reminder_ntfy_enabled === "true" && isNtfyConfigured(settings));
}

function isEmailConfigured(settings) {
  return Boolean(
    settings.smtp_host &&
      settings.smtp_from &&
      (settings.notification_email_to || settings.smtp_user)
  );
}

function isTelegramConfigured(settings) {
  return Boolean(
    settings.telegram_bot_token &&
      settings.telegram_chat_id
  );
}

function isNtfyConfigured(settings) {
  try {
    const server = new URL(settings.ntfy_server_url || "https://ntfy.sh");
    return Boolean(/^https?:$/.test(server.protocol) && String(settings.ntfy_topic || "").trim());
  } catch {
    return false;
  }
}

async function sendNtfy(settings, { title, message, clickUrl = "", priority = "default" }) {
  if (!isNtfyConfigured(settings)) throw new Error("ntfy ist noch nicht vollständig konfiguriert.");
  const server = String(settings.ntfy_server_url || "https://ntfy.sh").replace(/\/$/, "");
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: title,
    Priority: priority,
    Tags: "paw_prints",
  };
  if (clickUrl) headers.Click = clickUrl;
  if (settings.ntfy_access_token) headers.Authorization = `Bearer ${settings.ntfy_access_token}`;
  const response = await fetch(`${server}/${encodeURIComponent(String(settings.ntfy_topic).trim())}`, {
    method: "POST",
    headers,
    body: message,
  });
  if (!response.ok) throw new Error(`ntfy-Versand fehlgeschlagen: HTTP ${response.status}`);
}

async function sendNtfyReminder(settings, reminder) {
  const appBaseUrl = getAppBaseUrl(settings);
  const animalUrl = appBaseUrl && reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : appBaseUrl;
  return sendNtfy(settings, {
    title: `${settings.app_name || "HeartPet"}: ${reminder.title}`,
    message: `${reminder.animal_name || "Tier"} · fällig ${formatReminderDate(reminder.due_at)}${reminder.notes ? `\n${reminder.notes}` : ""}`,
    clickUrl: animalUrl,
    priority: "high",
  });
}

async function sendTestNtfy(settings) {
  return sendNtfy(settings, {
    title: `${settings.app_name || "HeartPet"}: ntfy-Test`,
    message: "Die ntfy-Verbindung funktioniert.",
    clickUrl: getAppBaseUrl(settings),
  });
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
  let logoUrl = getAppLogoUrl({ app_logo_stored_name: "" }, appBaseUrl);
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

function getAppLogoFilePath(settings) {
  const storedName = String(settings?.app_logo_stored_name || "").trim();
  if (!storedName) {
    return path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
  }
  const dataDir = path.resolve(process.env.HEARTPET_DATA_DIR || path.join(process.cwd(), "data"));
  return resolveStoredFilePath(path.join(dataDir, "uploads"), storedName)
    || path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
}

function getAppLogoUrl(settings, appBaseUrl) {
  const storedName = String(settings?.app_logo_stored_name || "").trim();
  if (!storedName) {
    return appBaseUrl ? `${appBaseUrl}/static/images/logo-heartpet.png` : "";
  }
  return appBaseUrl ? `${appBaseUrl}/media/${storedName}` : "";
}

function escapeTelegram(value) {
  return String(value).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function getAppBaseUrl(settings) {
  return resolveAppBaseUrl(settings);
}

function formatReminderDate(value) {
  return dayjs(value).format("DD.MM.YYYY HH:mm");
}


async function sendDailyDigestEmail(settings, payload) {
  const recipient = settings.notification_email_to || settings.smtp_user;
  if (!recipient) {
    throw new Error("Keine Empfängeradresse für die Tageszusammenfassung konfiguriert.");
  }

  const transporter = createSmtpTransport(settings);
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const logoFilePath = getAppLogoFilePath(settings);
  const logoCid = "heartpet-digest-logo";
  const { attachments, logoUrl } = resolveEmailLogo({ logoFilePath, logoCid, appBaseUrl });
  const dashboardUrl = appBaseUrl ? `${appBaseUrl}/` : "";
  const html = buildDailyDigestEmailHtml({
    appName,
    logoUrl,
    dashboardUrl,
    generatedAt: payload.generatedAt,
    counts: payload.counts,
    rows: payload.rows,
  });

  const lines = [
    `${appName} Tageszusammenfassung`,
    "",
    `Überfällig: ${payload.counts.overdue}`,
    `Heute: ${payload.counts.today}`,
    `Nächste 3 Tage: ${payload.counts.nextDays}`,
    "",
    ...payload.rows.map((item) => `- ${item.dueLabel} | ${item.animal_name || "Ohne Tier"} | ${item.title}`),
    "",
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : "",
  ].filter(Boolean);

  await transporter.sendMail({
    from: settings.smtp_from,
    to: recipient,
    subject: `[${appName}] Tageszusammenfassung Erinnerungen`,
    text: lines.join("\n"),
    html,
    attachments,
  });
}

async function sendDailyDigestTelegram(settings, payload) {
  const appName = settings.app_name || "HeartPet";
  const appBaseUrl = getAppBaseUrl(settings);
  const dashboardUrl = appBaseUrl ? `${appBaseUrl}/` : "";
  const lines = [
    `*${escapeTelegram(appName)}* Tageszusammenfassung`,
    "",
    `*Überfällig:* ${escapeTelegram(String(payload.counts.overdue))}`,
    `*Heute:* ${escapeTelegram(String(payload.counts.today))}`,
    `*Nächste 3 Tage:* ${escapeTelegram(String(payload.counts.nextDays))}`,
    "",
    ...payload.rows.slice(0, 10).map((item) => `• ${escapeTelegram(`${item.dueLabel} | ${item.animal_name || "Ohne Tier"} | ${item.title}`)}`),
    dashboardUrl ? `\n*Dashboard:* ${escapeTelegram(dashboardUrl)}` : "",
  ].filter(Boolean);

  const response = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: settings.telegram_chat_id,
      text: lines.join("\n"),
      parse_mode: "MarkdownV2",
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram-Tageszusammenfassung fehlgeschlagen: ${response.status}`);
  }
}

async function sendDailyDigestNtfy(settings, payload) {
  const lines = [
    `Überfällig: ${payload.counts.overdue}`,
    `Heute: ${payload.counts.today}`,
    `Nächste 3 Tage: ${payload.counts.nextDays}`,
    ...payload.rows.slice(0, 8).map((item) => `${item.dueLabel} · ${item.animal_name || "Tier"} · ${item.title}`),
  ];
  return sendNtfy(settings, {
    title: `${settings.app_name || "HeartPet"}: Tageszusammenfassung`,
    message: lines.join("\n"),
    clickUrl: getAppBaseUrl(settings),
    priority: payload.counts.overdue ? "high" : "default",
  });
}

module.exports = {
  processDueReminders,
  sendEmailReminder,
  sendTelegramReminder,
  sendNtfyReminder,
  sendDailyDigestEmail,
  sendDailyDigestTelegram,
  sendDailyDigestNtfy,
  sendUserInviteEmail,
  sendUserCreatedAdminEmail,
  sendEmailChangeConfirmation,
  sendPasswordResetEmail,
  sendTestEmail,
  sendTestTelegram,
  sendTestNtfy,
  verifySmtpConnection,
  isEmailEnabled,
  isTelegramEnabled,
  isNtfyEnabled,
  isEmailConfigured,
  isTelegramConfigured,
  isNtfyConfigured,
  buildReminderActionToken,
  verifyReminderActionToken,
  buildReminderEmailHtml,
};
