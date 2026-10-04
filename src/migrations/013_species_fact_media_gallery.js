module.exports = {
  id: "013_species_fact_media_gallery",
  description: "Erweitert Tierart-Faktenmedien auf bis zu drei Dateien",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS species_fact_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        species_id INTEGER NOT NULL,
        stored_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(species_id) REFERENCES species(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_species_fact_media_species
        ON species_fact_media(species_id, sort_order, id);

      INSERT INTO species_fact_media (species_id, stored_name, original_name, mime_type)
      SELECT id, facts_media_stored_name, COALESCE(facts_media_original_name, 'Tierart-Fakten'),
        COALESCE(facts_media_mime_type, 'application/octet-stream')
      FROM species
      WHERE facts_media_stored_name IS NOT NULL AND TRIM(facts_media_stored_name) <> '';

      UPDATE species
      SET facts_media_stored_name = NULL, facts_media_original_name = NULL, facts_media_mime_type = NULL
      WHERE facts_media_stored_name IS NOT NULL;
    `);
  },
};