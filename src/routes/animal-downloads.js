const fs = require("fs");
const express = require("express");

function createAnimalDownloadsRouter({
  buildAnimalExportPayload,
  createAnimalPdf,
  db,
  findAnimal,
  getAnimalRelatedData,
  getSettingsObject,
  renderNotFound,
  resolveStoredFilePath,
  setFlash,
  uploadsDir,
}) {
  const router = express.Router();

  router.get("/documents/:id/download", (req, res) => {
    const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
    if (!document) {
      return renderNotFound(req, res, "Dokument nicht gefunden.");
    }

    const fullPath = resolveStoredFilePath(uploadsDir, document.stored_name);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return renderNotFound(req, res, "Datei wurde auf dem Server nicht gefunden.");
    }

    res.download(fullPath, document.original_name);
  });

  router.get("/vaccinations/:id/certificate", (req, res) => {
    const vaccination = db.prepare(`
      SELECT certificate_original_name, certificate_stored_name
      FROM animal_vaccinations
      WHERE id = ?
    `).get(req.params.id);
    if (!vaccination?.certificate_stored_name) {
      return renderNotFound(req, res, "Impfnachweis nicht gefunden.");
    }
    const fullPath = resolveStoredFilePath(uploadsDir, vaccination.certificate_stored_name);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return renderNotFound(req, res, "Datei wurde auf dem Server nicht gefunden.");
    }
    return res.download(fullPath, vaccination.certificate_original_name || "impfnachweis");
  });

  router.get("/animals/:id/export/json", (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) {
      return renderNotFound(req, res, "Tier nicht gefunden.");
    }

    const payload = buildAnimalExportPayload(animal, getAnimalRelatedData(req.params.id), {
      uploadsDir,
      embedFiles: true,
    });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="heartpet-tier-${animal.id}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  });

  router.get("/animals/:id/export/pdf", async (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) {
      return renderNotFound(req, res, "Tier nicht gefunden.");
    }

    try {
      await createAnimalPdf(res, animal, getAnimalRelatedData(req.params.id), {
        domain: getSettingsObject(db).app_domain || "HeartPet",
        uploadsDir,
      });
    } catch (error) {
      console.error("[HeartPet] PDF-Export fehlgeschlagen:", error.message);
      if (!res.headersSent) {
        setFlash(req, "error", "Der PDF-Export konnte nicht erstellt werden.");
        return res.redirect(`/animals/${req.params.id}`);
      }
    }
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAnimalDownloadsRouter };
