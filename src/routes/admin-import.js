const express = require("express");

function createAdminImportRouter({
  closeOpenRemindersForAnimal,
  db,
  ensureSpeciesExists,
  importUpload,
  isActiveAnimalStatus,
  normalizeAnimalStatus,
  normalizeMicrochipRegistry,
  requireAdmin,
  resolveImportedCategoryId,
  restoreEmbeddedFile,
  setFlash,
  syncAppointmentReminders,
  syncMedicationReminders,
  syncVaccinationReminders,
}) {
  const router = express.Router();

  router.post("/admin/import", requireAdmin, importUpload.single("import_file"), (req, res) => {
    if (!req.file) {
      setFlash(req, "error", "Bitte eine HeartPet JSON-Datei auswählen.");
      return res.redirect("/admin/import");
    }

    try {
      const payload = JSON.parse(req.file.buffer.toString("utf8"));
      const animalData = payload.animal || {};
      const related = payload.related || {};
      const species = ensureSpeciesExists(animalData.species_name || "Unbekannt");

      const insertAnimal = db.prepare(`
        INSERT INTO animals (
          name, species_id, sex, birth_date, intake_date, source, microchip_number, microchip_manufacturer, microchip_registry, status,
          color, breed, weight_kg, veterinarian_id, notes,
          status_changed_at, status_context_name, status_context_date, memorial_note, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      const result = insertAnimal.run(
        animalData.name || "Importiertes Tier",
        species?.id || null,
        animalData.sex || "",
        animalData.birth_date || null,
        animalData.intake_date || null,
        animalData.source || "",
        animalData.microchip_number || "",
        animalData.microchip_manufacturer || "",
        normalizeMicrochipRegistry(animalData.microchip_registry),
        normalizeAnimalStatus(animalData.status),
        animalData.color || "",
        animalData.breed || "",
        animalData.weight_kg || null,
        null,
        animalData.notes || "",
        animalData.status_changed_at || null,
        animalData.status_context_name || "",
        animalData.status_context_date || "",
        animalData.memorial_note || ""
      );

      const animalId = result.lastInsertRowid;
      const tx = db.transaction(() => {
        const importedMedicationIds = [];
        const importedVaccinationIds = [];
        const importedAppointmentIds = [];
        (related.conditions || []).forEach((item) => {
          db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)")
            .run(animalId, item.title, item.details || "");
        });
        (related.medications || []).forEach((item) => {
          const inserted = db.prepare(`
            INSERT INTO animal_medications (animal_id, name, dosage, schedule, start_date, end_date, reminder_enabled, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            animalId,
            item.name,
            item.dosage || "",
            item.schedule || "",
            item.start_date || null,
            item.end_date || null,
            item.reminder_enabled ? 1 : 0,
            item.notes || ""
          );
          importedMedicationIds.push(inserted.lastInsertRowid);
        });
        (related.vaccinations || []).forEach((item) => {
          const inserted = db.prepare(`
            INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, reminder_enabled, notes)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            animalId,
            item.name,
            item.vaccination_date || null,
            item.next_due_date || null,
            item.reminder_enabled ? 1 : 0,
            item.notes || ""
          );
          importedVaccinationIds.push(inserted.lastInsertRowid);
        });
        (related.appointments || []).forEach((item) => {
          const inserted = db.prepare(`
            INSERT INTO animal_appointments (animal_id, title, appointment_at, location_mode, location_text, veterinarian_id, reminder_enabled, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            animalId,
            item.title,
            item.appointment_at,
            item.location_mode || "praxis",
            item.location_text || "",
            null,
            item.reminder_enabled ? 1 : 0,
            item.notes || ""
          );
          importedAppointmentIds.push(inserted.lastInsertRowid);
        });
        (related.feedings || []).forEach((item) => {
          db.prepare(`
            INSERT INTO animal_feedings (animal_id, label, time_of_day, food, amount, notes)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(animalId, item.label, item.time_of_day || "", item.food || "", item.amount || "", item.notes || "");
        });
        (related.notes || []).forEach((item) => {
          db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
            .run(animalId, item.title, item.content || "");
        });
        (related.documents || []).forEach((item) => {
          const storedFile = restoreEmbeddedFile(item.embedded_file);
          if (!storedFile) {
            return;
          }

          db.prepare(`
            INSERT INTO documents (animal_id, category_id, title, original_name, stored_name, mime_type, file_size)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            animalId,
            resolveImportedCategoryId(item.category_name || item.category_id),
            item.title || storedFile.original_name,
            storedFile.original_name,
            storedFile.stored_name,
            storedFile.mime_type || "",
            storedFile.file_size || 0
          );
        });
        (related.images || []).forEach((item) => {
          const storedFile = restoreEmbeddedFile(item.embedded_file);
          if (!storedFile) {
            return;
          }

          db.prepare(`
            INSERT INTO animal_images (animal_id, title, original_name, stored_name, mime_type, file_size)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            animalId,
            item.title || "",
            storedFile.original_name,
            storedFile.stored_name,
            storedFile.mime_type || "",
            storedFile.file_size || 0
          );
        });
        (related.reminders || []).filter((item) => !item.source_kind).forEach((item) => {
          db.prepare(`
            INSERT INTO reminders (
              animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
              completed_at, last_notified_at, last_delivery_status, last_delivery_error, source_kind, source_id, source_index
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            animalId,
            item.title,
            item.reminder_type || "Allgemein",
            item.due_at,
            item.channel_email || 0,
            item.channel_telegram || 0,
            item.repeat_interval_days || 0,
            item.notes || "",
            item.completed_at || null,
            item.last_notified_at || null,
            item.last_delivery_status || "pending",
            item.last_delivery_error || "",
            null,
            null,
            item.source_index || 0
          );
        });

        importedMedicationIds.forEach((id) => syncMedicationReminders(animalId, id));
        importedVaccinationIds.forEach((id) => syncVaccinationReminders(animalId, id));
        importedAppointmentIds.forEach((id) => syncAppointmentReminders(animalId, id));

        if (!isActiveAnimalStatus(animalData.status)) {
          closeOpenRemindersForAnimal(animalId);
        }
      });

      tx();
      setFlash(req, "success", "HeartPet Export erfolgreich importiert.");
    } catch (error) {
      setFlash(req, "error", `Import fehlgeschlagen: ${error.message}`);
    }

    res.redirect("/admin/import");
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAdminImportRouter };
