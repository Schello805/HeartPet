const cron = require("node-cron");
const dayjs = require("dayjs");

function createReminderScheduler({
  db,
  repository,
  getSettings,
  upsertSetting,
  formatDateTime,
  notifications,
  processDueReminders,
  createNotificationLog,
}) {
  async function sendDailyDigest() {
    const settings = getSettings();
    if (settings.daily_digest_enabled !== "true") return;

    const [hourRaw, minuteRaw] = String(settings.daily_digest_time || "07:30").trim().split(":");
    const hour = clampTimePart(hourRaw, 23, 7);
    const minute = clampTimePart(minuteRaw, 59, 30);
    const now = dayjs();
    const today = now.format("YYYY-MM-DD");
    const sendAt = dayjs(`${today}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);

    if (String(settings.last_daily_digest_date || "").trim() === today || now.isBefore(sendAt)) return;

    const counts = getDigestCounts(now, today);
    if (settings.daily_digest_only_when_open === "true" && counts.overdue + counts.today + counts.nextDays === 0) {
      markDigestHandled(today, [{
        channel: "system",
        status: "skipped",
        recipient: "",
        details: { reason: "no_open_reminders" },
      }]);
      return;
    }

    const payload = {
      generatedAt: formatDateTime(now.format("YYYY-MM-DDTHH:mm")),
      counts,
      rows: repository.listDigest(now.add(3, "day").format("YYYY-MM-DDTHH:mm"))
        .map((item) => ({ ...item, dueLabel: formatDateTime(item.due_at) })),
    };

    const deliveries = [];
    try {
      for (const channel of ["email", "telegram", "ntfy"]) {
        if (!notifications[channel].enabled(settings)) continue;
        await notifications[channel].sendDigest(settings, payload);
        deliveries.push({
          channel,
          status: "sent",
          recipient: notifications[channel].recipient(settings),
        });
      }
      if (!deliveries.length) deliveries.push({ channel: "system", status: "skipped", recipient: "" });
    } catch (error) {
      deliveries.push({ channel: "system", status: "error", recipient: "", error: error.message });
    }
    markDigestHandled(today, deliveries, payload.counts);
  }

  function getDigestCounts(now, today) {
    const count = (condition, ...params) => repository.countActiveOpen(condition, ...params);
    return {
      overdue: count("REPLACE(reminders.due_at, ' ', 'T') < ?", now.format("YYYY-MM-DDTHH:mm")),
      today: count("REPLACE(reminders.due_at, ' ', 'T') >= ? AND REPLACE(reminders.due_at, ' ', 'T') <= ?", `${today}T00:00`, `${today}T23:59`),
      nextDays: count("REPLACE(reminders.due_at, ' ', 'T') > ? AND REPLACE(reminders.due_at, ' ', 'T') <= ?", `${today}T23:59`, now.add(3, "day").format("YYYY-MM-DDTHH:mm")),
    };
  }

  function markDigestHandled(date, deliveries, defaultDetails = {}) {
    deliveries.forEach((entry) => createNotificationLog({
      userId: null,
      channel: entry.channel,
      type: "daily_digest",
      recipient: entry.recipient,
      subject: "Tageszusammenfassung",
      status: entry.status,
      error: entry.error || "",
      details: entry.details || defaultDetails,
    }));
    upsertSetting(db, "last_daily_digest_date", date);
  }

  async function run() {
    await processDueReminders(db, getSettings(), {
      onNotification: (entry) => createNotificationLog({
        userId: null,
        channel: entry.channel,
        type: entry.type,
        recipient: entry.recipient || "",
        subject: entry.subject || "",
        status: entry.status,
        error: entry.error || "",
        details: {
          reminder_id: entry.reminder?.id || null,
          animal_id: entry.reminder?.animal_id || null,
        },
      }),
    });
    await sendDailyDigest();
  }

  function start() {
    return cron.schedule("*/10 * * * *", async () => {
      try {
        await run();
      } catch (error) {
        console.error("[HeartPet] Fehler im Erinnerungsdienst:", error.message);
      }
    });
  }

  return { run, sendDailyDigest, start };
}

function clampTimePart(value, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(0, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

module.exports = { createReminderScheduler };
