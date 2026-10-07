module.exports = {
  id: "014_species_breeds",
  description: "Speichert importierte Rassen je Tierart",
  up(db) {
    db.exec("ALTER TABLE species ADD COLUMN daily_facts TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE TABLE IF NOT EXISTS species_breeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        species_id INTEGER NOT NULL REFERENCES species(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        image_credit TEXT NOT NULL DEFAULT '',
        image_source_url TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        UNIQUE(species_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_species_breeds_species ON species_breeds(species_id, name);
    `);
  },
};
