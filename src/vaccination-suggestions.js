const suggestionsBySpecies = Object.freeze({
  Hund: Object.freeze([
    "SHP/L (Staupe, Hepatitis, Parvovirose und Leptospirose)",
    "Tollwut",
  ]),
  Katze: Object.freeze([
    "RCP (Katzenschnupfen und Katzenseuche)",
    "Tollwut",
  ]),
  Huhn: Object.freeze([
    "Newcastle-Krankheit (ND)",
    "Infektiöse Bronchitis (IB)",
  ]),
  Kaninchen: Object.freeze([
    "Myxomatose",
    "RHDV1 und RHDV2",
  ]),
  Pferd: Object.freeze([
    "Tetanus",
    "Equine Influenza (EIV)",
  ]),
  Frettchen: Object.freeze([
    "Staupe",
    "Tollwut",
  ]),
});

const speciesAliases = Object.freeze({
  hund: "Hund",
  hunde: "Hund",
  katze: "Katze",
  katzen: "Katze",
  huhn: "Huhn",
  huehner: "Huhn",
  kaninchen: "Kaninchen",
  pferd: "Pferd",
  pferde: "Pferd",
  frettchen: "Frettchen",
});

function normalizeSpeciesName(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("de-DE")
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss");
}

function getVaccinationSuggestionsForSpecies(speciesName, configuredPresets = null) {
  const normalizedName = normalizeSpeciesName(speciesName);
  if (Array.isArray(configuredPresets)) {
    const suggestions = configuredPresets
      .filter((item) => {
        const presetSpecies = normalizeSpeciesName(item.species_name);
        return presetSpecies === normalizedName
          || normalizedName.includes(presetSpecies)
          || presetSpecies.includes(normalizedName);
      })
      .map((item) => item.name);
    if (suggestions.length > 0) {
      return { speciesName: String(speciesName || "Tier").trim() || "Tier", suggestions: [...new Set(suggestions)] };
    }
  }
  const canonicalName = speciesAliases[normalizedName]
    || Object.entries(speciesAliases).find(([alias]) => normalizedName.includes(alias))?.[1];
  return canonicalName
    ? { speciesName: canonicalName, suggestions: [...suggestionsBySpecies[canonicalName]] }
    : { speciesName: String(speciesName || "Tier").trim() || "Tier", suggestions: [] };
}

function getVaccinationSuggestionGroups(speciesNames) {
  const groups = new Map();
  [...new Set(speciesNames || [])].forEach((speciesName) => {
    const group = getVaccinationSuggestionsForSpecies(speciesName);
    if (group.suggestions.length > 0) groups.set(group.speciesName, group);
  });
  return [...groups.values()].sort((left, right) => left.speciesName.localeCompare(right.speciesName, "de"));
}

module.exports = {
  getVaccinationSuggestionGroups,
  getVaccinationSuggestionsForSpecies,
};
