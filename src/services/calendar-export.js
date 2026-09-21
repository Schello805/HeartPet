const dayjs = require("dayjs");

function escapeCalendarText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatCalendarDateTime(value) {
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format("YYYYMMDDTHHmmss") : "";
}

function foldCalendarLine(line) {
  const chunks = [];
  let remaining = String(line);
  while (Buffer.byteLength(remaining, "utf8") > 73) {
    let splitAt = Math.min(70, remaining.length);
    while (splitAt > 1 && Buffer.byteLength(remaining.slice(0, splitAt), "utf8") > 73) splitAt -= 1;
    chunks.push(remaining.slice(0, splitAt));
    remaining = ` ${remaining.slice(splitAt)}`;
  }
  chunks.push(remaining);
  return chunks.join("\r\n");
}

function buildCalendar({ name, appointments = [], reminders = [] }) {
  const generatedAt = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HeartPet//Kalender//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeCalendarText(name || "HeartPet")}`,
  ];

  appointments.forEach((item) => {
    const startsAt = formatCalendarDateTime(item.appointment_at);
    if (!startsAt) return;
    lines.push(
      "BEGIN:VEVENT",
      `UID:appointment-${item.id}@heartpet.local`,
      `DTSTAMP:${generatedAt}`,
      `DTSTART:${startsAt}`,
      `SUMMARY:${escapeCalendarText(`${item.animal_name}: ${item.title}`)}`,
      `DESCRIPTION:${escapeCalendarText(item.notes || "Arzttermin")}`,
      ...(item.location_text ? [`LOCATION:${escapeCalendarText(item.location_text)}`] : []),
      "END:VEVENT",
    );
  });

  reminders.forEach((item) => {
    const startsAt = formatCalendarDateTime(item.due_at);
    if (!startsAt) return;
    lines.push(
      "BEGIN:VEVENT",
      `UID:reminder-${item.id}@heartpet.local`,
      `DTSTAMP:${generatedAt}`,
      `DTSTART:${startsAt}`,
      `SUMMARY:${escapeCalendarText(`${item.animal_name || "HeartPet"}: ${item.title}`)}`,
      `DESCRIPTION:${escapeCalendarText(item.notes || item.reminder_type || "Erinnerung")}`,
      "END:VEVENT",
    );
  });

  lines.push("END:VCALENDAR");
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
}

function createCalendarExportService(db) {
  function getEntries(animalId = null) {
    const animalFilter = animalId ? " AND animals.id = ?" : "";
    const params = animalId ? [animalId] : [];
    const appointments = db.prepare(`
      SELECT animal_appointments.*, animals.name AS animal_name
      FROM animal_appointments
      INNER JOIN animals ON animals.id = animal_appointments.animal_id
      WHERE animals.status = 'Aktiv'
        AND datetime(animal_appointments.appointment_at) >= datetime('now', 'localtime')
        ${animalFilter}
      ORDER BY REPLACE(animal_appointments.appointment_at, ' ', 'T') ASC
    `).all(...params);
    const reminders = db.prepare(`
      SELECT reminders.*, animals.name AS animal_name
      FROM reminders
      LEFT JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL
        AND (animals.id IS NULL OR animals.status = 'Aktiv')
        ${animalId ? " AND animals.id = ?" : ""}
      ORDER BY REPLACE(reminders.due_at, ' ', 'T') ASC
    `).all(...params);
    return { appointments, reminders };
  }

  function exportCalendar({ animalId = null, name = "HeartPet Kalender" } = {}) {
    return buildCalendar({ name, ...getEntries(animalId) });
  }

  return { exportCalendar, getEntries };
}

module.exports = { buildCalendar, createCalendarExportService, escapeCalendarText, formatCalendarDateTime };
