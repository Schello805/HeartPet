const crypto = require("node:crypto");
const path = require("node:path");
const { resolveSessionSecret } = require("../http-session");

let reminderActionSecret = "";

function buildReminderActionUrl(appBaseUrl, reminder, action, value = "") {
  if (!appBaseUrl || !reminder?.id) {
    return "";
  }

  const normalizedValue = value === undefined || value === null ? "" : String(value);
  const token = buildReminderActionToken(reminder, action, normalizedValue);
  const params = new URLSearchParams({ token });
  if (normalizedValue) {
    params.set("value", normalizedValue);
  }
  return `${appBaseUrl}/reminders/${reminder.id}/email-${action}?${params.toString()}`;
}

function buildReminderActionToken(reminder, action, value = "") {
  const payload = [
    reminder.id,
    action,
    value,
    reminder.due_at || "",
    reminder.title || "",
    reminder.animal_id || "",
    reminder.source_kind || "",
    reminder.source_id || "",
  ].join("|");
  return crypto.createHmac("sha256", getReminderActionSecret()).update(payload).digest("hex");
}

function verifyReminderActionToken(reminder, action, token, value = "") {
  const expected = buildReminderActionToken(reminder, action, value);
  const provided = String(token || "").trim();
  if (!provided || provided.length !== expected.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

function getReminderActionSecret() {
  if (!reminderActionSecret) {
    const dataDir = path.resolve(process.env.HEARTPET_DATA_DIR || path.join(process.cwd(), "data"));
    reminderActionSecret = resolveSessionSecret(dataDir);
  }
  return reminderActionSecret;
}

module.exports = {
  buildReminderActionUrl,
  buildReminderActionToken,
  verifyReminderActionToken,
};
