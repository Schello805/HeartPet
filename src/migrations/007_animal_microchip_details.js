module.exports = {
  id: "007_animal_microchip_details",
  description: "Ergänzt Hersteller und Haustierregister für Mikrochips",
  up(db) {
    const columns = new Set(db.prepare("PRAGMA table_info(animals)").all().map((column) => column.name));
    if (!columns.has("microchip_manufacturer")) db.exec("ALTER TABLE animals ADD COLUMN microchip_manufacturer TEXT");
    if (!columns.has("microchip_registry")) db.exec("ALTER TABLE animals ADD COLUMN microchip_registry TEXT");
  },
};
