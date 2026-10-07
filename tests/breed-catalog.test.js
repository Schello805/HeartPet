const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { providerForSpecies, loadBreeds, importBreeds } = require("../src/services/breed-catalog");
const { dailyFact } = require("../src/services/daily-species-facts");
const migration = require("../src/migrations/014_species_breeds");

test("Rassenquelle erkennt bekannte Tierarten und verwirft fremde Bildhosts", async () => {
  assert.equal(providerForSpecies(" Hund "), "dogapi");
  assert.equal(providerForSpecies("Katze"), "thecatapi");
  assert.equal(providerForSpecies("Huhn"), "chickenapi");
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ attributes: {
      name: "Beagle",
      description: "A dog",
      images: [{ medium: "https://example.com/untrusted.webp", attribution: { author: "Jane", license: "CC BY", source_url: "https://commons.wikimedia.org/" } }],
    } }] }),
  });
  try {
    const breeds = await loadBreeds("dogapi");
    assert.equal(breeds[0].name, "Beagle");
    assert.equal(breeds[0].image_url, "");
    assert.match(breeds[0].image_credit, /Jane/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Rassenimport bleibt bei erneutem Laden idempotent", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE species (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO species VALUES (1, 'Hund')");
    migration.up(db);
    const breed = { name: "Beagle", description: "", image_url: "", image_credit: "", image_source_url: "" };
    assert.equal(importBreeds(db, 1, "dogapi", [breed]), 1);
    assert.equal(importBreeds(db, 1, "dogapi", [breed]), 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM species_breeds").get().count, 1);
  } finally {
    db.close();
  }
});

test("Hühnerrassen übernehmen nur Bilder vom bekannten Host", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [{ name: "Leghorn", origin: "Italy", imageUrl: "https://qwex.co/chicken-api/images/leghorn.png" }],
  });
  try {
    const breeds = await loadBreeds("chickenapi");
    assert.equal(breeds[0].name, "Leghorn");
    assert.equal(breeds[0].origin, "Italy");
    assert.match(breeds[0].image_url, /^https:\/\/qwex\.co\//);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Katzenimport verwendet den in der Verwaltung gespeicherten API-Schlüssel", async () => {
  const originalFetch = global.fetch;
  let header;
  global.fetch = async (_url, options) => {
    header = options.headers["x-api-key"];
    return { ok: true, json: async () => [{ name: "Bengal", origin: "USA" }] };
  };
  try {
    const breeds = await loadBreeds("thecatapi", { catApiKey: "frontend-schluessel" });
    assert.equal(header, "frontend-schluessel");
    assert.equal(breeds[0].name, "Bengal");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Tierart-Fakt wechselt am Folgetag", () => {
  const today = dailyFact("Huhn", new Date(2026, 9, 7));
  const tomorrow = dailyFact("Huhn", new Date(2026, 9, 8));
  assert.ok(today);
  assert.notEqual(today, tomorrow);
  assert.equal(dailyFact("Unbekannt"), null);
  assert.equal(dailyFact("Papagei", new Date(2026, 9, 7), "Eigener Fakt"), "Eigener Fakt");
});
