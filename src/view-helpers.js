const dayjs = require("dayjs");

function formatDate(value) {
  if (!value) {
    return "-";
  }
  return dayjs(value).format("DD.MM.YYYY");
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return dayjs(value).format("DD.MM.YYYY HH:mm");
}

function getAnimalAge(dateString) {
  if (!dateString) {
    return "-";
  }

  const birthDate = dayjs(dateString);
  if (!birthDate.isValid() || birthDate.isAfter(dayjs())) {
    return "-";
  }

  const now = dayjs();
  const years = now.diff(birthDate, "year");
  if (years >= 1) {
    return years === 1 ? "1 Jahr" : `${years} Jahre`;
  }

  const months = now.diff(birthDate, "month");
  if (months >= 1) {
    return months === 1 ? "1 Monat" : `${months} Monate`;
  }

  const days = now.diff(birthDate, "day");
  return days === 1 ? "1 Tag" : `${days} Tage`;
}

function getAnimalInitial(name) {
  if (!name) {
    return "?";
  }
  return String(name).trim().charAt(0).toUpperCase();
}

function getAnimalSpeciesIcon(speciesName) {
  const normalized = String(speciesName || "")
    .trim()
    .toLocaleLowerCase("de-DE")
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss");
  const icons = {
    katze: "🐈", katzen: "🐈", hund: "🐕", hunde: "🐕",
    huhn: "🐔", huhner: "🐔", hahn: "🐓", pferd: "🐴", pferde: "🐴",
    kaninchen: "🐇", hase: "🐇", hasen: "🐇", vogel: "🐦",
    schaf: "🐑", schafe: "🐑", ziege: "🐐", ziegen: "🐐",
    schwein: "🐖", schweine: "🐖", rind: "🐄", rinder: "🐄", kuh: "🐄",
    ente: "🦆", enten: "🦆", gans: "🪿", ganse: "🪿",
  };
  return icons[normalized] || "🐾";
}

function normalizeAnimalStatus(status) {
  const allowedStatuses = ["Aktiv", "Vermittelt", "Verkauft", "Verstorben"];
  const normalized = String(status || "").trim();
  return allowedStatuses.includes(normalized) ? normalized : "Aktiv";
}

function getAnimalLifecycle(status) {
  const normalizedStatus = normalizeAnimalStatus(status);
  const isActive = normalizedStatus === "Aktiv";
  const inHistory = !isActive;
  const inRestingPlace = normalizedStatus === "Verstorben";

  return {
    status: normalizedStatus,
    isActive,
    isArchived: !isActive,
    inHistory,
    inRestingPlace,
    label: inRestingPlace
      ? "Diese Akte liegt als verstorbenes Tier in der Historie und wird nur noch dokumentiert."
      : inHistory
        ? "Diese Akte liegt in der Historie und ist nicht mehr Teil des aktiven Bestands."
        : "Diese Akte ist aktiv.",
    hint: inRestingPlace
      ? "Neue Erinnerungen oder Alltags-Einträge sollten hier nicht mehr entstehen. Bestehende Informationen bleiben zur Erinnerung erhalten."
      : inHistory
        ? "Neue Alltags-Einträge und laufende Erinnerungen sind für historische Tiere standardmäßig beendet."
        : "",
  };
}

function isActiveAnimalStatus(status) {
  return getAnimalLifecycle(status).isActive;
}

function getReminderStatusMeta(reminder) {
  if (!reminder) {
    return { label: "Unbekannt", tone: "muted", detail: "" };
  }

  if (reminder.completed_at) {
    return {
      label: "Erledigt",
      tone: "ok",
      detail: reminder.last_delivery_status === "completed" ? "manuell abgeschlossen" : "abgeschlossen",
    };
  }

  const dueAt = dayjs(reminder.due_at);
  if (dueAt.isValid() && dueAt.isBefore(dayjs())) {
    return {
      label: "Überfällig",
      tone: "warning",
      detail: reminder.last_delivery_status === "sent" ? "bereits versendet" : "wartet auf Rückmeldung",
    };
  }

  if (reminder.last_delivery_status === "rescheduled") {
    return { label: "Neu terminiert", tone: "active", detail: "wiederkehrend weitergeführt" };
  }

  if (reminder.last_delivery_status === "sent") {
    return { label: "Offen", tone: "active", detail: "Benachrichtigung versendet" };
  }

  if (reminder.last_delivery_status === "error") {
    return { label: "Fehler", tone: "danger", detail: "Versand fehlgeschlagen" };
  }

  return { label: "Offen", tone: "muted", detail: "noch nicht abgeschlossen" };
}

function summarizeReminderState(reminders = []) {
  const items = Array.isArray(reminders) ? reminders : [];
  return {
    total: items.length,
    open: items.filter((item) => !item.completed_at).length,
    done: items.filter((item) => item.completed_at).length,
    overdue: items.filter((item) => !item.completed_at && dayjs(item.due_at).isBefore(dayjs())).length,
  };
}

function getRoleLabel(role) {
  const labels = {
    admin: "Administrator",
    user: "Benutzer",
    viewer: "Nur Lesen",
  };
  return labels[role] || role;
}

function buildPermissions(user) {
  const role = user?.role || "viewer";
  if (role === "admin") {
    return {
      isAdmin: true,
      canManageAdmin: true,
      canEditAnimals: true,
      canManageDocuments: true,
      canManageGallery: true,
      canManageHealth: true,
      canManageFeedings: true,
      canManageNotes: true,
      canManageReminders: true,
    };
  }

  if (role === "viewer") {
    return {
      isAdmin: false,
      canManageAdmin: false,
      canEditAnimals: false,
      canManageDocuments: false,
      canManageGallery: false,
      canManageHealth: false,
      canManageFeedings: false,
      canManageNotes: false,
      canManageReminders: false,
    };
  }

  return {
    isAdmin: false,
    canManageAdmin: false,
    canEditAnimals: Boolean(user?.can_edit_animals),
    canManageDocuments: Boolean(user?.can_manage_documents),
    canManageGallery: Boolean(user?.can_manage_gallery),
    canManageHealth: Boolean(user?.can_manage_health),
    canManageFeedings: Boolean(user?.can_manage_feedings),
    canManageNotes: Boolean(user?.can_manage_notes),
    canManageReminders: Boolean(user?.can_manage_reminders),
  };
}

module.exports = {
  buildPermissions,
  formatDate,
  formatDateTime,
  getAnimalAge,
  getAnimalInitial,
  getAnimalSpeciesIcon,
  getAnimalLifecycle,
  getReminderStatusMeta,
  getRoleLabel,
  isActiveAnimalStatus,
  normalizeAnimalStatus,
  summarizeReminderState,
};
