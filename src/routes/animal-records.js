const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const dayjs = require("dayjs");

function createAnimalRecordsRouter({
  db,
  uploadsDir,
  requireAnimalEditor,
  findAnimal,
  renderNotFound,
  normalizeAnimalPayload,
  normalizeAnimalTransitionDetails,
  safeLocalReturnPath,
  getAnimalReturnTo,
  setFlash,
  requiresAnimalStatusTransitionConfirmation,
  isConfirmedAnimalStatusTransition,
  validateAnimalTransitionDetails,
  isActiveAnimalStatus,
  normalizeAnimalStatus,
  getAnimalLifecycle,
  buildAnimalTransitionSummary,
  closeOpenRemindersForAnimal,
  createAuditLog,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  microchipRegistryOptions,
  microchipManufacturerSuggestions,
  resolveStoredFilePath,
  duplicateAnimalRecord,
  deleteUploadedFileIfUnreferenced,
}) {
  const router = express.Router();

  router.get("/new", requireAnimalEditor, (req, res) => {
    res.render("pages/animal-form", {
      pageTitle: "Tier anlegen",
      animal: null,
      species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
      veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
      microchipRegistryOptions,
      microchipManufacturerSuggestions,
      returnTo: getAnimalReturnTo(req, "/animals"),
    });
  });

  router.post("/", requireAnimalEditor, (req, res) => {
    const payload = normalizeAnimalPayload(req.body);
    const transitionDetails = normalizeAnimalTransitionDetails(req.body, payload.status);
    const returnTo = safeLocalReturnPath(req.body.return_to, "/animals");
    if (!payload.name || !payload.species_id) {
      setFlash(req, "error", "Name und Tierart sind Pflichtfelder.");
      return res.redirect(`/animals/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    if (requiresAnimalStatusTransitionConfirmation("Aktiv", payload.status) && !isConfirmedAnimalStatusTransition(req.body)) {
      setFlash(req, "error", "Bitte bestätige den Wechsel aus dem aktiven Bestand.");
      return res.redirect(`/animals/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    const transitionError = validateAnimalTransitionDetails(payload.status, transitionDetails);
    if (transitionError) {
      setFlash(req, "error", transitionError);
      return res.redirect(`/animals/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    const insertPayload = {
      ...payload,
      status_changed_at: isActiveAnimalStatus(payload.status) ? null : dayjs().toISOString(),
      status_context_name: transitionDetails.status_context_name,
      status_context_date: transitionDetails.status_context_date,
      memorial_note: transitionDetails.memorial_note,
    };

    const result = db.prepare(`
      INSERT INTO animals (
        name, species_id, sex, birth_date, intake_date, source, microchip_number, microchip_manufacturer, microchip_registry,
        status, color, breed, weight_kg, veterinarian_id, notes,
        status_changed_at, status_context_name, status_context_date, memorial_note, updated_at
      )
      VALUES (
        @name, @species_id, @sex, @birth_date, @intake_date, @source, @microchip_number, @microchip_manufacturer, @microchip_registry,
        @status, @color, @breed, @weight_kg, @veterinarian_id, @notes,
        @status_changed_at, @status_context_name, @status_context_date, @memorial_note, CURRENT_TIMESTAMP
      )
    `).run(insertPayload);

    if (!isActiveAnimalStatus(payload.status)) closeOpenRemindersForAnimal(result.lastInsertRowid);

    createAuditLog(req, "animal.create", {
      animal_id: result.lastInsertRowid,
      name: payload.name,
      status: payload.status,
      transition_summary: buildAnimalTransitionSummary(payload.status, transitionDetails),
    }, { entityType: "animal", entityId: result.lastInsertRowid });

    setFlash(req, "success", "Tier wurde angelegt.");
    res.redirect(returnTo || `/animals/${result.lastInsertRowid}`);
  });

  router.get("/:id/edit", requireAnimalEditor, (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) return renderNotFound(req, res, "Tier nicht gefunden.");
    if (!isDrawerRequest(req)) {
      return redirectDocumentDrawerRequest(req, res, getAnimalReturnTo(req, `/animals/${req.params.id}`));
    }

    res.render("pages/animal-form", {
      pageTitle: `${animal.name} bearbeiten`,
      animal,
      species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
      veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
      microchipRegistryOptions,
      microchipManufacturerSuggestions,
      returnTo: getAnimalReturnTo(req, `/animals/${req.params.id}`),
    });
  });

  router.get("/:id/update", requireAnimalEditor, (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(req, res, getAnimalReturnTo(req, `/animals/${req.params.id}`), `/animals/${req.params.id}/edit`);
  });

  router.post("/:id/update", requireAnimalEditor, (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) return renderNotFound(req, res, "Tier nicht gefunden.");

    const payload = normalizeAnimalPayload(req.body);
    const transitionDetails = normalizeAnimalTransitionDetails(req.body, payload.status);
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    if (!payload.name || !payload.species_id) {
      setFlash(req, "error", "Name und Tierart sind Pflichtfelder.");
      return res.redirect(`/animals/${req.params.id}/edit?return_to=${encodeURIComponent(returnTo)}`);
    }

    if (requiresAnimalStatusTransitionConfirmation(animal.status, payload.status) && !isConfirmedAnimalStatusTransition(req.body)) {
      setFlash(req, "error", "Bitte bestätige den Wechsel aus dem aktiven Bestand.");
      return res.redirect(`/animals/${req.params.id}/edit?return_to=${encodeURIComponent(returnTo)}`);
    }

    const transitionError = validateAnimalTransitionDetails(payload.status, transitionDetails);
    if (transitionError) {
      setFlash(req, "error", transitionError);
      return res.redirect(`/animals/${req.params.id}/edit?return_to=${encodeURIComponent(returnTo)}`);
    }

    const statusChanged = normalizeAnimalStatus(animal.status) !== normalizeAnimalStatus(payload.status);
    const transitionDetailsChanged =
      String(animal.status_context_name || "") !== String(transitionDetails.status_context_name || "") ||
      String(animal.status_context_date || "") !== String(transitionDetails.status_context_date || "") ||
      String(animal.memorial_note || "") !== String(transitionDetails.memorial_note || "");

    Object.assign(payload, {
      id: req.params.id,
      status_changed_at: isActiveAnimalStatus(payload.status)
        ? null
        : (statusChanged ? dayjs().toISOString() : (animal.status_changed_at || null)),
      status_context_name: transitionDetails.status_context_name,
      status_context_date: transitionDetails.status_context_date,
      memorial_note: transitionDetails.memorial_note,
    });

    db.prepare(`
      UPDATE animals
      SET name = @name, species_id = @species_id, sex = @sex, birth_date = @birth_date,
          intake_date = @intake_date, source = @source, microchip_number = @microchip_number,
          microchip_manufacturer = @microchip_manufacturer, microchip_registry = @microchip_registry,
          status = @status, color = @color, breed = @breed, weight_kg = @weight_kg,
          veterinarian_id = @veterinarian_id, notes = @notes, status_changed_at = @status_changed_at,
          status_context_name = @status_context_name, status_context_date = @status_context_date,
          memorial_note = @memorial_note, updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run(payload);

    if (isActiveAnimalStatus(animal.status) && !isActiveAnimalStatus(payload.status)) {
      const lifecycle = getAnimalLifecycle(payload.status);
      const shouldClose = lifecycle.inRestingPlace || String(req.body.close_open_reminders || "").trim().toLowerCase() === "true";
      if (shouldClose) closeOpenRemindersForAnimal(req.params.id);
    }

    const lifecycle = getAnimalLifecycle(payload.status);
    const movedToHistory = requiresAnimalStatusTransitionConfirmation(animal.status, payload.status);
    if (statusChanged) {
      createAuditLog(req, "animal.status_change", {
        animal_id: req.params.id,
        name: payload.name,
        previous_status: animal.status,
        next_status: payload.status,
        transition_summary: buildAnimalTransitionSummary(payload.status, transitionDetails),
      }, { entityType: "animal", entityId: req.params.id });
    } else {
      createAuditLog(req, "animal.update", {
        animal_id: req.params.id,
        name: payload.name,
        status: payload.status,
        transition_details_updated: transitionDetailsChanged,
      }, { entityType: "animal", entityId: req.params.id });
    }

    setFlash(req, "success", movedToHistory ? "Tier wurde in die Historie verschoben." : "Tierdaten wurden aktualisiert.");
    const destination = statusChanged && !lifecycle.isActive && !returnTo.startsWith("/animals/historie")
      ? `/animals/historie?animal_id=${encodeURIComponent(req.params.id)}`
      : returnTo;
    res.redirect(destination);
  });

  router.post("/:id/memorial-note", requireAnimalEditor, (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) return renderNotFound(req, res, "Tier nicht gefunden.");
    if (!getAnimalLifecycle(animal.status).inRestingPlace) {
      setFlash(req, "error", "Eine Gedenkerinnerung ist nur bei verstorbenen Tieren verfügbar.");
      return res.redirect(safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`));
    }

    const submittedNote = String(req.body.memorial_note || "").trim();
    const memorialNote = /^(?:["'”“„‘’]){1,2}$/.test(submittedNote) ? "" : submittedNote.slice(0, 2000);
    db.prepare("UPDATE animals SET memorial_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(memorialNote, req.params.id);
    createAuditLog(req, "animal.update", {
      animal_id: req.params.id,
      name: animal.name,
      status: animal.status,
      transition_details_updated: true,
    }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", memorialNote ? "Erinnerung wurde aktualisiert." : "Erinnerung wurde entfernt.");
    res.redirect(safeLocalReturnPath(req.body.return_to, `/animals/historie?animal_id=${encodeURIComponent(req.params.id)}`));
  });

  router.post("/:id/duplicate", requireAnimalEditor, (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) return renderNotFound(req, res, "Tier nicht gefunden.");
    const createdFiles = [];

    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
      const storedFileNames = [
        animal.profile_image_stored_name,
        ...db.prepare("SELECT stored_name FROM documents WHERE animal_id = ?").all(animal.id).map((item) => item.stored_name),
        ...db.prepare("SELECT stored_name FROM animal_images WHERE animal_id = ?").all(animal.id).map((item) => item.stored_name),
        ...db.prepare("SELECT certificate_stored_name FROM animal_vaccinations WHERE animal_id = ?").all(animal.id).map((item) => item.certificate_stored_name),
      ].filter(Boolean);
      const fileCopies = new Map();

      for (const storedName of new Set(storedFileNames)) {
        const sourcePath = resolveStoredFilePath(uploadsDir, storedName);
        if (!sourcePath) throw new Error("Ungültiger gespeicherter Dateiname.");
        if (!fs.existsSync(sourcePath)) throw new Error(`Datei ${storedName} fehlt.`);
        const copiedName = `${Date.now()}-${crypto.randomUUID()}${path.extname(storedName)}`;
        fs.copyFileSync(sourcePath, resolveStoredFilePath(uploadsDir, copiedName));
        createdFiles.push(copiedName);
        fileCopies.set(storedName, copiedName);
      }

      const newAnimalId = db.transaction(() => duplicateAnimalRecord(animal, fileCopies))();
      createAuditLog(req, "animal.duplicate", {
        animal_id: newAnimalId,
        source_animal_id: animal.id,
        name: `${animal.name} (Kopie)`,
      }, { entityType: "animal", entityId: newAnimalId });
      setFlash(req, "success", "Tier und alle zugehörigen Daten wurden kopiert.");
      return res.redirect(`/animals?animal_id=${newAnimalId}`);
    } catch (error) {
      createdFiles.forEach((storedName) => {
        const filePath = resolveStoredFilePath(uploadsDir, storedName);
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
      console.error("[HeartPet] Tier konnte nicht kopiert werden:", error.message);
      setFlash(req, "error", "Tier konnte nicht vollständig kopiert werden.");
      return res.redirect(`/animals?animal_id=${animal.id}`);
    }
  });

  router.post("/:id/delete", requireAnimalEditor, (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) return renderNotFound(req, res, "Tier nicht gefunden.");
    const returnTo = safeLocalReturnPath(req.body.return_to, "/animals");

    db.transaction(() => {
      const profileImage = db.prepare("SELECT profile_image_stored_name FROM animals WHERE id = ?").get(req.params.id);
      const storedNames = [
        profileImage?.profile_image_stored_name,
        ...db.prepare("SELECT stored_name FROM documents WHERE animal_id = ?").all(req.params.id).map((row) => row.stored_name),
        ...db.prepare("SELECT stored_name FROM animal_images WHERE animal_id = ?").all(req.params.id).map((row) => row.stored_name),
        ...db.prepare("SELECT certificate_stored_name FROM animal_vaccinations WHERE animal_id = ?").all(req.params.id).map((row) => row.certificate_stored_name),
      ].filter(Boolean);

      db.prepare("DELETE FROM reminders WHERE animal_id = ?").run(req.params.id);
      db.prepare("DELETE FROM animals WHERE id = ?").run(req.params.id);
      [...new Set(storedNames)].forEach(deleteUploadedFileIfUnreferenced);
    })();

    createAuditLog(req, "animal.delete", { animal_id: req.params.id, name: animal.name }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", "Tier wurde endgültig gelöscht.");
    res.redirect(returnTo);
  });

  router.heartpetMountPath = "/animals";
  return router;
}

module.exports = { createAnimalRecordsRouter };
