const BUILTIN_FACTS = {
  huhn: [
    "Hühner nutzen unterschiedliche Laute, um vor Gefahren aus der Luft und am Boden zu warnen.",
    "Hühner nehmen ihre Umgebung auch mit einem sehr guten Farbsehen wahr.",
    "Hühner baden im Staub, um ihr Gefieder zu pflegen.",
  ],
  katze: [
    "Katzen nutzen ihre Schnurrhaare, um enge Durchgänge und Luftbewegungen wahrzunehmen.",
    "Katzen verbringen einen großen Teil des Tages mit Schlafen und Ruhen.",
    "Eine Katze kommuniziert nicht nur mit Lauten, sondern auch mit Ohren, Schwanz und Körperhaltung.",
  ],
  hund: [
    "Hunde nehmen Gerüche deutlich differenzierter wahr als Menschen.",
    "Hunde nutzen Körperhaltung, Mimik und Lautäußerungen zur Verständigung.",
    "Der Geruchssinn spielt für Hunde auch bei der Orientierung eine wichtige Rolle.",
  ],
};

function dailyFact(speciesName, date = new Date(), customFacts = "") {
  const ownFacts = String(customFacts || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const facts = ownFacts.length ? ownFacts : BUILTIN_FACTS[String(speciesName || "").trim().toLocaleLowerCase("de-DE")];
  if (!facts?.length) return null;
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return facts[day % facts.length];
}

module.exports = { dailyFact };
