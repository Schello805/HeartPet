const express = require("express");
const dayjs = require("dayjs");

function createAnimalHealthRouter({
  db, upload, requireAnimalPermission, getVaccinationSuggestionGroups, getAnimalReturnTo,
  safeLocalReturnPath, getVaccinationCertificateError, discardUploadedFile, setFlash,
  syncMedicationReminders, syncVaccinationReminders, syncAppointmentReminders,
  createAuditLog, redirectDocumentDrawerRequest, renderNotFound,
  deleteGeneratedReminders, deleteUploadedFileIfUnreferenced,
}) {
  const router = express.Router();

  router.get("/animals/vaccinations/bulk/new", requireAnimalPermission("canManageHealth"), (req, res) => {
    const speciesId = String(req.query.species_id || "").trim();
    let sql = `
      SELECT animals.id, animals.name, species.name AS species_name
      FROM animals
      LEFT JOIN species ON species.id = animals.species_id
      WHERE animals.status = 'Aktiv'
    `;
    const params = [];
    if (speciesId) {
      sql += " AND animals.species_id = ?";
      params.push(speciesId);
    }
    sql += " ORDER BY species.name ASC, animals.name ASC";
    const animals = db.prepare(sql).all(...params);
  
    res.render("pages/bulk-vaccination-drawer", {
      pageTitle: "Gruppenimpfung",
      animals,
      vaccinationSuggestionGroups: getVaccinationSuggestionGroups(animals.map((animal) => animal.species_name)),
      returnTo: getAnimalReturnTo(req, speciesId ? `/animals?species_id=${encodeURIComponent(speciesId)}` : "/animals"),
      today: dayjs().format("YYYY-MM-DD"),
    });
  });
  
  router.post("/animals/vaccinations/bulk", requireAnimalPermission("canManageHealth"), upload.single("vaccination_certificate"), (req, res) => {
    const animalIds = [...new Set([].concat(req.body.animal_ids || []).map((id) => Number(id)).filter(Number.isInteger))];
    const name = String(req.body.name || "").trim();
    const vaccinationDate = String(req.body.vaccination_date || "").trim();
    const nextDueDate = String(req.body.next_due_date || "").trim() || null;
    const notes = String(req.body.notes || "").trim();
    const reminderEnabled = req.body.reminder_enabled ? 1 : 0;
    const returnTo = safeLocalReturnPath(req.body.return_to, "/animals");
    const certificateError = getVaccinationCertificateError(req.file);
    if (certificateError) {
      discardUploadedFile(req.file);
      setFlash(req, "error", certificateError);
      return res.redirect(returnTo);
    }
  
    if (!name || !vaccinationDate || animalIds.length === 0) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Bitte Impfstoff, Impfdatum und mindestens ein Tier auswählen.");
      return res.redirect(returnTo);
    }
    if (reminderEnabled && !nextDueDate) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Für eine Erinnerung ist die nächste Fälligkeit erforderlich.");
      return res.redirect(returnTo);
    }
  
    const placeholders = animalIds.map(() => "?").join(", ");
    const eligibleAnimals = db.prepare(`
      SELECT id, name FROM animals
      WHERE status = 'Aktiv' AND id IN (${placeholders})
    `).all(...animalIds);
    if (eligibleAnimals.length !== animalIds.length) {
      discardUploadedFile(req.file);
      setFlash(req, "error", "Mindestens ein ausgewähltes Tier ist nicht mehr aktiv.");
      return res.redirect(returnTo);
    }
  
    const createdVaccinations = db.transaction(() => eligibleAnimals.map((animal) => {
      const result = db.prepare(`
        INSERT INTO animal_vaccinations (
          animal_id, name, vaccination_date, next_due_date, reminder_enabled, notes,
          certificate_original_name, certificate_stored_name, certificate_mime_type, certificate_file_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        animal.id, name, vaccinationDate, nextDueDate, reminderEnabled, notes,
        req.file?.originalname || null, req.file?.filename || null, req.file?.mimetype || null, req.file?.size || null
      );
      return { animalId: animal.id, vaccinationId: Number(result.lastInsertRowid) };
    }))();
    createdVaccinations.forEach((item) => syncVaccinationReminders(item.animalId, item.vaccinationId));
  
    createAuditLog(req, "vaccination.bulk_create", {
      name,
      animal_ids: eligibleAnimals.map((animal) => animal.id),
      animal_names: eligibleAnimals.map((animal) => animal.name),
      vaccination_date: vaccinationDate,
    }, { entityType: "vaccination", entityId: createdVaccinations[0]?.vaccinationId || null });
    setFlash(req, "success", `Impfung wurde für ${eligibleAnimals.length} Tiere eingetragen.`);
    return res.redirect(returnTo);
  });
  
  router.post("/animals/:id/conditions", requireAnimalPermission("canManageHealth"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)")
      .run(req.params.id, req.body.title, req.body.details || "");
    setFlash(req, "success", "Vorerkrankung gespeichert.");
    res.redirect(returnTo);
  });
  
  router.post("/animals/:animalId/conditions/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    db.prepare(`
      UPDATE animal_conditions
      SET title = ?, details = ?
      WHERE id = ? AND animal_id = ?
    `).run(req.body.title, req.body.details || "", req.params.entryId, req.params.animalId);
    setFlash(req, "success", "Vorerkrankung aktualisiert.");
    res.redirect(returnTo);
  });
  
  router.get("/animals/:animalId/conditions/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/conditions/${req.params.entryId}/edit`
    );
  });
  
  router.post("/animals/:animalId/conditions/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
    db.prepare("DELETE FROM animal_conditions WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    setFlash(req, "success", "Vorerkrankung gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });
  
  router.post("/animals/:id/medications", requireAnimalPermission("canManageHealth"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    const result = db.prepare(`
      INSERT INTO animal_medications (animal_id, name, dosage, schedule, start_date, end_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.body.name,
      req.body.dosage || "",
      req.body.schedule || "",
      req.body.start_date || null,
      req.body.end_date || null,
      req.body.notes || ""
    );
    syncMedicationReminders(req.params.id, result.lastInsertRowid);
    setFlash(req, "success", "Medikation gespeichert.");
    res.redirect(returnTo);
  });
  
  router.post("/animals/:animalId/medications/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    db.prepare(`
      UPDATE animal_medications
      SET name = ?, dosage = ?, schedule = ?, start_date = ?, end_date = ?, notes = ?
      WHERE id = ? AND animal_id = ?
    `).run(
      req.body.name,
      req.body.dosage || "",
      req.body.schedule || "",
      req.body.start_date || null,
      req.body.end_date || null,
      req.body.notes || "",
      req.params.entryId,
      req.params.animalId
    );
    syncMedicationReminders(req.params.animalId, req.params.entryId);
    setFlash(req, "success", "Medikation aktualisiert.");
    res.redirect(returnTo);
  });
  
  router.get("/animals/:animalId/medications/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/medications/${req.params.entryId}/edit`
    );
  });
  
  router.post("/animals/:animalId/medications/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
    deleteGeneratedReminders("medication", req.params.entryId);
    db.prepare("DELETE FROM animal_medications WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    setFlash(req, "success", "Medikation gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });
  
  router.post("/animals/:id/vaccinations", requireAnimalPermission("canManageHealth"), upload.single("vaccination_certificate"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    const certificateError = getVaccinationCertificateError(req.file);
    if (certificateError) {
      discardUploadedFile(req.file);
      setFlash(req, "error", certificateError);
      return res.redirect(returnTo);
    }
    const result = db.prepare(`
      INSERT INTO animal_vaccinations (
        animal_id, name, vaccination_date, next_due_date, notes,
        certificate_original_name, certificate_stored_name, certificate_mime_type, certificate_file_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.body.name,
      req.body.vaccination_date || null,
      req.body.next_due_date || null,
      req.body.notes || "",
      req.file?.originalname || null,
      req.file?.filename || null,
      req.file?.mimetype || null,
      req.file?.size || null
    );
    syncVaccinationReminders(req.params.id, result.lastInsertRowid);
    setFlash(req, "success", "Impfung gespeichert.");
    res.redirect(returnTo);
  });
  
  router.post("/animals/:animalId/vaccinations/:entryId/update", requireAnimalPermission("canManageHealth"), upload.single("vaccination_certificate"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    const certificateError = getVaccinationCertificateError(req.file);
    if (certificateError) {
      discardUploadedFile(req.file);
      setFlash(req, "error", certificateError);
      return res.redirect(returnTo);
    }
    const existing = db.prepare("SELECT * FROM animal_vaccinations WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!existing) {
      discardUploadedFile(req.file);
      return renderNotFound(req, res, "Impfung nicht gefunden.");
    }
    const removeCertificate = Boolean(req.body.remove_vaccination_certificate);
    const certificate = req.file
      ? {
          originalName: req.file.originalname,
          storedName: req.file.filename,
          mimeType: req.file.mimetype,
          fileSize: req.file.size,
        }
      : removeCertificate
        ? { originalName: null, storedName: null, mimeType: null, fileSize: null }
        : {
            originalName: existing.certificate_original_name,
            storedName: existing.certificate_stored_name,
            mimeType: existing.certificate_mime_type,
            fileSize: existing.certificate_file_size,
          };
    db.prepare(`
      UPDATE animal_vaccinations
      SET name = ?, vaccination_date = ?, next_due_date = ?, notes = ?,
          certificate_original_name = ?, certificate_stored_name = ?, certificate_mime_type = ?, certificate_file_size = ?
      WHERE id = ? AND animal_id = ?
    `).run(
      req.body.name,
      req.body.vaccination_date || null,
      req.body.next_due_date || null,
      req.body.notes || "",
      certificate.originalName,
      certificate.storedName,
      certificate.mimeType,
      certificate.fileSize,
      req.params.entryId,
      req.params.animalId
    );
    if ((req.file || removeCertificate) && existing.certificate_stored_name) {
      deleteUploadedFileIfUnreferenced(existing.certificate_stored_name);
    }
    syncVaccinationReminders(req.params.animalId, req.params.entryId);
    setFlash(req, "success", "Impfung aktualisiert.");
    res.redirect(returnTo);
  });
  
  router.get("/animals/:animalId/vaccinations/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/vaccinations/${req.params.entryId}/edit`
    );
  });
  
  router.post("/animals/:animalId/vaccinations/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
    const vaccination = db.prepare("SELECT certificate_stored_name FROM animal_vaccinations WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    deleteGeneratedReminders("vaccination", req.params.entryId);
    db.prepare("DELETE FROM animal_vaccinations WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    deleteUploadedFileIfUnreferenced(vaccination?.certificate_stored_name);
    setFlash(req, "success", "Impfung gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });
  
  router.post("/animals/:id/appointments", requireAnimalPermission("canManageHealth"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    const result = db.prepare(`
      INSERT INTO animal_appointments (animal_id, title, appointment_at, location_mode, location_text, veterinarian_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.body.title,
      req.body.appointment_at,
      req.body.location_mode || "praxis",
      req.body.location_text || "",
      req.body.veterinarian_id || null,
      req.body.notes || ""
    );
    syncAppointmentReminders(req.params.id, result.lastInsertRowid);
    setFlash(req, "success", "Arzttermin gespeichert.");
    res.redirect(returnTo);
  });
  
  router.post("/animals/:animalId/appointments/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    db.prepare(`
      UPDATE animal_appointments
      SET title = ?, appointment_at = ?, location_mode = ?, location_text = ?, veterinarian_id = ?, notes = ?
      WHERE id = ? AND animal_id = ?
    `).run(
      req.body.title,
      req.body.appointment_at,
      req.body.location_mode || "praxis",
      req.body.location_text || "",
      req.body.veterinarian_id || null,
      req.body.notes || "",
      req.params.entryId,
      req.params.animalId
    );
    syncAppointmentReminders(req.params.animalId, req.params.entryId);
    setFlash(req, "success", "Arzttermin aktualisiert.");
    res.redirect(returnTo);
  });
  
  router.get("/animals/:animalId/appointments/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/appointments/${req.params.entryId}/edit`
    );
  });
  
  router.post("/animals/:animalId/appointments/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
    deleteGeneratedReminders("appointment", req.params.entryId);
    db.prepare("DELETE FROM animal_appointments WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    setFlash(req, "success", "Arzttermin gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAnimalHealthRouter };
