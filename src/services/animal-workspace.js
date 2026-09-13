function createAnimalWorkspaceService({
  db, animalRepository, attachAnimalWorkspaceMeta, attachNextTermData, buildAnimalTimeline,
  buildMicrochipLinks, buildReminderSourceMap, filterDocuments, getAnimalActivityEntries,
  getAnimalSectionConfig, getMissingRequiredCategories, isAnimalProfileIncomplete,
  listActiveSpecies, sortAnimals, splitReminders, summarizeReminderState,
}) {
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
        isProfileIncomplete: isAnimalProfileIncomplete(animal),
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
    const enriched = attachAnimalWorkspaceMeta(attachNextTermData(db.prepare(sql).all(...params)));
    const sortedAnimals = sortAnimals(enriched, sort);
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
    };
  }

  function buildWorkspaceAnimal(animalView) {
    return attachAnimalWorkspaceMeta(attachNextTermData([animalView.animal]))[0] || animalView.animal;
  }
  return { buildDetailView, buildWorkspace, buildWorkspaceAnimal };
}

module.exports = { createAnimalWorkspaceService };
