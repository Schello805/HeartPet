const vaccinationPresetsMigration = require("./008_vaccination_presets");

module.exports = {
  id: "009_repair_vaccination_presets",
  description: "Repariert fehlende oder leere Standardimpfungen in bestehenden Installationen",
  up(db) {
    vaccinationPresetsMigration.up(db);
  },
};
