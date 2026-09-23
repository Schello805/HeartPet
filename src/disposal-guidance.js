const FEDERAL_STATES = Object.freeze([
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen",
]);

const OFFICIAL_SOURCES = Object.freeze([
  {
    label: "§ 27 Tierische Nebenprodukte-Beseitigungsverordnung",
    url: "https://www.gesetze-im-internet.de/tiernebv/__27.html",
  },
  {
    label: "Tierische Nebenprodukte-Beseitigungsgesetz",
    url: "https://www.gesetze-im-internet.de/tiernebg/BJNR008210004.html",
  },
  {
    label: "Bundesportal: Tierische Nebenprodukte beseitigen lassen",
    url: "https://verwaltung.bund.de/leistungsverzeichnis/DE/leistung/99110040137000",
  },
]);

function isValidFederalState(value) {
  return FEDERAL_STATES.includes(String(value || "").trim());
}

function getDisposalGuidance(federalState) {
  const state = isValidFederalState(federalState) ? federalState : "";
  return {
    federalState: state,
    lastReviewed: "23.09.2026",
    authorityLabel: ["Berlin", "Bremen", "Hamburg"].includes(state)
      ? "zuständiges Bezirks- oder Veterinäramt"
      : "Veterinäramt des Landkreises oder der kreisfreien Stadt",
    officialSources: OFFICIAL_SOURCES,
  };
}

module.exports = {
  FEDERAL_STATES,
  getDisposalGuidance,
  isValidFederalState,
};
