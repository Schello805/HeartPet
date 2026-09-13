const express = require("express");
const dayjs = require("dayjs");

function createReminderActionsRouter({
  db,
  getSettings,
  resolveAppBaseUrl,
  verifyActionToken,
  isActiveAnimalStatus,
  applyCompletionSideEffects,
  createAuditLog,
}) {
  const router = express.Router();

  function findReminder(id) {
    return db.prepare(`
      SELECT reminders.*, animals.status AS animal_status
      FROM reminders
      LEFT JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.id = ?
    `).get(id);
  }

  function renderResult(res, appBaseUrl, options) {
    return res.render("pages/reminder-email-result", {
      pageTitle: options.title,
      success: options.success,
      title: options.title,
      message: options.message,
      nextUrl: options.nextUrl || `${appBaseUrl}/`,
      nextLabel: options.nextLabel || "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  function animalTarget(reminder, appBaseUrl) {
    return reminder?.animal_id
      ? { nextUrl: `${appBaseUrl}/animals/${reminder.animal_id}`, nextLabel: "Zur Tierakte" }
      : {};
  }

  router.get("/reminders/:id/email-complete", (req, res) => {
    const reminder = findReminder(req.params.id);
    const appBaseUrl = resolveAppBaseUrl(getSettings());

    if (!reminder) {
      return renderResult(res, appBaseUrl, {
        title: "Erinnerung nicht gefunden",
        success: false,
        message: "Diese Erinnerungs-Mail gehört nicht mehr zu einer vorhandenen Erinnerung oder wurde bereits gelöscht.",
      });
    }
    if (!verifyActionToken(reminder, "complete", req.query.token)) {
      return renderResult(res, appBaseUrl, {
        title: "Link ungültig",
        success: false,
        message: "Der Bestätigungslink ist ungültig oder wurde verändert. Bitte öffne die Tierakte und markiere die Erinnerung dort.",
      });
    }
    if (reminder.animal_id && !isActiveAnimalStatus(reminder.animal_status)) {
      return renderResult(res, appBaseUrl, {
        title: "Tier nicht mehr aktiv",
        success: false,
        message: "Diese Erinnerung gehört zu einem Tier, das nicht mehr im aktiven Bestand ist. Es werden dafür keine Erinnerungen mehr versendet.",
      });
    }
    if (reminder.completed_at) {
      return renderResult(res, appBaseUrl, {
        title: "Erinnerung bereits erledigt",
        success: true,
        message: "Diese Erinnerung war bereits als erledigt markiert. Du musst nichts weiter tun.",
      });
    }

    applyCompletionSideEffects(reminder);
    let message = "Die Erinnerung wurde als erledigt markiert.";
    if (Number(reminder.repeat_interval_days || 0) > 0) {
      const nextDueAt = dayjs(reminder.due_at)
        .add(Number(reminder.repeat_interval_days), "day")
        .format("YYYY-MM-DDTHH:mm");
      db.prepare(`
        UPDATE reminders
        SET due_at = ?, completed_at = NULL, last_notified_at = NULL,
            last_delivery_status = 'pending', last_delivery_error = ''
        WHERE id = ?
      `).run(nextDueAt, reminder.id);
      message = "Die wiederkehrende Erinnerung wurde bestätigt und neu terminiert.";
    } else {
      db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(reminder.id);
    }

    createAuditLog(req, "reminder.email_complete", {
      reminder_id: reminder.id,
      animal_id: reminder.animal_id,
    }, { entityType: "reminder", entityId: reminder.id });

    return renderResult(res, appBaseUrl, {
      title: "Erinnerung bestätigt",
      success: true,
      message,
      ...animalTarget(reminder, appBaseUrl),
    });
  });

  router.get("/reminders/:id/email-snooze", (req, res) => {
    const reminder = findReminder(req.params.id);
    const appBaseUrl = resolveAppBaseUrl(getSettings());
    const allowedMinutes = new Set(["60", "360", "1440", "4320"]);
    const value = String(req.query.value || "").trim();

    if (!reminder) {
      return renderResult(res, appBaseUrl, {
        title: "Erinnerung nicht gefunden",
        success: false,
        message: "Diese Erinnerungs-Mail gehört nicht mehr zu einer vorhandenen Erinnerung oder wurde bereits gelöscht.",
      });
    }
    if (!allowedMinutes.has(value)) {
      return renderResult(res, appBaseUrl, {
        title: "Link ungültig",
        success: false,
        message: "Die gewünschte Zurückstellung ist ungültig. Bitte öffne die Erinnerung direkt in HeartPet.",
        ...animalTarget(reminder, appBaseUrl),
      });
    }
    if (!verifyActionToken(reminder, "snooze", req.query.token, value)) {
      return renderResult(res, appBaseUrl, {
        title: "Link ungültig",
        success: false,
        message: "Der Zurückstellen-Link ist ungültig oder wurde verändert. Bitte öffne die Erinnerung direkt in HeartPet.",
        ...animalTarget(reminder, appBaseUrl),
      });
    }
    if (reminder.animal_id && !isActiveAnimalStatus(reminder.animal_status)) {
      return renderResult(res, appBaseUrl, {
        title: "Tier nicht mehr aktiv",
        success: false,
        message: "Diese Erinnerung gehört zu einem Tier, das nicht mehr im aktiven Bestand ist. Zurückstellen ist deshalb nicht mehr möglich.",
      });
    }

    const minutes = Number(value);
    const nextDueAt = dayjs().add(minutes, "minute");
    db.prepare(`
      UPDATE reminders
      SET due_at = ?, completed_at = NULL, last_notified_at = NULL,
          last_delivery_status = 'pending', last_delivery_error = ''
      WHERE id = ?
    `).run(nextDueAt.format("YYYY-MM-DDTHH:mm"), reminder.id);

    createAuditLog(req, "reminder.email_snooze", {
      reminder_id: reminder.id,
      animal_id: reminder.animal_id,
      minutes,
    }, { entityType: "reminder", entityId: reminder.id });

    return renderResult(res, appBaseUrl, {
      title: "Erinnerung zurückgestellt",
      success: true,
      message: `Die Erinnerung wurde bis ${nextDueAt.format("DD.MM.YYYY HH:mm")} zurückgestellt.`,
      ...animalTarget(reminder, appBaseUrl),
    });
  });

  return router;
}

module.exports = { createReminderActionsRouter };
