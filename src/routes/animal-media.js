const fs = require("fs");
const express = require("express");

function createAnimalMediaRouter({
  db, uploadsDir, upload, requireAnimalPermission, safeLocalReturnPath, setFlash,
  createAuditLog, resolveStoredFilePath, safeDeleteUploadedFile, findAnimal,
  renderNotFound, deleteUploadedFileIfUnreferenced, optimizeAnimalImageUpload,
}) {
  const router = express.Router();

  router.post("/animals/:id/documents", requireAnimalPermission("canManageDocuments"), upload.single("document"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    if (!req.file) {
      setFlash(req, "error", "Bitte wähle eine Datei aus.");
      return res.redirect(`/animals/${req.params.id}/documents/new?return_to=${encodeURIComponent(returnTo)}`);
    }
  
    const result = db.prepare(`
      INSERT INTO documents (animal_id, category_id, title, original_name, stored_name, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.body.category_id || null,
      req.body.title || req.file.originalname,
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size
    );
  
    createAuditLog(req, "animal.document_create", {
      animal_id: req.params.id,
      document_id: result.lastInsertRowid,
      title: req.body.title || req.file.originalname,
    }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", "Dokument hochgeladen.");
    res.redirect(returnTo);
  });
  
  router.post("/animals/:animalId/documents/:entryId/update", requireAnimalPermission("canManageDocuments"), (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
    db.prepare(`
      UPDATE documents
      SET title = ?, category_id = ?
      WHERE id = ? AND animal_id = ?
    `).run(req.body.title, req.body.category_id || null, req.params.entryId, req.params.animalId);
    createAuditLog(req, "animal.document_update", {
      animal_id: req.params.animalId,
      document_id: req.params.entryId,
      title: String(req.body.title || "").trim(),
    }, { entityType: "animal", entityId: req.params.animalId });
    setFlash(req, "success", "Dokument aktualisiert.");
    res.redirect(returnTo);
  });
  
  router.get("/animals/:animalId/documents/:entryId/update", requireAnimalPermission("canManageDocuments"), (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(
      req,
      res,
      getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
      `/animals/${req.params.animalId}/documents/${req.params.entryId}/edit`
    );
  });
  
  router.post("/animals/:animalId/documents/:entryId/delete", requireAnimalPermission("canManageDocuments"), (req, res) => {
    const document = db.prepare("SELECT * FROM documents WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (document) {
      const fullPath = resolveStoredFilePath(uploadsDir, document.stored_name);
      if (fullPath && fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
    db.prepare("DELETE FROM documents WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    createAuditLog(req, "animal.document_delete", {
      animal_id: req.params.animalId,
      document_id: req.params.entryId,
      title: document?.title || "",
    }, { entityType: "animal", entityId: req.params.animalId });
    setFlash(req, "success", "Dokument gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });
  
  router.post("/animals/:id/profile-image", requireAnimalPermission("canManageGallery"), upload.single("profile_image"), async (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) {
      return renderNotFound(req, res, "Tier nicht gefunden.");
    }
  
    if (!req.file) {
      setFlash(req, "error", "Bitte wähle ein Bild aus.");
      return res.redirect(`/animals/${req.params.id}`);
    }
  
    if (!String(req.file.mimetype || "").startsWith("image/")) {
      safeDeleteUploadedFile(req.file.filename);
      setFlash(req, "error", "Es können nur Bilddateien als Profilbild gespeichert werden.");
      return res.redirect(`/animals/${req.params.id}`);
    }

    const imageOptimization = await optimizeAnimalImageUpload(req.file);
    if (imageOptimization.error) {
      console.warn("[HeartPet] Profilbild konnte nicht optimiert werden:", imageOptimization.error.message);
    }
  
    db.prepare(`
      UPDATE animals
      SET profile_image_stored_name = ?,
          profile_image_original_name = ?,
          profile_image_mime_type = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.file.filename, req.file.originalname, req.file.mimetype, req.params.id);
  
    deleteUploadedFileIfUnreferenced(animal.profile_image_stored_name);
  
    createAuditLog(req, "animal.profile_image_update", {
      animal_id: req.params.id,
      original_name: req.file.originalname,
    }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", "Profilbild gespeichert.");
    res.redirect(`/animals/${req.params.id}`);
  });
  
  router.post("/animals/:id/profile-image/delete", requireAnimalPermission("canManageGallery"), (req, res) => {
    const animal = findAnimal(req.params.id);
    if (!animal) {
      return renderNotFound(req, res, "Tier nicht gefunden.");
    }
  
    db.prepare(`
      UPDATE animals
      SET profile_image_stored_name = NULL,
          profile_image_original_name = NULL,
          profile_image_mime_type = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);
  
    deleteUploadedFileIfUnreferenced(animal.profile_image_stored_name);
  
    createAuditLog(req, "animal.profile_image_delete", {
      animal_id: req.params.id,
    }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", "Profilbild entfernt.");
    res.redirect(`/animals/${req.params.id}`);
  });
  
  router.post("/animals/:id/images", requireAnimalPermission("canManageGallery"), upload.single("image"), async (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
    if (!req.file) {
      setFlash(req, "error", "Bitte ein Bild auswählen.");
      return res.redirect(`/animals/${req.params.id}/images/new?return_to=${encodeURIComponent(returnTo)}`);
    }
  
    if (!String(req.file.mimetype || "").startsWith("image/")) {
      safeDeleteUploadedFile(req.file.filename);
      setFlash(req, "error", "Es können nur Bilddateien hochgeladen werden.");
      return res.redirect(`/animals/${req.params.id}/images/new?return_to=${encodeURIComponent(returnTo)}`);
    }

    const imageOptimization = await optimizeAnimalImageUpload(req.file);
    if (imageOptimization.error) {
      console.warn("[HeartPet] Galeriebild konnte nicht optimiert werden:", imageOptimization.error.message);
    }
  
    const result = db.prepare(`
      INSERT INTO animal_images (animal_id, title, original_name, stored_name, mime_type, file_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.body.title || "",
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size
    );
  
    createAuditLog(req, "animal.image_create", {
      animal_id: req.params.id,
      image_id: result.lastInsertRowid,
      title: String(req.body.title || "").trim(),
    }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", "Bild zur Galerie hinzugefügt.");
    res.redirect(returnTo);
  });
  
  router.post("/animals/:animalId/images/:entryId/delete", requireAnimalPermission("canManageGallery"), (req, res) => {
    const image = db.prepare("SELECT * FROM animal_images WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!image) {
      return renderNotFound(req, res, "Bild nicht gefunden.");
    }
  
    const fullPath = resolveStoredFilePath(uploadsDir, image.stored_name);
    if (fullPath && fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  
    db.prepare("DELETE FROM animal_images WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
    createAuditLog(req, "animal.image_delete", {
      animal_id: req.params.animalId,
      image_id: req.params.entryId,
      title: image.title || "",
    }, { entityType: "animal", entityId: req.params.animalId });
    setFlash(req, "success", "Galeriebild gelöscht.");
    res.redirect(`/animals/${req.params.animalId}`);
  });
  
  router.post("/animals/:animalId/images/:entryId/set-profile", requireAnimalPermission("canManageGallery"), (req, res) => {
    const image = db.prepare("SELECT * FROM animal_images WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
    if (!image) {
      return renderNotFound(req, res, "Bild nicht gefunden.");
    }
  
    db.prepare(`
      UPDATE animals
      SET profile_image_stored_name = ?, profile_image_original_name = ?, profile_image_mime_type = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(image.stored_name, image.original_name, image.mime_type || "", req.params.animalId);
  
    createAuditLog(req, "animal.profile_image_update", {
      animal_id: req.params.animalId,
      source_image_id: req.params.entryId,
      original_name: image.original_name,
    }, { entityType: "animal", entityId: req.params.animalId });
  
    setFlash(req, "success", "Galeriebild als Profilbild gesetzt.");
    res.redirect(`/animals/${req.params.animalId}`);
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAnimalMediaRouter };
