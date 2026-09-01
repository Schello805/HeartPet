function createAnimalRepository(db) {
  const statements = {
    find: db.prepare(`
      SELECT animals.*, species.name AS species_name,
        veterinarians.id AS veterinarian_id_resolved, veterinarians.name AS veterinarian_name,
        veterinarians.street AS veterinarian_street, veterinarians.postal_code AS veterinarian_postal_code,
        veterinarians.city AS veterinarian_city, veterinarians.country AS veterinarian_country,
        veterinarians.email AS veterinarian_email, veterinarians.phone AS veterinarian_phone,
        species_vet.id AS species_veterinarian_id, species_vet.name AS species_veterinarian_name,
        species_vet.street AS species_veterinarian_street, species_vet.postal_code AS species_veterinarian_postal_code,
        species_vet.city AS species_veterinarian_city, species_vet.country AS species_veterinarian_country,
        species_vet.email AS species_veterinarian_email, species_vet.phone AS species_veterinarian_phone
      FROM animals
      LEFT JOIN species ON species.id = animals.species_id
      LEFT JOIN veterinarians ON veterinarians.id = animals.veterinarian_id
      LEFT JOIN veterinarians AS species_vet ON species_vet.id = species.default_veterinarian_id
      WHERE animals.id = ?
    `),
    conditions: db.prepare("SELECT * FROM animal_conditions WHERE animal_id = ? ORDER BY created_at DESC"),
    medications: db.prepare("SELECT * FROM animal_medications WHERE animal_id = ? ORDER BY created_at DESC"),
    vaccinations: db.prepare("SELECT * FROM animal_vaccinations WHERE animal_id = ? ORDER BY next_due_date ASC"),
    appointments: db.prepare(`
      SELECT animal_appointments.*, veterinarians.name AS veterinarian_name
      FROM animal_appointments
      LEFT JOIN veterinarians ON veterinarians.id = animal_appointments.veterinarian_id
      WHERE animal_appointments.animal_id = ?
      ORDER BY animal_appointments.appointment_at ASC
    `),
    feedings: db.prepare("SELECT * FROM animal_feedings WHERE animal_id = ? ORDER BY time_of_day ASC"),
    notes: db.prepare("SELECT * FROM animal_notes WHERE animal_id = ? ORDER BY created_at DESC"),
    reminders: db.prepare("SELECT * FROM reminders WHERE animal_id = ? ORDER BY due_at ASC"),
    images: db.prepare("SELECT * FROM animal_images WHERE animal_id = ? ORDER BY created_at DESC"),
    documents: db.prepare(`
      SELECT documents.*, document_categories.name AS category_name, document_categories.is_required AS category_is_required
      FROM documents
      LEFT JOIN document_categories ON document_categories.id = documents.category_id
      WHERE documents.animal_id = ?
      ORDER BY documents.uploaded_at DESC
    `),
  };

  return {
    findById(id) {
      return statements.find.get(id);
    },
    getRelated(animalId) {
      return {
        conditions: statements.conditions.all(animalId),
        medications: statements.medications.all(animalId),
        vaccinations: statements.vaccinations.all(animalId),
        appointments: statements.appointments.all(animalId),
        feedings: statements.feedings.all(animalId),
        notes: statements.notes.all(animalId),
        reminders: statements.reminders.all(animalId),
        images: statements.images.all(animalId),
        documents: statements.documents.all(animalId),
      };
    },
  };
}

module.exports = { createAnimalRepository };
