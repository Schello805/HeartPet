const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCalendar, escapeCalendarText } = require("../src/services/calendar-export");
const { isIsoDate, parseAmountCents, parseNonNegativeNumber } = require("../src/routes/care-management");

test("Kosten werden ohne Gleitkommafehler als Cent validiert", () => {
  assert.equal(parseAmountCents("12,34"), 1234);
  assert.equal(parseAmountCents("0.01"), 1);
  assert.equal(parseAmountCents("-1"), null);
  assert.equal(parseAmountCents("ungueltig"), null);
  assert.equal(parseNonNegativeNumber("1,5"), 1.5);
  assert.equal(isIsoDate("2026-09-21"), true);
  assert.equal(isIsoDate("2026-99-99"), false);
});

test("Kalenderexport enthält Termine und offene Erinnerungen als gültige ICS-Ereignisse", () => {
  const calendar = buildCalendar({
    name: "HeartPet Test",
    appointments: [{ id: 1, animal_name: "Minka", title: "Kontrolle, Impfung", appointment_at: "2026-10-01T10:30", notes: "Bitte nüchtern", location_text: "Praxis; Mitte" }],
    reminders: [{ id: 2, animal_name: "Minka", title: "Tablette", due_at: "2026-10-02T08:00", reminder_type: "Medikament" }],
  });

  assert.match(calendar, /BEGIN:VCALENDAR\r\n/);
  assert.match(calendar, /UID:appointment-1@heartpet\.local/);
  assert.match(calendar, /DTSTART:20261001T103000/);
  assert.match(calendar, /SUMMARY:Minka: Kontrolle\\, Impfung/);
  assert.match(calendar, /LOCATION:Praxis\\; Mitte/);
  assert.match(calendar, /UID:reminder-2@heartpet\.local/);
  assert.match(calendar, /END:VCALENDAR\r\n$/);
  assert.equal(escapeCalendarText("A, B; C\nD"), "A\\, B\\; C\\nD");
});
