function buildAnimalTimeline(related = {}) {
  const entries = [];

  (related.vaccinations || []).forEach((item) => {
    if (item.vaccination_date) entries.push(makeEntry(`${item.vaccination_date}T09:00`, `Impfung durchgeführt: ${item.name}`, "Impfung", item.notes));
    if (item.next_due_date) entries.push(makeEntry(`${item.next_due_date}T09:00`, `Impfung fällig: ${item.name}`, "Impfung", item.notes));
  });

  (related.medications || []).forEach((item) => {
    if (item.start_date) {
      const details = [item.dosage ? `Dosis: ${item.dosage}` : "", item.notes || ""].filter(Boolean).join(" | ");
      entries.push(makeEntry(`${item.start_date}T08:00`, `Medikation gestartet: ${item.name}`, "Medikament", details));
    }
    if (item.end_date) entries.push(makeEntry(`${item.end_date}T18:00`, `Medikation Ende: ${item.name}`, "Medikament", item.notes));
  });

  (related.appointments || []).forEach((item) => {
    const details = [item.veterinarian_name ? `Tierarzt: ${item.veterinarian_name}` : "", item.location_text ? `Ort: ${item.location_text}` : "", item.notes || ""]
      .filter(Boolean)
      .join(" | ");
    entries.push(makeEntry(item.appointment_at, `Arzttermin: ${item.title}`, "Arzttermin", details));
  });

  (related.reminders || []).forEach((item) => {
    entries.push(makeEntry(item.due_at, `${item.completed_at ? "Erledigt" : "Erinnerung"}: ${item.title}`, item.reminder_type || "Erinnerung", item.notes));
  });

  (related.notes || []).forEach((item) => {
    entries.push(makeEntry(item.created_at, `Protokoll: ${item.title}`, "Protokoll", item.content));
  });

  return entries
    .filter((item) => item.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 120);
}

function makeEntry(at, title, type, details = "") {
  return { at, title, type, details: details || "" };
}

module.exports = { buildAnimalTimeline };
