const test = require("node:test");
const assert = require("node:assert/strict");
const dayjs = require("dayjs");

const {
  buildPermissions,
  getAnimalLifecycle,
  getReminderStatusMeta,
  normalizeAnimalStatus,
  summarizeReminderState,
} = require("../src/view-helpers");

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
