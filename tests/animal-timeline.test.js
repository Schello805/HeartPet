const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAnimalTimeline } = require("../src/animal-timeline");

test("Tier-Timeline vereint Eintragstypen und sortiert neueste zuerst", () => {
  const timeline = buildAnimalTimeline({
    vaccinations: [{ name: "Tollwut", vaccination_date: "2026-01-10", next_due_date: "2027-01-10", notes: "Nachweis" }],
    medications: [{ name: "Antibiotikum", start_date: "2026-02-01", dosage: "1 ml" }],
    notes: [{ title: "Kontrolle", content: "Unauffällig", created_at: "2026-03-01 10:00:00" }],
  });

  assert.equal(timeline.length, 4);
  assert.equal(timeline[0].title, "Impfung fällig: Tollwut");
  assert.equal(timeline.at(-1).title, "Impfung durchgeführt: Tollwut");
  assert.match(timeline.find((entry) => entry.type === "Medikament").details, /1 ml/);
});

test("Tier-Timeline ist auf 120 Einträge begrenzt", () => {
  const notes = Array.from({ length: 130 }, (_, index) => ({
    title: `Notiz ${index}`,
    created_at: `2026-01-${String((index % 28) + 1).padStart(2, "0")} 10:00:00`,
  }));
  assert.equal(buildAnimalTimeline({ notes }).length, 120);
});
