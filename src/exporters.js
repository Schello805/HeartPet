const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const PAGE = {
  size: "A4",
  margin: 30,
  background: "#fffdf8",
  card: "#fffdfa",
  border: "#d9c3a6",
  title: "#2d251f",
  text: "#4e4337",
  muted: "#7e6d57",
  accent: "#c86434",
};

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
  const doc = new PDFDocument({ margin: PAGE.margin, size: PAGE.size, bufferPages: true });
  const exportDate = new Date();
  const exportDateLabel = formatDateTime(exportDate);
  const exportDomain = options.domain || "HeartPet";
  const animalUrl = buildAnimalUrl(exportDomain, animal.id);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="heartpet-tierakte-${animal.id}.pdf"`);
  doc.pipe(res);

  drawPageBackground(doc);
  await drawCompactHeader(doc, animal, {
    exportDateLabel,
    exportDomain,
    animalUrl,
    uploadsDir: options.uploadsDir,
  });

  const pageLeft = doc.page.margins.left;
  const pageTop = 214;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const leftWidth = 224;
  const rightWidth = contentWidth - leftWidth - 12;
  const leftX = pageLeft;
  const rightX = leftX + leftWidth + 12;

  drawOverviewCard(doc, leftX, pageTop, leftWidth, animal, animalUrl);
  drawSectionsColumn(doc, rightX, pageTop, rightWidth, buildSectionDefinitions(animal, related));

  drawFooter(doc, exportDateLabel);
  doc.end();
}

function drawPageBackground(doc) {
  doc.save();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(PAGE.background);
  doc.restore();
}

async function drawCompactHeader(doc, animal, options) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const imageSize = 88;
  const qrSize = options.animalUrl ? 62 : 0;
  const mediaGap = qrSize ? 10 : 0;
  const rightBlockWidth = imageSize + qrSize + mediaGap;
  const mediaX = doc.page.margins.left + pageWidth - rightBlockWidth;
  const imageY = doc.page.margins.top;
  const textWidth = pageWidth - rightBlockWidth - 22;

  doc.font("Helvetica");
  doc.fontSize(7).fillColor(PAGE.muted).text(`Export aus ${options.exportDomain}`, doc.page.margins.left, doc.page.margins.top, {
    width: textWidth,
  });
  doc.font("Helvetica-Bold");
  doc.fontSize(13).fillColor(PAGE.title).text("HeartPet Tierakte", {
    width: textWidth,
  });
  doc.fontSize(27).fillColor(PAGE.accent).text(animal.name || "Unbenannt", {
    width: textWidth,
  });
  doc.font("Helvetica");
  doc.fontSize(10).fillColor(PAGE.muted).text(
    `${animal.species_name || "Tierart unbekannt"} · Exportiert am ${options.exportDateLabel}`,
    { width: textWidth }
  );

  const profileImagePath = resolveProfileImagePath(animal, options.uploadsDir);
  if (profileImagePath) {
    try {
      doc.image(profileImagePath, mediaX + qrSize + mediaGap, imageY, {
        fit: [imageSize, imageSize],
        align: "right",
        valign: "top",
      });
    } catch {
      drawProfileFallback(doc, animal, mediaX + qrSize + mediaGap, imageY, imageSize);
    }
  } else {
    drawProfileFallback(doc, animal, mediaX + qrSize + mediaGap, imageY, imageSize);
  }

  if (options.animalUrl) {
    try {
      const qrBuffer = await QRCode.toBuffer(options.animalUrl, {
        type: "png",
        errorCorrectionLevel: "M",
        margin: 0,
        width: qrSize * 4,
      });
      doc.image(qrBuffer, mediaX, imageY + 8, {
        fit: [qrSize, qrSize],
      });
      doc.font("Helvetica");
      doc.fontSize(7).fillColor(PAGE.muted).text("QR zur Tierakte", mediaX - 2, imageY + qrSize + 14, {
        width: qrSize + 4,
        align: "center",
      });
    } catch {}
  }

  doc.save();
  doc.moveTo(doc.page.margins.left, 190)
    .lineTo(doc.page.width - doc.page.margins.right, 190)
    .lineWidth(1)
    .strokeColor(PAGE.border)
    .stroke();
  doc.restore();
}

function drawOverviewCard(doc, x, y, width, animal, animalUrl) {
  const height = 302;
  drawCard(doc, x, y, width, height);

  let cursorY = y + 14;
  drawSectionTitle(doc, "Überblick", x + 14, cursorY, width - 28);
  cursorY += 24;

  const items = [
    ["Tierart", animal.species_name || "-"],
    ["Geschlecht", animal.sex || "-"],
    ["Geboren", formatDate(animal.birth_date)],
    ["Aufnahme", formatDate(animal.intake_date)],
    ["Status", animal.status || "-"],
    ["Tierarzt", animal.veterinarian_name || animal.species_veterinarian_name || "-"],
    ["Herkunft", animal.source || "-"],
    ["Rasse", animal.breed || "-"],
    ["Farbe", animal.color || "-"],
    ["Gewicht", animal.weight_kg ? `${animal.weight_kg} kg` : "-"],
  ];

  cursorY = drawFactGrid(doc, x + 14, cursorY, width - 28, items);

  cursorY += 6;
  cursorY = drawMultilineValue(doc, x + 14, cursorY, width - 28, "Notizen", animal.notes || "Keine allgemeinen Notizen hinterlegt.", 2);

  cursorY += 8;
  if (animalUrl) {
    drawLabeledValue(doc, x + 14, cursorY, width - 28, "Instanz", normalizeBaseUrl(animalUrl).replace(/\/animals\/\d+$/, ""));
  }
}

function drawSectionsColumn(doc, x, y, width, sections) {
  let cursorY = y;
  sections.forEach((section) => {
    const height = sectionHeight(section.maxItems || 3);
    drawCard(doc, x, cursorY, width, height);
    drawSectionTitle(doc, section.title, x + 12, cursorY + 12, width - 24);
    drawItemSummary(doc, x + 12, cursorY + 34, width - 24, section.rows, section.emptyText, section.maxItems || 3);
    cursorY += height + 10;
  });
}

function buildSectionDefinitions(animal, related) {
  return [
    {
      title: "Vorerkrankungen",
      rows: (related.conditions || []).map((item) => joinParts([item.title, item.details], " · ")),
      emptyText: "Keine Vorerkrankungen hinterlegt.",
      maxItems: 3,
    },
    {
      title: "Medikation & Impfungen",
      rows: [
        ...(related.medications || []).map((item) => joinParts([item.name, item.dosage, item.schedule], " · ")),
        ...(related.vaccinations || []).map((item) => joinParts([item.name, `nächste Fälligkeit ${formatDate(item.next_due_date)}`], " · ")),
      ],
      emptyText: "Keine Medikamente oder Impfungen hinterlegt.",
      maxItems: 4,
    },
    {
      title: "Termine & Erinnerungen",
      rows: [
        ...(related.appointments || []).map((item) =>
          joinParts([
            item.title,
            formatDateTimeValue(item.appointment_at),
            item.location_mode === "vor_ort" ? "Vor Ort" : "Praxis",
          ], " · ")
        ),
        ...(related.reminders || []).map((item) =>
          joinParts([item.title, formatDateTimeValue(item.due_at), item.completed_at ? "erledigt" : "offen"], " · ")
        ),
      ],
      emptyText: "Keine Termine oder Erinnerungen hinterlegt.",
      maxItems: 4,
    },
    {
      title: "Fütterung, Dokumente & Bilder",
      rows: [
        ...(related.feedings || []).map((item) => joinParts([item.label, item.time_of_day, item.food], " · ")),
        ...(related.documents || []).map((item) => joinParts([item.title, item.category_name || "ohne Kategorie"], " · ")),
        ...(related.images || []).map((item) => joinParts([item.title || "Bild", item.original_name], " · ")),
        ...(related.notes || []).map((item) => joinParts([item.title, item.content], " · ")),
      ],
      emptyText: "Keine weiteren Einträge hinterlegt.",
      maxItems: 5,
    },
  ];
}

function drawCard(doc, x, y, width, height) {
  doc.save();
  doc.roundedRect(x, y, width, height, 10).fillAndStroke(PAGE.card, PAGE.border);
  doc.restore();
}

function drawSectionTitle(doc, title, x, y, width) {
  doc.font("Helvetica-Bold");
  doc.fontSize(11).fillColor(PAGE.title).text(title, x, y, { width });
}

function drawLabeledValue(doc, x, y, width, label, value) {
  doc.font("Helvetica-Bold");
  doc.fontSize(8).fillColor(PAGE.muted).text(String(label).toUpperCase(), x, y, { width });
  doc.font("Helvetica");
  doc.fontSize(10).fillColor(PAGE.text).text(truncateText(value, 90), x, y + 10, { width });
  return y + 32;
}

function drawFactGrid(doc, x, y, width, items) {
  const columnGap = 10;
  const columnWidth = (width - columnGap) / 2;
  let currentY = y;

  for (let index = 0; index < items.length; index += 2) {
    const left = items[index];
    const right = items[index + 1];
    drawFactCell(doc, x, currentY, columnWidth, left[0], left[1]);
    if (right) {
      drawFactCell(doc, x + columnWidth + columnGap, currentY, columnWidth, right[0], right[1]);
    }
    currentY += 38;
  }

  return currentY;
}

function drawFactCell(doc, x, y, width, label, value) {
  doc.font("Helvetica-Bold");
  doc.fontSize(8).fillColor(PAGE.muted).text(String(label).toUpperCase(), x, y, { width });
  doc.font("Helvetica");
  doc.fontSize(10).fillColor(PAGE.text).text(truncateText(value, 30), x, y + 10, { width });
}

function drawMultilineValue(doc, x, y, width, label, value, maxLines) {
  doc.font("Helvetica-Bold");
  doc.fontSize(8).fillColor(PAGE.muted).text(String(label).toUpperCase(), x, y, { width });
  doc.font("Helvetica");
  doc.fontSize(9).fillColor(PAGE.text).text(truncateByLines(doc, value, width, maxLines), x, y + 10, {
    width,
    lineGap: 1,
  });
  return y + 16 + maxLines * 11;
}

function drawItemSummary(doc, x, y, width, rows, emptyText, maxItems) {
  const normalized = (rows || []).filter(Boolean);
  const visibleRows = normalized.slice(0, maxItems);
  let cursorY = y;

  if (!visibleRows.length) {
    doc.font("Helvetica");
    doc.fontSize(9).fillColor(PAGE.muted).text(emptyText, x, cursorY, { width });
    return;
  }

  visibleRows.forEach((row) => {
    doc.circle(x + 3, cursorY + 5, 1.5).fill(PAGE.accent);
    doc.font("Helvetica");
    doc.fontSize(9).fillColor(PAGE.text).text(truncateText(row, 92), x + 10, cursorY, {
      width: width - 10,
      lineGap: 1,
    });
    cursorY += 18;
  });

  if (normalized.length > visibleRows.length) {
    doc.font("Helvetica-Bold");
    doc.fontSize(8).fillColor(PAGE.muted).text(`+ ${normalized.length - visibleRows.length} weitere Einträge`, x, cursorY + 2, {
      width,
    });
  }
}

function drawProfileFallback(doc, animal, x, y, size) {
  doc.save();
  doc.roundedRect(x, y, size, size, 8).fillAndStroke("#f3e8d8", PAGE.border);
  doc.fillColor(PAGE.accent).font("Helvetica-Bold").fontSize(22).text(getInitial(animal.name), x, y + 18, {
    width: size,
    align: "center",
  });
  doc.restore();
}

function drawFooter(doc, exportDateLabel) {
  doc.save();
  doc.font("Helvetica");
  doc.fontSize(8).fillColor(PAGE.muted).text(
    `Exportdatum: ${exportDateLabel}`,
    doc.page.margins.left,
    790,
    {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: "right",
    }
  );
  doc.restore();
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

function formatDateTime(value) {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatDateTimeValue(value) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return formatDateTime(parsed);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
  }).format(parsed);
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

function getInitial(name) {
  if (!name) {
    return "?";
  }
  return String(name).trim().charAt(0).toUpperCase();
}

function truncateText(value, maxLength) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function truncateByLines(doc, text, width, maxLines) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }

  let candidate = normalized;
  const maxHeight = maxLines * 11;
  while (candidate.length > 1 && doc.heightOfString(candidate, { width, lineGap: 1 }) > maxHeight) {
    candidate = `${candidate.slice(0, -2).trimEnd()}…`;
  }
  return candidate;
}

function joinParts(parts, separator) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(separator);
}

function sectionHeight(maxItems) {
  return 42 + maxItems * 17 + 12;
}

module.exports = {
  buildAnimalExportPayload,
  createAnimalPdf,
};
