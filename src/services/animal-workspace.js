const dayjs = require("dayjs");

const MICROCHIP_REGISTRIES = new Set(["TASSO", "FINDEFIX", "TASSO und FINDEFIX", "Anderes Register", "Nicht registriert"]);

function createAnimalWorkspaceService({
  db,
  animalRepository,
  buildAnimalTimeline,
  formatDate,
  formatDateTime,
  getAnimalActivityEntries,
  getAnimalLifecycle,
  summarizeReminderState,
  getDisposalGuidance,
  getSettings,
}) {
  function normalizeMicrochipRegistry(value) {
    const registry = String(value || "").trim();
    return MICROCHIP_REGISTRIES.has(registry) ? registry : "";
  }

  function buildMicrochipLinks(animal) {
    if (!String(animal?.microchip_number || "").trim()) return { checks: [], nextSteps: [] };

    const checks = [
      { label: "Bei TASSO prüfen", url: "https://www.tasso.net/Tierregister/Transponderabfrage" },
      { label: "Bei FINDEFIX prüfen", url: "https://www.findefix.com/haustier-vermisst-gefunden/mikrochip-nummer-pruefen/" },
    ];
    const tassoMissing = { label: "Bei TASSO vermisst melden", url: "https://www.tasso.net/Tierregister/Tier-vermisst/Tier-vermisst-melden?fa=1", urgent: true };
    const findefixMissing = { label: "Bei FINDEFIX vermisst melden", url: "https://www.findefix.com/haustier-vermisst-gefunden/haustier-vermisst-melden-suchplakat/", urgent: true };
    const registry = normalizeMicrochipRegistry(animal.microchip_registry);

    if (registry === "Nicht registriert") {
      return {
        checks,
        nextSteps: [
          { label: "Bei TASSO registrieren", url: "https://www.tasso.net/Tierregister/Tier-registrieren" },
          { label: "Bei FINDEFIX registrieren", url: "https://www.findefix.com/haustier-online-registrieren/" },
        ],
      };
    }

    const nextSteps = [];
    if (["TASSO", "TASSO und FINDEFIX"].includes(registry)) nextSteps.push(tassoMissing);
    if (["FINDEFIX", "TASSO und FINDEFIX"].includes(registry)) nextSteps.push(findefixMissing);
    return { checks, nextSteps };
  }

  function getMissingRequiredCategories(categories, documents) {
    const presentCategoryIds = new Set(documents.map((item) => Number(item.category_id)).filter(Boolean));
    return categories.filter((category) => category.is_required && !presentCategoryIds.has(Number(category.id)));
  }

  function buildAnimalDocumentHealthMap(animalIds) {
    const normalizedIds = (animalIds || []).map(Number).filter(Boolean);
    if (!normalizedIds.length) return new Map();

    const requiredCategories = db.prepare("SELECT id, name FROM document_categories WHERE is_required = 1 ORDER BY name ASC").all();
    const emptyHealth = () => ({ missingRequiredCategories: [], missingRequiredDocumentCount: 0 });
    const map = new Map(normalizedIds.map((id) => [id, emptyHealth()]));
    if (!requiredCategories.length) return map;

    const placeholders = normalizedIds.map(() => "?").join(", ");
    const documents = db.prepare(`
      SELECT animal_id, category_id FROM documents WHERE animal_id IN (${placeholders})
    `).all(...normalizedIds);
    const presentByAnimal = new Map(normalizedIds.map((id) => [id, new Set()]));
    documents.forEach((item) => {
      const animalId = Number(item.animal_id);
      if (presentByAnimal.has(animalId) && item.category_id) presentByAnimal.get(animalId).add(Number(item.category_id));
    });
    normalizedIds.forEach((animalId) => {
      const present = presentByAnimal.get(animalId);
      const missing = requiredCategories.filter((category) => !present.has(Number(category.id)));
      map.set(animalId, {
        missingRequiredCategories: missing.map((item) => item.name),
        missingRequiredDocumentCount: missing.length,
      });
    });
    return map;
  }

  function filterDocuments(documents, filters) {
    return documents.filter((item) => {
      if (filters.categoryId && String(item.category_id || "") !== String(filters.categoryId)) return false;
      const isImage = String(item.mime_type || "").startsWith("image/");
      if (filters.fileType === "images" && !isImage) return false;
      if (filters.fileType === "files" && isImage) return false;
      return true;
    });
  }

  function splitReminders(reminders) {
    const now = dayjs();
    return reminders.reduce((groups, reminder) => {
      const dueAt = String(reminder.due_at || "").replace(" ", "T");
      if (reminder.completed_at) groups.done.push(reminder);
      else if (dueAt && dayjs(dueAt).isBefore(now)) groups.overdue.push(reminder);
      else groups.open.push(reminder);
      return groups;
    }, { overdue: [], open: [], done: [] });
  }

  function buildReminderSourceMap(reminders) {
    return (reminders || []).reduce((groups, item) => {
      const key = item.source_kind && item.source_id ? `${item.source_kind}:${item.source_id}` : "manual";
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
      return groups;
    }, {});
  }

  function listActiveSpecies() {
    return db.prepare(`
      SELECT species.id, species.name, COUNT(animals.id) AS animal_count
      FROM species INNER JOIN animals ON animals.species_id = species.id
      WHERE animals.status = 'Aktiv'
      GROUP BY species.id, species.name ORDER BY species.name COLLATE NOCASE ASC
    `).all();
  }

  function getAnimalSectionConfig(section) {
    const sections = {
      active: {
        key: "active", basePath: "/animals", pageTitle: "Meine Tiere", workspaceTitle: "Meine Tiere",
        workspaceIntro: "Hier findest du alle Tiere aus deinem aktuellen Bestand.", totalLabel: "Tiere",
        allowedStatuses: ["Aktiv"], defaultStatus: "Aktiv", allowStatusFilter: false,
      },
      history: {
        key: "history", basePath: "/animals/historie", pageTitle: "Historie", workspaceTitle: "Historie",
        workspaceIntro: "Hier findest du vermittelte, verkaufte und verstorbene Tiere als Bestandsverlauf.",
        totalLabel: "historische Tiere", allowedStatuses: ["Vermittelt", "Verkauft", "Verstorben"],
        defaultStatus: "", allowStatusFilter: true,
      },
    };
    return sections[section] || sections.active;
  }

  function buildNextTermLookup(animalIds) {
    const now = dayjs();
    const today = now.format("YYYY-MM-DD");
    const placeholders = animalIds.map(() => "?").join(", ");
    const eventsByAnimal = new Map(animalIds.map((id) => [Number(id), []]));
    const pushEvent = (animalId, event) => eventsByAnimal.get(Number(animalId))?.push(event);

    db.prepare(`SELECT animal_id, title, appointment_at FROM animal_appointments WHERE animal_id IN (${placeholders}) AND appointment_at >= ?`)
      .all(...animalIds, now.format("YYYY-MM-DDTHH:mm"))
      .forEach((item) => pushEvent(item.animal_id, { type: "Arzttermin", label: item.title || "Arzttermin", at: item.appointment_at, sortAt: item.appointment_at }));
    db.prepare(`SELECT animal_id, name, next_due_date FROM animal_vaccinations WHERE animal_id IN (${placeholders}) AND next_due_date IS NOT NULL AND next_due_date >= ?`)
      .all(...animalIds, today)
      .forEach((item) => pushEvent(item.animal_id, { type: "Impfung", label: item.name || "Impfung", at: item.next_due_date, sortAt: `${item.next_due_date}T09:00` }));
    db.prepare(`SELECT animal_id, name, start_date, end_date FROM animal_medications WHERE animal_id IN (${placeholders})`)
      .all(...animalIds)
      .forEach((item) => {
        const candidates = [item.start_date, item.end_date].filter((value) => value && value >= today).sort();
        if (candidates.length) pushEvent(item.animal_id, { type: "Medikament", label: item.name || "Medikament", at: candidates[0], sortAt: `${candidates[0]}T08:00` });
      });
    db.prepare(`SELECT animal_id, label, time_of_day FROM animal_feedings WHERE animal_id IN (${placeholders}) AND time_of_day IS NOT NULL AND time_of_day != ''`)
      .all(...animalIds)
      .forEach((item) => {
        const candidate = dayjs(`${today}T${item.time_of_day}`);
        const next = candidate.isAfter(now) ? candidate : candidate.add(1, "day");
        const at = next.format("YYYY-MM-DDTHH:mm");
        pushEvent(item.animal_id, { type: "Fütterung", label: item.label || "Fütterung", at, sortAt: at });
      });
    db.prepare(`SELECT animal_id, title, due_at, reminder_type FROM reminders WHERE animal_id IN (${placeholders}) AND completed_at IS NULL AND due_at >= ? AND source_kind IS NULL`)
      .all(...animalIds, now.format("YYYY-MM-DDTHH:mm"))
      .forEach((item) => pushEvent(item.animal_id, { type: item.reminder_type || "Erinnerung", label: item.title || "Erinnerung", at: item.due_at, sortAt: item.due_at }));

    const nextByAnimal = new Map();
    eventsByAnimal.forEach((events, animalId) => {
      const nextEvent = events.sort((left, right) => String(left.sortAt).localeCompare(String(right.sortAt)))[0];
      if (nextEvent) {
        const displayLabel = String(nextEvent.at).includes("T") ? formatDateTime(nextEvent.at) : formatDate(nextEvent.at);
        nextByAnimal.set(animalId, { ...nextEvent, displayLabel });
      }
    });
    return nextByAnimal;
  }

  function buildStatusSummary(animal) {
    const labels = {
      Vermittelt: ["Vermittelt an", "Vermittelt am"],
      Verkauft: ["Verkauft an", "Verkauft am"],
      Verstorben: ["Ort / Zusammenhang", "Abschied am"],
    };
    const [nameLabel, dateLabel] = labels[animal.status] || [];
    const parts = [];
    if (nameLabel && animal.status_context_name) parts.push(`${nameLabel}: ${animal.status_context_name}`);
    if (dateLabel && animal.status_context_date) parts.push(`${dateLabel}: ${formatDate(animal.status_context_date)}`);
    if (animal.memorial_note) parts.push(animal.memorial_note);
    return parts.join(" | ");
  }

  function enrichAnimals(animals) {
    if (!animals.length) return [];
    const animalIds = animals.map((animal) => Number(animal.id)).filter(Boolean);
    const nextTerms = buildNextTermLookup(animalIds);
    const documentHealth = buildAnimalDocumentHealthMap(animalIds);
    const placeholders = animalIds.map(() => "?").join(", ");
    const reminderRows = db.prepare(`
      SELECT animal_id,
        SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN completed_at IS NULL AND REPLACE(due_at, ' ', 'T') < ? THEN 1 ELSE 0 END) AS overdue_count
      FROM reminders WHERE animal_id IN (${placeholders}) GROUP BY animal_id
    `).all(dayjs().format("YYYY-MM-DDTHH:mm"), ...animalIds);
    const reminderMap = new Map(reminderRows.map((row) => [Number(row.animal_id), row]));

    return animals.map((animal) => {
      const reminder = reminderMap.get(Number(animal.id));
      const documents = documentHealth.get(Number(animal.id)) || { missingRequiredCategories: [], missingRequiredDocumentCount: 0 };
      return {
        ...animal,
        next_term: nextTerms.get(Number(animal.id)) || null,
        lifecycle: getAnimalLifecycle(animal.status),
        openReminderCount: Number(reminder?.open_count || 0),
        overdueReminderCount: Number(reminder?.overdue_count || 0),
        ...documents,
        isProfileIncomplete: !animal.birth_date || !animal.intake_date,
        statusSummary: buildStatusSummary(animal),
      };
    });
  }

  function buildDashboardAttentionReasons(animal, { includeReminders = true } = {}) {
    const reasons = [];
    if (includeReminders && animal.overdueReminderCount > 0) reasons.push(`${animal.overdueReminderCount} überfällig`);
    const openOnly = Math.max(animal.openReminderCount - animal.overdueReminderCount, 0);
    if (includeReminders && openOnly > 0) reasons.push(`${openOnly} offen`);
    if (!animal.veterinarian_name) reasons.push("Tierarzt fehlt");
    if (!animal.birth_date) reasons.push("Geburtsdatum fehlt");
    if (!animal.intake_date) reasons.push("Aufnahmedatum fehlt");
    return reasons;
  }

  function sortAnimals(animals, sort) {
    const collator = new Intl.Collator("de", { sensitivity: "base" });
    const compareDates = (left, right, nullsLast = false) => {
      if (!left && !right) return 0;
      if (!left) return nullsLast ? 1 : -1;
      if (!right) return nullsLast ? -1 : 1;
      return String(left).localeCompare(String(right));
    };
    return [...animals].sort((left, right) => {
      if (sort === "name_desc") return collator.compare(right.name || "", left.name || "");
      if (sort === "intake_desc") return compareDates(right.intake_date, left.intake_date) || collator.compare(left.name || "", right.name || "");
      if (sort === "intake_asc") return compareDates(left.intake_date, right.intake_date) || collator.compare(left.name || "", right.name || "");
      if (sort === "created_desc") return compareDates(right.created_at, left.created_at) || collator.compare(left.name || "", right.name || "");
      if (sort === "status_asc") return collator.compare(left.status || "", right.status || "") || collator.compare(left.name || "", right.name || "");
      if (sort === "next_term_asc") return compareDates(left.next_term?.sortAt, right.next_term?.sortAt, true) || collator.compare(left.name || "", right.name || "");
      return collator.compare(left.name || "", right.name || "");
    });
  }

  function buildDetailView(animalId, req) {
    const animal = animalRepository.findById(animalId);
    if (!animal) return null;
    const related = animalRepository.getRelated(animalId);
    const categories = db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all();
    const missingRequiredCategories = getMissingRequiredCategories(categories, related.documents);
    const documentFilter = { categoryId: req.query.documentCategory || "", fileType: req.query.documentType || "" };
    return {
      animal,
      microchipLinks: buildMicrochipLinks(animal),
      related: { ...related, documents: filterDocuments(related.documents, documentFilter) },
      reminderBuckets: splitReminders(related.reminders),
      sourceReminderMap: buildReminderSourceMap(related.reminders),
      manualReminders: (related.reminders || []).filter((item) => !item.source_kind),
      reminderStats: summarizeReminderState(related.reminders || []),
      editState: { type: req.query.editType || "", id: req.query.editId ? Number(req.query.editId) : null },
      categories,
      documentFilter,
      missingRequiredCategories,
      workflowSummary: {
        missingRequiredCategories,
        isProfileIncomplete: !animal.birth_date || !animal.intake_date,
        hasVeterinarian: Boolean(animal.veterinarian_name || animal.species_veterinarian_name),
      },
      timeline: buildAnimalTimeline(related),
      activityLog: getAnimalActivityEntries(animalId),
      species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
      veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    };
  }

  function buildWorkspace(req, section = "active") {
    const sectionConfig = getAnimalSectionConfig(section);
    const settings = section === "history" ? getSettings() : {};
    const federalState = String(settings.federal_state || "").trim();
    const search = String(req.query.q || "").trim();
    const requestedStatus = String(req.query.status || "").trim();
    const speciesId = String(req.query.species_id || "").trim();
    const sort = String(req.query.sort || "name_asc").trim();
    const selectedAnimalId = String(req.query.animal_id || "").trim();
    const page = Math.max(Number.parseInt(req.query.page || "1", 10) || 1, 1);
    const pageSize = 25;
    const allowedStatuses = sectionConfig.allowedStatuses;
    const status = sectionConfig.allowStatusFilter && allowedStatuses.includes(requestedStatus) ? requestedStatus : sectionConfig.defaultStatus;
    let sql = `
      SELECT animals.*, species.name AS species_name,
        COALESCE(veterinarians.name, species_vet.name) AS veterinarian_name
      FROM animals
      LEFT JOIN species ON species.id = animals.species_id
      LEFT JOIN veterinarians ON veterinarians.id = animals.veterinarian_id
      LEFT JOIN veterinarians AS species_vet ON species_vet.id = species.default_veterinarian_id
      WHERE 1 = 1
    `;
    const params = [];
    if (search) {
      sql += " AND (animals.name LIKE ? OR animals.source LIKE ? OR animals.breed LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      sql += " AND animals.status = ?";
      params.push(status);
    } else if (allowedStatuses.length) {
      sql += ` AND animals.status IN (${allowedStatuses.map(() => "?").join(", ")})`;
      params.push(...allowedStatuses);
    }
    if (speciesId) {
      sql += " AND animals.species_id = ?";
      params.push(speciesId);
    }
    const sortedAnimals = sortAnimals(enrichAnimals(db.prepare(sql).all(...params)), sort);
    const totalCount = sortedAnimals.length;
    const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);
    const currentPage = Math.min(page, totalPages);
    const animals = sortedAnimals.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    const selectedAnimal = selectedAnimalId ? sortedAnimals.find((item) => String(item.id) === selectedAnimalId) || null : null;
    return {
      pageTitle: sectionConfig.pageTitle,
      animals,
      selectedAnimal,
      selectedAnimalView: selectedAnimal ? buildDetailView(selectedAnimal.id, req) : null,
      filters: { search, status, speciesId, sort },
      animalSection: sectionConfig,
      speciesOptions: listActiveSpecies(),
      pagination: { currentPage, totalPages, totalCount, pageSize },
      disposalGuidance: section === "history" ? getDisposalGuidance(federalState) : null,
      disposalFacilities: section === "history"
        ? db.prepare(`
            SELECT * FROM disposal_facilities
            WHERE federal_state = ? OR ? = ''
            ORDER BY name COLLATE NOCASE ASC
          `).all(federalState, federalState)
        : [],
    };
  }

  function buildWorkspaceAnimal(animalView) {
    return enrichAnimals([animalView.animal])[0] || animalView.animal;
  }

  return {
    buildDashboardAttentionReasons,
    buildDetailView,
    buildWorkspace,
    buildWorkspaceAnimal,
    enrichAnimals,
    listActiveSpecies,
  };
}

module.exports = { createAnimalWorkspaceService };
