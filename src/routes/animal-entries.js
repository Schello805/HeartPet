const express = require("express");
const dayjs = require("dayjs");

function createAnimalEntriesRouter({
  buildPermissions,
  combineDateAndTime,
  createAuditLog,
  db,
  discardUploadedFile,
  findAnimal,
  getAnimalReturnTo,
  getCurrentUserRecord,
  getVaccinationCertificateError,
  getVaccinationSuggestionsForSpecies,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  renderNotFound,
  requireAnimalPermission,
  reminders,
  safeLocalReturnPath,
  setFlash,
  upload,
}) {
  const router = express.Router();
  const {
    appendVeterinarianNote,
    getNotificationChannelDefaults,
    syncAppointmentReminders,
    syncMedicationReminders,
    syncVaccinationReminders,
  } = reminders;

  function renderAnimalEntryDrawer(req, res, { entryType, mode = "create", item = null }) {
    const animal = findAnimal(req.params.id || req.params.animalId);
    if (!animal) {
      return renderNotFound(req, res, "Tier nicht gefunden.");
    }

    if (!isDrawerRequest(req)) {
      return redirectDocumentDrawerRequest(req, res, getAnimalReturnTo(req, `/animals/${animal.id}`));
    }

    const titleMap = {
      event: "Ereignis erstellen",
      condition: mode === "edit" ? "Vorerkrankung bearbeiten" : "Vorerkrankung anlegen",
      feeding: mode === "edit" ? "Fütterung bearbeiten" : "Fütterung anlegen",
      note: mode === "edit" ? "Protokoll bearbeiten" : "Protokoll anlegen",
      medication: "Medikament bearbeiten",
      vaccination: "Impfung bearbeiten",
      appointment: "Arzttermin bearbeiten",
      reminder: "Erinnerung bearbeiten",
      document: mode === "edit" ? "Dokument bearbeiten" : "Dokument hochladen",
      image: "Foto hochladen",
    };

    res.render("pages/animal-entry-drawer", {
      pageTitle: titleMap[entryType] || "Eintrag bearbeiten",
      animal,
      entryType,
      mode,
      item,
      permissions: buildPermissions(getCurrentUserRecord(req)),
      categories: db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all(),
      veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
      returnTo: safeLocalReturnPath(req.query.return_to, `/animals/${animal.id}`),
      initialEventKind: String(req.query.kind || "").trim(),
      vaccinationSuggestions: getVaccinationSuggestionsForSpecies(
        animal.species_name,
        db.prepare("SELECT species_name, name FROM vaccination_presets ORDER BY species_name, name").all(),
      ),
    });
  }

  router.get("/animals/:id/events/new", (req, res) => {
    const permissions = buildPermissions(getCurrentUserRecord(req));
    if (!permissions.canManageHealth && !permissions.canManageReminders && !permissions.canManageFeedings && !permissions.canManageNotes) {
      setFlash(req, "error", "Für neue Ereignisse fehlen die erforderlichen Rechte.");
      return res.redirect(safeLocalReturnPath(req.query.return_to, `/animals/${req.params.id}`));
    }

    return renderAnimalEntryDrawer(req, res, { entryType: "event" });
  });

  router.get("/animals/:id/conditions/new", requireAnimalPermission("canManageHealth"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "condition" }));
  router.get("/animals/:animalId/conditions/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
    const item = db.prepare("SELECT * FROM animal_conditions WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Vorerkrankung nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "condition", mode: "edit", item });
  });

  router.get("/animals/:id/feedings/new", requireAnimalPermission("canManageFeedings"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "feeding" }));
  router.get("/animals/:animalId/feedings/:entryId/edit", requireAnimalPermission("canManageFeedings"), (req, res) => {
    const item = db.prepare("SELECT * FROM animal_feedings WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Fütterung nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "feeding", mode: "edit", item });
  });

  router.get("/animals/:id/notes/new", requireAnimalPermission("canManageNotes"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "note" }));
  router.get("/animals/:animalId/notes/:entryId/edit", requireAnimalPermission("canManageNotes"), (req, res) => {
    const item = db.prepare("SELECT * FROM animal_notes WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Protokolleintrag nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "note", mode: "edit", item });
  });

  router.get("/animals/:animalId/medications/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
    const item = db.prepare("SELECT * FROM animal_medications WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Medikament nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "medication", mode: "edit", item });
  });

  router.get("/animals/:animalId/vaccinations/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
    const item = db.prepare("SELECT * FROM animal_vaccinations WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Impfung nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "vaccination", mode: "edit", item });
  });

  router.get("/animals/:animalId/appointments/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
    const item = db.prepare("SELECT * FROM animal_appointments WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Arzttermin nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "appointment", mode: "edit", item });
  });

  router.get("/animals/:animalId/reminders/:entryId/edit", requireAnimalPermission("canManageReminders"), (req, res) => {
    const item = db.prepare("SELECT * FROM reminders WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Erinnerung nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "reminder", mode: "edit", item });
  });

  router.get("/animals/:id/documents/new", requireAnimalPermission("canManageDocuments"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "document" }));
  router.get("/animals/:animalId/documents/:entryId/edit", requireAnimalPermission("canManageDocuments"), (req, res) => {
    const item = db.prepare("SELECT * FROM documents WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!item) {
      return renderNotFound(req, res, "Dokument nicht gefunden.");
    }
    return renderAnimalEntryDrawer(req, res, { entryType: "document", mode: "edit", item });
  });

  router.get("/animals/:id/images/new", requireAnimalPermission("canManageGallery"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "image" }));


  router.post("/animals/:id/events", upload.single("vaccination_certificate"), (req, res) => {
    const user = req.session.user ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id) : null;
    const permissions = buildPermissions(user);
    const eventKind = String(req.body.event_kind || "").trim();
    const title = String(req.body.title || "").trim();
    const notes = appendVeterinarianNote(req.body.notes, req.body.handled_by_veterinarian, req.body.veterinarian_id);
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    const certificateError = getVaccinationCertificateError(req.file);
    if (certificateError) {
      discardUploadedFile(req.file);
      setFlash(req, "error", certificateError);
      return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    if (!["medication", "vaccination", "appointment", "reminder", "feeding", "note"].includes(eventKind)) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Bitte wähle einen gültigen Ereignistyp aus.");
      return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    if (!title) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Bitte gib eine Bezeichnung für das Ereignis an.");
      return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    if (req.body.handled_by_veterinarian && !req.body.veterinarian_id) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Bitte wähle einen Tierarzt aus oder entferne den Haken „Durch Tierarzt“.");
      return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    if (eventKind === "reminder" && !permissions.canManageReminders) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Für freie Erinnerungen fehlen die erforderlichen Rechte.");
      return res.redirect(`/animals/${req.params.id}`);
    }

    if (eventKind === "feeding" && !permissions.canManageFeedings) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Für Fütterungseinträge fehlen die erforderlichen Rechte.");
      return res.redirect(`/animals/${req.params.id}`);
    }

    if (eventKind === "note" && !permissions.canManageNotes) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Für Notizen fehlen die erforderlichen Rechte.");
      return res.redirect(`/animals/${req.params.id}`);
    }

    if (["medication", "vaccination", "appointment"].includes(eventKind) && !permissions.canManageHealth) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Für medizinische Ereignisse fehlen die erforderlichen Rechte.");
      return res.redirect(`/animals/${req.params.id}`);
    }

    try {
      if (eventKind !== "vaccination") {
        discardUploadedFile(req.file);
        req.file = null;
      }
      if (eventKind === "feeding") {
        db.prepare("INSERT INTO animal_feedings (animal_id, label, time_of_day, food, amount, notes) VALUES (?, ?, ?, ?, ?, ?)")
          .run(req.params.id, title, String(req.body.event_time || "").trim(), "", "", notes);
        setFlash(req, "success", "Fütterung gespeichert.");
        return res.redirect(returnTo);
      }

      if (eventKind === "note") {
        db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
          .run(req.params.id, title, notes || title);
        setFlash(req, "success", "Notiz gespeichert.");
        return res.redirect(returnTo);
      }

      if (eventKind === "medication") {
        const startDate = String(req.body.event_date || "").trim();
        if (!startDate) {
          throw new Error("Bitte gib ein Datum für das Medikament an.");
        }

        const result = db.prepare(`
          INSERT INTO animal_medications (animal_id, name, dosage, schedule, start_date, end_date, reminder_enabled, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          req.params.id,
          title,
          "",
          "",
          startDate,
          null,
          req.body.create_reminder ? 1 : 0,
          notes
        );
        syncMedicationReminders(req.params.id, result.lastInsertRowid);
        setFlash(req, "success", "Medikament gespeichert.");
        return res.redirect(returnTo);
      }

      if (eventKind === "vaccination") {
        const eventDate = String(req.body.event_date || "").trim();
        if (!eventDate) {
          throw new Error("Bitte gib ein Datum für die Impfung an.");
        }
        const isFuture = dayjs(eventDate).isAfter(dayjs(), "day");

        const result = db.prepare(`
          INSERT INTO animal_vaccinations (
            animal_id, name, vaccination_date, next_due_date, reminder_enabled, notes,
            certificate_original_name, certificate_stored_name, certificate_mime_type, certificate_file_size
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          req.params.id,
          title,
          isFuture ? null : eventDate,
          isFuture ? eventDate : null,
          req.body.create_reminder ? 1 : 0,
          notes,
          req.file?.originalname || null,
          req.file?.filename || null,
          req.file?.mimetype || null,
          req.file?.size || null
        );
        syncVaccinationReminders(req.params.id, result.lastInsertRowid);
        setFlash(req, "success", "Impfung gespeichert.");
        return res.redirect(returnTo);
      }

      if (eventKind === "appointment") {
        const appointmentAt = combineDateAndTime(req.body.event_date, req.body.event_time, "09:00");
        if (!appointmentAt) {
          throw new Error("Bitte gib Datum und Uhrzeit für den Arzttermin an.");
        }

        const result = db.prepare(`
          INSERT INTO animal_appointments (animal_id, title, appointment_at, location_mode, location_text, veterinarian_id, reminder_enabled, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          req.params.id,
          title,
          appointmentAt,
          req.body.handled_by_veterinarian ? "praxis" : "praxis",
          "",
          req.body.handled_by_veterinarian ? (req.body.veterinarian_id || null) : null,
          req.body.create_reminder ? 1 : 0,
          notes
        );
        syncAppointmentReminders(req.params.id, result.lastInsertRowid);
        setFlash(req, "success", "Arzttermin gespeichert.");
        return res.redirect(returnTo);
      }

      const dueAt = combineDateAndTime(req.body.event_date, req.body.event_time, "09:00");
      if (!dueAt) {
        throw new Error("Bitte gib Datum und Uhrzeit für die freie Erinnerung an.");
      }

      const reminderChannels = getNotificationChannelDefaults();
      db.prepare(`
        INSERT INTO reminders (
          animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
          last_delivery_status, last_delivery_error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        title,
        "Allgemein",
        dueAt,
        reminderChannels.channelEmail,
        reminderChannels.channelTelegram,
        0,
        notes,
        "pending",
        ""
      );
      setFlash(req, "success", "Freie Erinnerung gespeichert.");
      return res.redirect(returnTo);
    } catch (error) {
      discardUploadedFile(req.file);
      setFlash(req, "error", error.message || "Das Ereignis konnte nicht gespeichert werden.");
      return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
    }
  });


  router.post("/animals/:id/feedings", requireAnimalPermission("canManageFeedings"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    db.prepare(`
      INSERT INTO animal_feedings (animal_id, label, time_of_day, food, amount, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.body.label,
      req.body.time_of_day || "",
      req.body.food || "",
      req.body.amount || "",
      req.body.notes || ""
    );
    setFlash(req, "success", "Fütterungsplan gespeichert.");
    res.redirect(returnTo);
  });

  router.post("/animals/:animalId/feedings/:entryId/update", requireAnimalPermission("canManageFeedings"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    db.prepare(`
      UPDATE animal_feedings
      SET label = ?, time_of_day = ?, food = ?, amount = ?, notes = ?
      WHERE id = ? AND animal_id = ?
    `).run(
      req.body.label,
      req.body.time_of_day || "",
      req.body.food || "",
      req.body.amount || "",
      req.body.notes || "",
      req.params.entryId,
      req.params.animalId
    );
    setFlash(req, "success", "Fütterungsplan aktualisiert.");
    res.redirect(returnTo);
  });

  router.get("/animals/:animalId/feedings/:entryId/update", requireAnimalPermission("canManageFeedings"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/feedings/${req.params.entryId}/edit`
    );
  });

  router.post("/animals/:animalId/feedings/:entryId/delete", requireAnimalPermission("canManageFeedings"), (req, res) => {
    db.prepare("DELETE FROM animal_feedings WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    setFlash(req, "success", "Fütterungsplan gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });

  router.post("/animals/:id/notes", requireAnimalPermission("canManageNotes"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
      .run(req.params.id, req.body.title, req.body.content);
    createAuditLog(req, "animal.note_create", {
      animal_id: req.params.id,
      title: String(req.body.title || "").trim(),
    }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", "Protokolleintrag gespeichert.");
    res.redirect(returnTo);
  });

  router.post("/animals/:animalId/notes/:entryId/update", requireAnimalPermission("canManageNotes"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    db.prepare(`
      UPDATE animal_notes
      SET title = ?, content = ?
      WHERE id = ? AND animal_id = ?
    `).run(req.body.title, req.body.content, req.params.entryId, req.params.animalId);
    createAuditLog(req, "animal.note_update", {
      animal_id: req.params.animalId,
      title: String(req.body.title || "").trim(),
    }, { entityType: "animal", entityId: req.params.animalId });
    setFlash(req, "success", "Protokolleintrag aktualisiert.");
    res.redirect(returnTo);
  });

  router.get("/animals/:animalId/notes/:entryId/update", requireAnimalPermission("canManageNotes"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/notes/${req.params.entryId}/edit`
    );
  });

  router.post("/animals/:animalId/notes/:entryId/delete", requireAnimalPermission("canManageNotes"), (req, res) => {
    db.prepare("DELETE FROM animal_notes WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    createAuditLog(req, "animal.note_delete", {
      animal_id: req.params.animalId,
      note_id: req.params.entryId,
    }, { entityType: "animal", entityId: req.params.animalId });
    setFlash(req, "success", "Protokolleintrag gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAnimalEntriesRouter };
