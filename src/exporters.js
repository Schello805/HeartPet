const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

function buildAnimalExportPayload(animal, related, options = {}) {
  const exportRelated = {
    ...related,
    documents: (related.documents || []).map((item) => attachEmbeddedFile(item, options.uploadsDir)),
    images: (related.images || []).map((item) => attachEmbeddedFile(item, options.uploadsDir)),
  };

  return {
    meta: {
      application: "HeartPet",
      version: 1,
      exportedAt: new Date().toISOString(),
      importHint: "Diese Datei kann für einen Import in HeartPet verwendet werden.",
      includesEmbeddedFiles: Boolean(options.embedFiles !== false),
    },
    animal,
    related: exportRelated,
  };
}

function createAnimalPdf(res, animal, related) {
  const doc = new PDFDocument({ margin: 48, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="heartpet-tierakte-${animal.id}.pdf"`);
  doc.pipe(res);

  doc.fontSize(22).text("HeartPet Tierakte", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10).text("Dieser Export wurde mit HeartPet erzeugt. Ein Import in HeartPet ist möglich.");
  doc.moveDown();

  const lines = [
    `Name: ${animal.name}`,
    `Tierart: ${animal.species_name || "-"}`,
    `Geschlecht: ${animal.sex || "-"}`,
    `Geburtsdatum: ${animal.birth_date || "-"}`,
    `Aufnahmedatum: ${animal.intake_date || "-"}`,
    `Status: ${animal.status || "-"}`,
    `Herkunft: ${animal.source || "-"}`,
    `Rasse: ${animal.breed || "-"}`,
    `Farbe: ${animal.color || "-"}`,
    `Gewicht: ${animal.weight_kg || "-"}`,
    `Tierarzt: ${animal.veterinarian_name || animal.species_veterinarian_name || "-"}`,
  ];

  lines.forEach((line) => doc.fontSize(11).text(line));

  if (animal.notes) {
    doc.moveDown();
    doc.fontSize(13).text("Allgemeine Notizen");
    doc.fontSize(10).text(animal.notes);
  }

  writeSection(doc, "Vorerkrankungen", related.conditions.map((item) => `${item.title}${item.details ? `: ${item.details}` : ""}`));
  writeSection(
    doc,
    "Medikamente",
    related.medications.map((item) => `${item.name} | Dosis: ${item.dosage || "-"} | Plan: ${item.schedule || "-"}`)
  );
  writeSection(
    doc,
    "Impfungen",
    related.vaccinations.map(
      (item) => `${item.name} | Datum: ${item.vaccination_date || "-"} | Nächste Fälligkeit: ${item.next_due_date || "-"}`
    )
  );
  writeSection(
    doc,
    "Arzttermine",
    (related.appointments || []).map(
      (item) => `${item.title} | Termin: ${item.appointment_at || "-"} | Modus: ${item.location_mode === "vor_ort" ? "Tierarzt kommt vor Ort" : "Tier wird zur Praxis gebracht"} | Ort: ${item.location_text || "-"} | Tierarzt: ${item.veterinarian_name || "-"}`
    )
  );
  writeSection(
    doc,
    "Fütterungspläne",
    related.feedings.map((item) => `${item.label} | Uhrzeit: ${item.time_of_day || "-"} | Futter: ${item.food || "-"}`)
  );
  writeSection(
    doc,
    "Erinnerungen",
    related.reminders.map((item) => {
      const repeatText = item.repeat_interval_days ? ` | Wiederholung: alle ${item.repeat_interval_days} Tage` : "";
      const statusText = item.last_delivery_status ? ` | Versandstatus: ${item.last_delivery_status}` : "";
      return `${item.title} | Fällig: ${item.due_at} | Typ: ${item.reminder_type}${repeatText}${statusText}`;
    })
  );
  writeSection(
    doc,
    "Dokumente",
    related.documents.map((item) => `${item.title} | Kategorie: ${item.category_name || "-"} | Datei: ${item.original_name}`)
  );
  writeSection(
    doc,
    "Bildergalerie",
    (related.images || []).map((item) => `${item.title || "Bild"} | Datei: ${item.original_name}`)
  );
  writeSection(
    doc,
    "Protokolle",
    related.notes.map((item) => `${item.title} | ${item.content}`)
  );

  doc.end();
}

function writeSection(doc, title, rows) {
  doc.moveDown();
  doc.fontSize(13).text(title);
  if (rows.length === 0) {
    doc.fontSize(10).text("Keine Einträge.");
    return;
  }

  rows.forEach((row) => {
    doc.fontSize(10).text(`- ${row}`);
  });
}

function attachEmbeddedFile(item, uploadsDir) {
  const exported = { ...item };
  if (!uploadsDir || !item.stored_name) {
    return exported;
  }

  const fullPath = path.join(uploadsDir, item.stored_name);
  if (!fs.existsSync(fullPath)) {
    return exported;
  }

  exported.embedded_file = {
    original_name: item.original_name || item.stored_name,
    stored_name: item.stored_name,
    mime_type: item.mime_type || "",
    encoding: "base64",
    content: fs.readFileSync(fullPath).toString("base64"),
  };
  return exported;
}

module.exports = {
  buildAnimalExportPayload,
  createAnimalPdf,
};
