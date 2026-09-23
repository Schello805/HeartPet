const dayjs = require("dayjs");

function createAnimalReminderService({ db, getSettingsObject, parsePositiveInteger }) {
  function parseReminderBaseDate(value, defaultTime = "09:00") {
    if (!value) return null;
    return String(value).includes("T") ? dayjs(value) : dayjs(`${value}T${defaultTime}`);
  }

  function getNotificationChannelDefaults() {
    const settings = getSettingsObject(db);
    return {
      channelEmail: settings.reminder_email_enabled === "true" ? 1 : 0,
      channelTelegram: settings.reminder_telegram_enabled === "true" ? 1 : 0,
    };
  }

  function buildGeneratedReminderRows({ animalId, sourceKind, sourceId, title, reminderType, baseDate, notes, leadDays, repeatCount }) {
    if (!baseDate || !baseDate.isValid()) return [];

    const channels = getNotificationChannelDefaults();
    const requestedCount = Math.max(parsePositiveInteger(repeatCount), 0);
    if (requestedCount === 0) return [];

    const lead = parsePositiveInteger(leadDays);
    const effectiveCount = lead === 0 ? 1 : Math.min(requestedCount, lead + 1);
    return Array.from({ length: effectiveCount }, (_, index) => ({
      animal_id: animalId,
      title,
      reminder_type: reminderType,
      due_at: baseDate.subtract(lead - index, "day").format("YYYY-MM-DDTHH:mm"),
      channel_email: channels.channelEmail,
      channel_telegram: channels.channelTelegram,
      repeat_interval_days: 0,
      notes: notes || "",
      source_kind: sourceKind,
      source_id: sourceId,
      source_index: index,
    }));
  }

  function replaceGeneratedReminders(sourceKind, sourceId, rows) {
    const transaction = db.transaction(() => {
      const existingRows = db.prepare(`
        SELECT * FROM reminders
        WHERE source_kind = ? AND source_id = ?
        ORDER BY source_index ASC, id ASC
      `).all(sourceKind, sourceId);
      const existingByIndex = new Map(existingRows.map((item) => [Number(item.source_index || 0), item]));
      const keepIds = new Set();
      const updateReminder = db.prepare(`
        UPDATE reminders
        SET animal_id = ?, title = ?, reminder_type = ?, due_at = ?, channel_email = ?, channel_telegram = ?,
            repeat_interval_days = ?, notes = ?, completed_at = ?, last_notified_at = ?, last_delivery_status = ?,
            last_delivery_error = ?, source_kind = ?, source_id = ?, source_index = ?
        WHERE id = ?
      `);
      const insertReminder = db.prepare(`
        INSERT INTO reminders (
          animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
          last_delivery_status, last_delivery_error, source_kind, source_id, source_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?)
      `);

      rows.forEach((row) => {
        const sourceIndex = Number(row.source_index || 0);
        const existing = existingByIndex.get(sourceIndex);
        const preserveState = existing
          && String(existing.due_at || "") === String(row.due_at || "")
          && String(existing.title || "") === String(row.title || "")
          && String(existing.reminder_type || "") === String(row.reminder_type || "");

        if (existing) {
          updateReminder.run(
            row.animal_id, row.title, row.reminder_type, row.due_at, row.channel_email,
            row.channel_telegram, row.repeat_interval_days, row.notes,
            preserveState ? existing.completed_at || null : null,
            preserveState ? existing.last_notified_at || null : null,
            preserveState ? (existing.last_delivery_status || "pending") : "pending",
            preserveState ? (existing.last_delivery_error || "") : "",
            row.source_kind, row.source_id, sourceIndex, existing.id
          );
          keepIds.add(existing.id);
          return;
        }

        const result = insertReminder.run(
          row.animal_id, row.title, row.reminder_type, row.due_at, row.channel_email,
          row.channel_telegram, row.repeat_interval_days, row.notes,
          row.source_kind, row.source_id, sourceIndex
        );
        keepIds.add(result.lastInsertRowid);
      });

      const staleIds = existingRows.map((item) => item.id).filter((id) => !keepIds.has(id));
      if (staleIds.length) {
        db.prepare(`DELETE FROM reminders WHERE id IN (${staleIds.map(() => "?").join(", ")})`).run(...staleIds);
      }
    });
    transaction();
  }

  function deleteGeneratedReminders(sourceKind, sourceId) {
    db.prepare("DELETE FROM reminders WHERE source_kind = ? AND source_id = ?").run(sourceKind, sourceId);
  }

  function resolveReminderChannels(mode) {
    switch (String(mode || "none")) {
      case "defaults": return getNotificationChannelDefaults();
      case "email": return { channelEmail: 1, channelTelegram: 0 };
      case "telegram": return { channelEmail: 0, channelTelegram: 1 };
      case "both": return { channelEmail: 1, channelTelegram: 1 };
      default: return { channelEmail: 0, channelTelegram: 0 };
    }
  }

  function appendVeterinarianNote(noteValue, handledByVeterinarian, veterinarianId) {
    const notes = String(noteValue || "").trim();
    if (!handledByVeterinarian) return notes;

    const veterinarian = veterinarianId
      ? db.prepare("SELECT name FROM veterinarians WHERE id = ?").get(veterinarianId)
      : null;
    const prefix = veterinarian?.name
      ? `Durchgeführt durch Tierarzt: ${veterinarian.name}`
      : "Durchgeführt durch Tierarzt";
    return notes ? `${prefix}\n${notes}` : prefix;
  }

  function createSupplementalEventReminders({ animalId, eventKind, title, notes, baseDate, channelMode, daysBefore, onEvent }) {
    if (!baseDate || !baseDate.isValid() || String(channelMode || "none") === "none" || baseDate.isBefore(dayjs())) return;

    const reminderType = {
      medication: "Medikament",
      vaccination: "Impfung",
      appointment: "Arzttermin",
    }[eventKind] || "Ereignis";
    const channels = resolveReminderChannels(channelMode);
    const days = parsePositiveInteger(daysBefore);
    const dueMoments = [];
    if (days > 0) dueMoments.push(baseDate.subtract(days, "day"));
    if (String(onEvent || "") === "1" || !dueMoments.length) dueMoments.push(baseDate);

    const seen = new Set();
    const insert = db.prepare(`
      INSERT INTO reminders (
        animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
        last_delivery_status, last_delivery_error
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', '')
    `);
    dueMoments.forEach((moment) => {
      const dueAt = moment.format("YYYY-MM-DDTHH:mm");
      if (seen.has(dueAt)) return;
      seen.add(dueAt);
      insert.run(animalId, `${reminderType}: ${title}`, reminderType, dueAt, channels.channelEmail, channels.channelTelegram, notes || "");
    });
  }

  function applyCompletionSideEffects(reminder, completionDate = dayjs().format("YYYY-MM-DD")) {
    if (!reminder || reminder.source_kind !== "vaccination" || !reminder.source_id) return;
    db.prepare(`
      UPDATE animal_vaccinations SET vaccination_date = ?
      WHERE id = ? AND vaccination_date IS NULL
    `).run(completionDate, reminder.source_id);
  }

  function syncMedicationReminders(animalId, medicationId) {
    const item = db.prepare("SELECT * FROM animal_medications WHERE id = ? AND animal_id = ?").get(medicationId, animalId);
    if (!item || !Number(item.reminder_enabled || 0)) {
      deleteGeneratedReminders("medication", medicationId);
      return;
    }
    const settings = getSettingsObject(db);
    replaceGeneratedReminders("medication", item.id, buildGeneratedReminderRows({
      animalId,
      sourceKind: "medication",
      sourceId: item.id,
      title: `Medikamentengabe: ${item.name}`,
      reminderType: "Medikament",
      baseDate: parseReminderBaseDate(item.start_date, "08:00"),
      notes: [item.dosage ? `Dosis: ${item.dosage}` : "", item.schedule ? `Plan: ${item.schedule}` : "", item.notes || ""].filter(Boolean).join(" | "),
      leadDays: settings.medication_reminder_lead_days,
      repeatCount: settings.medication_reminder_repeat_count,
    }));
  }

  function syncVaccinationReminders(animalId, vaccinationId) {
    const item = db.prepare("SELECT * FROM animal_vaccinations WHERE id = ? AND animal_id = ?").get(vaccinationId, animalId);
    if (!item || !Number(item.reminder_enabled || 0)) {
      deleteGeneratedReminders("vaccination", vaccinationId);
      return;
    }
    const settings = getSettingsObject(db);
    replaceGeneratedReminders("vaccination", item.id, buildGeneratedReminderRows({
      animalId,
      sourceKind: "vaccination",
      sourceId: item.id,
      title: `Impftermin: ${item.name}`,
      reminderType: "Impfung",
      baseDate: parseReminderBaseDate(item.next_due_date, "09:00"),
      notes: item.notes || "",
      leadDays: settings.vaccination_reminder_lead_days,
      repeatCount: settings.vaccination_reminder_repeat_count,
    }));
  }

  function syncAppointmentReminders(animalId, appointmentId) {
    const item = db.prepare(`
      SELECT animal_appointments.*, veterinarians.name AS veterinarian_name
      FROM animal_appointments
      LEFT JOIN veterinarians ON veterinarians.id = animal_appointments.veterinarian_id
      WHERE animal_appointments.id = ? AND animal_appointments.animal_id = ?
    `).get(appointmentId, animalId);
    if (!item || !Number(item.reminder_enabled || 0)) {
      deleteGeneratedReminders("appointment", appointmentId);
      return;
    }
    const settings = getSettingsObject(db);
    const locationLabel = item.location_mode === "vor_ort" ? "Tierarzt kommt vor Ort" : "Tier wird zur Praxis gebracht";
    replaceGeneratedReminders("appointment", item.id, buildGeneratedReminderRows({
      animalId,
      sourceKind: "appointment",
      sourceId: item.id,
      title: `Arzttermin: ${item.title}`,
      reminderType: "Arzttermin",
      baseDate: parseReminderBaseDate(item.appointment_at, "09:00"),
      notes: [locationLabel, item.location_text ? `Ort: ${item.location_text}` : "", item.veterinarian_name ? `Tierarzt: ${item.veterinarian_name}` : "", item.notes || ""].filter(Boolean).join(" | "),
      leadDays: settings.appointment_reminder_lead_days,
      repeatCount: settings.appointment_reminder_repeat_count,
    }));
  }

  function resyncAllGeneratedReminders() {
    db.prepare("SELECT id, animal_id FROM animal_medications").all().forEach((item) => syncMedicationReminders(item.animal_id, item.id));
    db.prepare("SELECT id, animal_id FROM animal_vaccinations").all().forEach((item) => syncVaccinationReminders(item.animal_id, item.id));
    db.prepare("SELECT id, animal_id FROM animal_appointments").all().forEach((item) => syncAppointmentReminders(item.animal_id, item.id));
  }

  return {
    appendVeterinarianNote,
    applyCompletionSideEffects,
    createSupplementalEventReminders,
    deleteGeneratedReminders,
    getNotificationChannelDefaults,
    resyncAllGeneratedReminders,
    syncAppointmentReminders,
    syncMedicationReminders,
    syncVaccinationReminders,
  };
}

module.exports = { createAnimalReminderService };
