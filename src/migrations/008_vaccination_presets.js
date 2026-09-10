const defaults = {
  Hund: ["SHP/L (Staupe, Hepatitis, Parvovirose und Leptospirose)", "Tollwut"],
  Katze: ["RCP (Katzenschnupfen und Katzenseuche)", "Tollwut"],
  Huhn: ["Newcastle-Krankheit (ND)", "Infektiöse Bronchitis (IB)"],
  Kaninchen: ["Myxomatose", "RHDV1 und RHDV2"],
  Pferd: ["Tetanus", "Equine Influenza (EIV)"],
  Frettchen: ["Staupe", "Tollwut"],
};

module.exports = {
  id: "008_vaccination_presets",
  description: "Ergänzt verwaltbare Standardimpfungen je Tierart",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vaccination_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        species_name TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(species_name, name)
      )
    `);
    const insert = db.prepare("INSERT OR IGNORE INTO vaccination_presets (species_name, name) VALUES (?, ?)");
    Object.entries(defaults).forEach(([speciesName, names]) => {
      names.forEach((name) => insert.run(speciesName, name));
    });
  },
};
