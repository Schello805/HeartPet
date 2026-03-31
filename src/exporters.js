const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

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

async function createAnimalPdf(res, animal, related, options = {}) {
  const doc = new PDFDocument({ margin: 48, size: "A4", bufferPages: true });
  const exportDate = new Date();
  const exportDateLabel = formatDateTime(exportDate);
  const exportDomain = options.domain || "HeartPet";
  const animalUrl = buildAnimalUrl(exportDomain, animal.id);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="heartpet-tierakte-${animal.id}.pdf"`);
  doc.pipe(res);

  const startY = await drawHeader(doc, animal, {
    exportDomain,
    animalUrl,
    uploadsDir: options.uploadsDir,
  });
  doc.y = startY;

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

  if (animalUrl) {
    lines.push(`Direktlink: ${animalUrl}`);
  }

  lines.forEach((line) => doc.fontSize(11).fillColor("#2d251f").text(line));

  if (animal.notes) {
    doc.moveDown();
    doc.fontSize(13).fillColor("#2d251f").text("Allgemeine Notizen");
    doc.fontSize(10).fillColor("#4e4337").text(animal.notes);
  }

  writeSection(doc, "Vorerkrankungen", (related.conditions || []).map((item) => `${item.title}${item.details ? `: ${item.details}` : ""}`));
  writeSection(
    doc,
    "Medikamente",
    (related.medications || []).map((item) => `${item.name} | Dosis: ${item.dosage || "-"} | Plan: ${item.schedule || "-"}`)
  );
  writeSection(
    doc,
    "Impfungen",
    (related.vaccinations || []).map(
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
    (related.feedings || []).map((item) => `${item.label} | Uhrzeit: ${item.time_of_day || "-"} | Futter: ${item.food || "-"}`)
  );
  writeSection(
    doc,
    "Erinnerungen",
    (related.reminders || []).map((item) => {
      const repeatText = item.repeat_interval_days ? ` | Wiederholung: alle ${item.repeat_interval_days} Tage` : "";
      const statusText = item.last_delivery_status ? ` | Versandstatus: ${item.last_delivery_status}` : "";
      return `${item.title} | Fällig: ${item.due_at} | Typ: ${item.reminder_type}${repeatText}${statusText}`;
    })
  );
  writeSection(
    doc,
    "Dokumente",
    (related.documents || []).map((item) => `${item.title} | Kategorie: ${item.category_name || "-"} | Datei: ${item.original_name}`)
  );
  writeSection(
    doc,
    "Bildergalerie",
    (related.images || []).map((item) => `${item.title || "Bild"} | Datei: ${item.original_name}`)
  );
  writeSection(
    doc,
    "Protokolle",
    (related.notes || []).map((item) => `${item.title} | ${item.content}`)
  );

  drawFooters(doc, exportDateLabel);
  doc.end();
}

async function drawHeader(doc, animal, options) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const imageSize = 84;
  const qrSize = options.animalUrl ? 70 : 0;
  const mediaColumnWidth = Math.max(imageSize, qrSize);
  const imageX = doc.page.margins.left + pageWidth - mediaColumnWidth;
  const imageY = doc.page.margins.top;
  const textWidth = pageWidth - mediaColumnWidth - 18;

  doc.fontSize(10).fillColor("#7e6d57").text(`Export aus ${options.exportDomain}`, doc.page.margins.left, doc.page.margins.top, {
    width: textWidth,
  });
  doc.moveDown(0.15);
  doc.fontSize(22).fillColor("#2d251f").text("HeartPet Tierakte", {
    width: textWidth,
  });
  doc.moveDown(0.35);
  doc.fontSize(10).fillColor("#7e6d57").text("Dieser Export wurde mit HeartPet erzeugt. Ein Import in HeartPet ist möglich.", {
    width: textWidth,
  });

  const profileImagePath = resolveProfileImagePath(animal, options.uploadsDir);
  if (profileImagePath) {
    try {
      doc.image(profileImagePath, imageX, imageY, {
        fit: [imageSize, imageSize],
        align: "right",
        valign: "top",
      });
    } catch {
      drawProfileFallback(doc, animal, imageX, imageY, imageSize);
    }
  } else {
    drawProfileFallback(doc, animal, imageX, imageY, imageSize);
  }

  let mediaBottomY = imageY + imageSize;
  if (options.animalUrl) {
    try {
      const qrBuffer = await QRCode.toBuffer(options.animalUrl, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 1,
        width: qrSize * 4,
      });
      const qrY = imageY + imageSize + 10;
      doc.image(qrBuffer, imageX, qrY, {
        fit: [qrSize, qrSize],
        align: "right",
        valign: "top",
      });
      doc.fontSize(8).fillColor("#7e6d57").text("QR zum Tier", imageX, qrY + qrSize + 4, {
        width: mediaColumnWidth,
        align: "center",
      });
      mediaBottomY = qrY + qrSize + 18;
    } catch {
      mediaBottomY = imageY + imageSize;
    }
  }

  doc.save();
  doc.rect(doc.page.margins.left, mediaBottomY + 10, pageWidth, 1).fill("#d9c3a6");
  doc.restore();
  return mediaBottomY + 24;
}

function drawProfileFallback(doc, animal, x, y, size) {
  doc.save();
  doc.roundedRect(x, y, size, size, 6).fillAndStroke("#f3e8d8", "#d9c3a6");
  doc.fillColor("#c86434").fontSize(28).text(getInitial(animal.name), x, y + 24, {
    width: size,
    align: "center",
  });
  doc.restore();
}

function drawFooters(doc, exportDateLabel) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index);
    doc.fontSize(9).fillColor("#7e6d57").text(
      `Exportdatum: ${exportDateLabel}`,
      doc.page.margins.left,
      doc.page.height - doc.page.margins.bottom + 10,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: "right",
      }
    );
  }
}

function writeSection(doc, title, rows) {
  doc.moveDown();
  doc.fontSize(13).fillColor("#2d251f").text(title);
  if (rows.length === 0) {
    doc.fontSize(10).fillColor("#7e6d57").text("Keine Einträge.");
    return;
  }

  rows.forEach((row) => {
    doc.fontSize(10).fillColor("#4e4337").text(`- ${row}`);
  });
}

function resolveProfileImagePath(animal, uploadsDir) {
  if (!uploadsDir || !animal.profile_image_stored_name) {
    return null;
  }

  const fullPath = path.join(uploadsDir, animal.profile_image_stored_name);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  return fullPath;
}

function getInitial(name) {
  if (!name) {
    return "?";
  }
  return String(name).trim().charAt(0).toUpperCase();
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function buildAnimalUrl(domainValue, animalId) {
  const normalizedBase = normalizeBaseUrl(domainValue);
  if (!normalizedBase) {
    return "";
  }
  return `${normalizedBase.replace(/\/+$/, "")}/animals/${animalId}`;
}

function normalizeBaseUrl(domainValue) {
  const raw = String(domainValue || "").trim();
  if (!raw) {
    return "";
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return `https://${raw}`;
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
