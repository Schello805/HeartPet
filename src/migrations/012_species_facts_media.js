module.exports = {
  id: "012_species_facts_media",
  description: "Ergaenzt Bild- und PDF-Medien fuer Tierarten",
  up(db) {
    db.exec(`
      ALTER TABLE species ADD COLUMN facts_media_stored_name TEXT;
      ALTER TABLE species ADD COLUMN facts_media_original_name TEXT;
      ALTER TABLE species ADD COLUMN facts_media_mime_type TEXT;
    `);
  },
};