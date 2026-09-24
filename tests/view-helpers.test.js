const test = require("node:test");
const assert = require("node:assert/strict");
const dayjs = require("dayjs");

const {
  buildPermissions,
  getAnimalAge,
  getAnimalLifecycle,
  getReminderStatusMeta,
  isVaccinationReminder,
  normalizeAnimalStatus,
  summarizeReminderState,
} = require("../src/view-helpers");

test("Tieralter zeigt Jahre immer zusammen mit vollen Monaten und niemals Tage", () => {
  const today = "2026-09-21";
  assert.equal(getAnimalAge("2025-05-21", today), "1 Jahr und 4 Monate");
  assert.equal(getAnimalAge("2024-08-21", today), "2 Jahre und 1 Monat");
  assert.equal(getAnimalAge("2025-09-21", today), "1 Jahr und 0 Monate");
  assert.equal(getAnimalAge("2026-04-21", today), "5 Monate");
  assert.equal(getAnimalAge("2026-09-10", today), "0 Monate");
  assert.equal(getAnimalAge("2026-09-22", today), "-");
});

test("Impf-Erinnerungen werden auch bei älteren Datensätzen zuverlässig erkannt", () => {
  assert.equal(isVaccinationReminder({ source_kind: "vaccination" }), true);
  assert.equal(isVaccinationReminder({ reminder_type: "Impfung" }), true);
  assert.equal(isVaccinationReminder({ title: "Nächste Impfung" }), true);
  assert.equal(isVaccinationReminder({ title: "Impftermin: Tollwut" }), true);
  assert.equal(isVaccinationReminder({ title: "Impfung: RCP" }), true);
  assert.equal(isVaccinationReminder({ title: "Impfpass abholen", reminder_type: "Allgemein" }), false);
});

test("Tierstatus wird normalisiert und Lifecycle-Bereiche bleiben eindeutig", () => {
  assert.equal(normalizeAnimalStatus("Unbekannt"), "Aktiv");
  assert.deepEqual(getAnimalLifecycle("Verstorben"), {
    status: "Verstorben",
    isActive: false,
    isArchived: true,
    inHistory: true,
    inRestingPlace: true,
    label: "Diese Akte liegt als verstorbenes Tier in der Historie und wird nur noch dokumentiert.",
    hint: "Neue Erinnerungen oder Alltags-Einträge sollten hier nicht mehr entstehen. Bestehende Informationen bleiben zur Erinnerung erhalten.",
  });
  assert.equal(getAnimalLifecycle("Verkauft").inHistory, true);
});

test("Berechtigungen sind rollenbasiert klar definiert", () => {
  assert.equal(buildPermissions({ role: "admin" }).canManageAdmin, true);
  assert.equal(buildPermissions({ role: "viewer" }).canEditAnimals, false);
  assert.equal(buildPermissions({ role: "user", can_manage_documents: 1 }).canManageDocuments, true);
  assert.equal(buildPermissions({ role: "user", can_manage_documents: 0 }).canManageDocuments, false);
});

test("Reminder-Helfer liefern stabile Status- und Zählwerte", () => {
  const overdueReminder = {
    due_at: dayjs().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss"),
    completed_at: null,
    last_delivery_status: "",
  };
  const doneReminder = {
    due_at: dayjs().subtract(2, "day").format("YYYY-MM-DD HH:mm:ss"),
    completed_at: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    last_delivery_status: "completed",
  };

  assert.equal(getReminderStatusMeta(overdueReminder).label, "Überfällig");
  assert.deepEqual(summarizeReminderState([overdueReminder, doneReminder]), {
    total: 2,
    open: 1,
    done: 1,
    overdue: 1,
  });
});
