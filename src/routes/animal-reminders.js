const express = require("express");
const dayjs = require("dayjs");

function createAnimalRemindersRouter({
  db, requireAnimalPermission, safeLocalReturnPath, parsePositiveInteger, setFlash,
  createAuditLog, applyCompletionSideEffects, findAnimal, isActiveAnimalStatus,
  renderNotFound, safeRefererPath, getAnimalReturnTo, redirectDocumentDrawerRequest,
}) {
  const router = express.Router();

  router.post("/animals/:id/reminders", requireAnimalPermission("canManageReminders"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    db.prepare(`
      INSERT INTO reminders (
        animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
        last_delivery_status, last_delivery_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.body.title,
      req.body.reminder_type || "Allgemein",
      req.body.due_at,
      req.body.channel_email ? 1 : 0,
      req.body.channel_telegram ? 1 : 0,
      parsePositiveInteger(req.body.repeat_interval_days),
      req.body.notes || "",
      "pending",
      ""
    );
    setFlash(req, "success", "Erinnerung angelegt.");
    res.redirect(returnTo);
  });
  
  router.post("/animals/:animalId/reminders/:entryId/update", requireAnimalPermission("canManageReminders"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    db.prepare(`
      UPDATE reminders
      SET title = ?, reminder_type = ?, due_at = ?, channel_email = ?, channel_telegram = ?, repeat_interval_days = ?, notes = ?,
          last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
      WHERE id = ? AND animal_id = ?
    `).run(
      req.body.title,
      req.body.reminder_type || "Allgemein",
      req.body.due_at,
      req.body.channel_email ? 1 : 0,
      req.body.channel_telegram ? 1 : 0,
      parsePositiveInteger(req.body.repeat_interval_days),
      req.body.notes || "",
      req.params.entryId,
      req.params.animalId
    );
    setFlash(req, "success", "Erinnerung aktualisiert.");
    res.redirect(returnTo);
  });
  
  router.get("/animals/:animalId/reminders/:entryId/update", requireAnimalPermission("canManageReminders"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/reminders/${req.params.entryId}/edit`
    );
  });
  
  router.post("/animals/:animalId/reminders/:entryId/delete", requireAnimalPermission("canManageReminders"), (req, res) => {
    db.prepare("DELETE FROM reminders WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    createAuditLog(req, "reminder.delete", {
      reminder_id: req.params.entryId,
      animal_id: req.params.animalId,
    }, { entityType: "reminder", entityId: req.params.entryId });
    setFlash(req, "success", "Erinnerung gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });
  
  router.post("/animals/:id/reminders/bulk", requireAnimalPermission("canManageReminders"), (req, res) => {
    const selected = Array.isArray(req.body.reminder_ids) ? req.body.reminder_ids : [req.body.reminder_ids];
    const ids = selected
      .map((value) => Number.parseInt(String(value || ""), 10))
      .filter((value) => Number.isFinite(value));
    const action = String(req.body.bulk_action || "").trim();
  
    if (!ids.length) {
      setFlash(req, "error", "Bitte mindestens eine Erinnerung auswählen.");
      return res.redirect(`/animals/${req.params.id}`);
    }
  
    const placeholders = ids.map(() => "?").join(", ");
    const reminders = db.prepare(`
      SELECT *
      FROM reminders
      WHERE animal_id = ? AND id IN (${placeholders})
    `).all(req.params.id, ...ids);
  
    if (!reminders.length) {
      setFlash(req, "error", "Keine passenden Erinnerungen gefunden.");
      return res.redirect(`/animals/${req.params.id}`);
    }
  
    if (action === "complete") {
      const update = db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?");
      reminders.forEach((item) => {
        applyCompletionSideEffects(item);
        update.run(item.id);
      });
      createAuditLog(req, "reminder.bulk_complete", { ids, animal_id: req.params.id }, { entityType: "animal", entityId: req.params.id });
      setFlash(req, "success", `${reminders.length} Erinnerung(en) als erledigt markiert.`);
      return res.redirect(`/animals/${req.params.id}`);
    }
  
    if (action === "reopen") {
      const animal = findAnimal(req.params.id);
      if (!animal || !isActiveAnimalStatus(animal.status)) {
        setFlash(req, "error", "Erinnerungen können nur bei aktiven Tieren wieder geöffnet werden.");
        return res.redirect(`/animals/${req.params.id}`);
      }
      db.prepare("UPDATE reminders SET completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = '' WHERE id IN (" + placeholders + ")")
        .run(...reminders.map((item) => item.id));
      createAuditLog(req, "reminder.bulk_reopen", { ids, animal_id: req.params.id }, { entityType: "animal", entityId: req.params.id });
      setFlash(req, "success", `${reminders.length} Erinnerung(en) wieder geöffnet.`);
      return res.redirect(`/animals/${req.params.id}`);
    }
  
    if (action === "delete") {
      db.prepare("DELETE FROM reminders WHERE id IN (" + placeholders + ")").run(...reminders.map((item) => item.id));
      createAuditLog(req, "reminder.bulk_delete", { ids, animal_id: req.params.id }, { entityType: "animal", entityId: req.params.id });
      setFlash(req, "success", `${reminders.length} Erinnerung(en) gelöscht.`);
      return res.redirect(`/animals/${req.params.id}`);
    }
  
    setFlash(req, "error", "Ungültige Massenaktion.");
    res.redirect(`/animals/${req.params.id}`);
  });
  
  router.post("/reminders/:id/complete", requireAnimalPermission("canManageReminders"), (req, res) => {
    const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
    if (!reminder) {
      return renderNotFound(req, res, "Erinnerung nicht gefunden.");
    }
  
    if (Number(reminder.repeat_interval_days || 0) > 0) {
      applyCompletionSideEffects(reminder);
      db.prepare(`
        UPDATE reminders
        SET due_at = ?, completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'rescheduled', last_delivery_error = ''
        WHERE id = ?
      `).run(dayjs(reminder.due_at).add(Number(reminder.repeat_interval_days), "day").format("YYYY-MM-DDTHH:mm"), reminder.id);
      setFlash(req, "success", "Wiederkehrende Erinnerung abgeschlossen und neu terminiert.");
    } else {
      db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP, last_delivery_status = 'completed', last_delivery_error = '' WHERE id = ?").run(req.params.id);
      applyCompletionSideEffects(reminder);
      setFlash(req, "success", "Erinnerung als erledigt markiert.");
    }
    createAuditLog(req, "reminder.complete", { reminder_id: reminder.id, animal_id: reminder.animal_id }, { entityType: "reminder", entityId: reminder.id });
    res.redirect(safeRefererPath(req, "/"));
  });
  
  router.post("/reminders/:id/reopen", requireAnimalPermission("canManageReminders"), (req, res) => {
    const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
    if (!reminder) {
      return renderNotFound(req, res, "Erinnerung nicht gefunden.");
    }
  
    const animal = findAnimal(reminder.animal_id);
    if (!animal || !isActiveAnimalStatus(animal.status)) {
      setFlash(req, "error", "Erinnerungen können nur bei aktiven Tieren wieder geöffnet werden.");
      return res.redirect(safeRefererPath(req, "/"));
    }
  
    db.prepare(`
      UPDATE reminders
      SET completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
      WHERE id = ?
    `).run(req.params.id);
    createAuditLog(req, "reminder.reopen", { reminder_id: req.params.id }, { entityType: "reminder", entityId: req.params.id });
    setFlash(req, "success", "Erinnerung wieder geöffnet.");
    res.redirect(safeRefererPath(req, "/"));
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAnimalRemindersRouter };
