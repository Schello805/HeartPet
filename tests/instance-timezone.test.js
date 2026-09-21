const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getInstanceDateTime,
  isValidTimeZone,
  listTimeZones,
  resolveInstanceTimeZone,
} = require("../src/instance-timezone");

test("Instanz-Zeitzonen werden validiert und aus den Einstellungen aufgelöst", () => {
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("keine/zeitzone"), false);
  assert.equal(resolveInstanceTimeZone({ instance_timezone: "Europe/Berlin" }), "Europe/Berlin");
  assert.ok(isValidTimeZone(resolveInstanceTimeZone({ instance_timezone: "ungültig" })));
});

test("Instanz-Zeitzonen bestimmen die tatsächliche lokale Uhrzeit", () => {
  const instant = "2026-07-15T12:00:00Z";
  assert.equal(getInstanceDateTime({ instance_timezone: "UTC" }, instant).format("YYYY-MM-DD HH:mm"), "2026-07-15 12:00");
  assert.equal(getInstanceDateTime({ instance_timezone: "Europe/Berlin" }, instant).format("YYYY-MM-DD HH:mm"), "2026-07-15 14:00");
});

test("Zeitzonen-Auswahl enthält UTC und mitteleuropäische Zonen", () => {
  const values = listTimeZones();
  assert.equal(values[0], "UTC");
  assert.ok(values.includes("Europe/Berlin"));
  assert.equal(new Set(values).size, values.length);
});

test("Zeitzonen-Auswahl bleibt bei fehlenden oder leeren ICU-Daten nutzbar", () => {
  for (const provider of [null, () => [], () => { throw new Error("ICU fehlt"); }]) {
    const values = listTimeZones(provider);
    assert.equal(values[0], "UTC");
    assert.ok(values.includes("Europe/Berlin"));
    assert.ok(values.length > 1);
  }
});
