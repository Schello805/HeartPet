const express = require("express");

function createMasterdataRouter({
  backTo,
  createAuditLog,
  db,
  FIELD_SCHEMAS,
  getSettingsObject,
  getAdminViewData,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  renderNotFound,
  redirectAfterPost,
  requireAdmin,
  safeLocalReturnPath,
  setFlash,
  upsertSetting,
  validateText,
  normalizeVeterinarianPayload,
  validateVeterinarian,
}) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get("/stammdaten", (req, res) => {
    const viewData = getAdminViewData("Stammdaten", "/admin/stammdaten");
    viewData.masterEdit = {
      categoryId: Number(req.query.editCategory || 0) || null,
      speciesId: Number(req.query.editSpecies || 0) || null,
      veterinarianId: Number(req.query.editVeterinarian || 0) || null,
      vaccinationPresetId: Number(req.query.editVaccinationPreset || 0) || null,
    };
    res.render("pages/admin-masterdata", viewData);
  });

  ["/masterdata", "/master-data"].forEach((aliasPath) => {
    router.get(aliasPath, (req, res) => {
      const suffix = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      res.redirect(`/admin/stammdaten${suffix}`);
    });
  });

  const drawer = (entityType, title, loadItem, loadOptions = () => ({})) => (req, res) => {
    if (!isDrawerRequest(req)) return redirectDocumentDrawerRequest(req, res, "/admin/stammdaten");
    const item = loadItem ? loadItem(req.params.id) : null;
    if (loadItem && !item) return renderNotFound(req, res, `${title.replace(" bearbeiten", "")} nicht gefunden.`);
    return res.render("pages/admin-masterdata-drawer", {
      pageTitle: title,
      entityType,
      item,
      veterinarians: [],
      returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/stammdaten")),
      ...loadOptions(),
    });
  };

  router.get("/categories/new", drawer("category", "Neue Dokumentkategorie"));
  router.get("/categories/:id/edit", drawer("category", "Dokumentkategorie bearbeiten", (id) => db.prepare("SELECT * FROM document_categories WHERE id = ?").get(id)));
  router.get("/veterinarians/new", drawer("veterinarian", "Neuer Tierarzt"));
  router.get("/veterinarians/:id/edit", drawer("veterinarian", "Tierarzt bearbeiten", (id) => db.prepare("SELECT * FROM veterinarians WHERE id = ?").get(id)));
  router.get("/species/new", drawer("species", "Neue Tierart", null, () => ({ veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all() })));
  router.get("/species/:id/edit", drawer("species", "Tierart bearbeiten", (id) => db.prepare("SELECT * FROM species WHERE id = ?").get(id), () => ({ veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all() })));
  router.get("/vaccination-presets/new", drawer("vaccinationPreset", "Neue Standardimpfung", null, () => ({ species: db.prepare("SELECT * FROM species ORDER BY name").all() })));
  router.get("/vaccination-presets/:id/edit", drawer("vaccinationPreset", "Standardimpfung bearbeiten", (id) => db.prepare("SELECT * FROM vaccination_presets WHERE id = ?").get(id), () => ({ species: db.prepare("SELECT * FROM species ORDER BY name").all() })));

  ["categories", "species", "veterinarians", "vaccination-presets"].forEach((entity) => {
    router.get(`/${entity}/:id/update`, (req, res) => {
      setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
      redirectDocumentDrawerRequest(req, res, "/admin/stammdaten", `/admin/${entity}/${req.params.id}/edit`);
    });
  });

  const returnPath = (req) => safeLocalReturnPath(req.body?.return_to, backTo(req, "/admin/stammdaten"));
  const validationFailure = (req, res, message) => {
    setFlash(req, "error", message);
    return redirectAfterPost(res, returnPath(req));
  };

  router.post("/categories", (req, res) => {
    const error = validateText(req.body?.name, FIELD_SCHEMAS.categoryName, "Name");
    if (error) return validationFailure(req, res, error);
    const name = String(req.body.name).trim();
    try {
      const result = db.prepare("INSERT INTO document_categories (name, is_required) VALUES (?, ?)")
        .run(name, req.body.is_required ? 1 : 0);
      createAuditLog(req, "category.create", { category_id: result.lastInsertRowid, name, is_required: Boolean(req.body.is_required) }, { entityType: "category", entityId: result.lastInsertRowid });
      setFlash(req, "success", "Dokumentkategorie angelegt.");
    } catch {
      setFlash(req, "error", "Dokumentkategorie konnte nicht angelegt werden (Name ggf. bereits vorhanden).");
    }
    return redirectAfterPost(res, returnPath(req));
  });

  router.post("/categories/:id/update", (req, res) => {
    const error = validateText(req.body?.name, FIELD_SCHEMAS.categoryName, "Name");
    if (error) return validationFailure(req, res, error);
    const name = String(req.body.name).trim();
    try {
      const existing = db.prepare("SELECT * FROM document_categories WHERE id = ?").get(req.params.id);
      db.prepare("UPDATE document_categories SET name = ?, is_required = ? WHERE id = ?")
        .run(name, req.body.is_required ? 1 : 0, req.params.id);
      createAuditLog(req, "category.update", { category_id: req.params.id, name, previous_name: existing?.name || "", is_required: Boolean(req.body.is_required) }, { entityType: "category", entityId: req.params.id });
      setFlash(req, "success", "Dokumentkategorie aktualisiert.");
    } catch {
      setFlash(req, "error", "Dokumentkategorie konnte nicht aktualisiert werden.");
    }
    return redirectAfterPost(res, returnPath(req));
  });

  router.post("/categories/:id/delete", (req, res) => {
    const item = db.prepare("SELECT * FROM document_categories WHERE id = ?").get(req.params.id);
    db.prepare("DELETE FROM document_categories WHERE id = ?").run(req.params.id);
    createAuditLog(req, "category.delete", { category_id: req.params.id, name: item?.name || "" }, { entityType: "category", entityId: req.params.id });
    setFlash(req, "success", "Dokumentkategorie entfernt.");
    res.redirect(backTo(req, "/admin/stammdaten"));
  });

  router.post("/species", (req, res) => {
    const error = validateText(req.body?.name, FIELD_SCHEMAS.speciesName, "Tierart");
    if (error) return validationFailure(req, res, error);
    const name = String(req.body.name).trim();
    try {
      const result = db.prepare("INSERT INTO species (name, default_veterinarian_id, notes) VALUES (?, ?, ?)")
        .run(name, req.body.default_veterinarian_id || null, String(req.body.notes || "").trim());
      createAuditLog(req, "species.create", { species_id: result.lastInsertRowid, name, default_veterinarian_id: req.body.default_veterinarian_id || null }, { entityType: "species", entityId: result.lastInsertRowid });
      setFlash(req, "success", "Tierart angelegt.");
    } catch {
      setFlash(req, "error", "Tierart konnte nicht angelegt werden (Name ggf. bereits vorhanden).");
    }
    return redirectAfterPost(res, returnPath(req));
  });

  router.post("/species/:id/update", (req, res) => {
    const error = validateText(req.body?.name, FIELD_SCHEMAS.speciesName, "Tierart");
    if (error) return validationFailure(req, res, error);
    const name = String(req.body.name).trim();
    try {
      const existing = db.prepare("SELECT * FROM species WHERE id = ?").get(req.params.id);
      db.prepare("UPDATE species SET name = ?, default_veterinarian_id = ?, notes = ? WHERE id = ?")
        .run(name, req.body.default_veterinarian_id || null, String(req.body.notes || "").trim(), req.params.id);
      createAuditLog(req, "species.update", { species_id: req.params.id, name, previous_name: existing?.name || "", default_veterinarian_id: req.body.default_veterinarian_id || null }, { entityType: "species", entityId: req.params.id });
      setFlash(req, "success", "Tierart aktualisiert.");
    } catch {
      setFlash(req, "error", "Tierart konnte nicht aktualisiert werden.");
    }
    return redirectAfterPost(res, returnPath(req));
  });

  router.post("/species/:id/delete", (req, res) => {
    const item = db.prepare("SELECT * FROM species WHERE id = ?").get(req.params.id);
    db.prepare("DELETE FROM species WHERE id = ?").run(req.params.id);
    createAuditLog(req, "species.delete", { species_id: req.params.id, name: item?.name || "" }, { entityType: "species", entityId: req.params.id });
    setFlash(req, "success", "Tierart entfernt.");
    res.redirect(backTo(req, "/admin/stammdaten"));
  });

  router.post("/vaccination-presets", (req, res) => saveVaccinationPreset(req, res));
  router.post("/vaccination-presets/:id/update", (req, res) => saveVaccinationPreset(req, res, req.params.id));
  router.post("/vaccination-presets/:id/delete", (req, res) => {
    const item = db.prepare("SELECT * FROM vaccination_presets WHERE id = ?").get(req.params.id);
    db.prepare("DELETE FROM vaccination_presets WHERE id = ?").run(req.params.id);
    createAuditLog(req, "vaccination_preset.delete", { species_name: item?.species_name || "", name: item?.name || "" }, { entityType: "vaccination_preset", entityId: req.params.id });
    setFlash(req, "success", "Standardimpfung entfernt.");
    res.redirect(backTo(req, "/admin/stammdaten"));
  });

  function saveVaccinationPreset(req, res, id = null) {
    const speciesName = String(req.body?.species_name || "").trim();
    const name = String(req.body?.name || "").trim();
    const error = validateText(speciesName, FIELD_SCHEMAS.speciesName, "Tierart")
      || validateText(name, FIELD_SCHEMAS.vaccinationName, "Impfung");
    if (error) return validationFailure(req, res, error);
    try {
      if (id) {
        db.prepare("UPDATE vaccination_presets SET species_name = ?, name = ? WHERE id = ?").run(speciesName, name, id);
        createAuditLog(req, "vaccination_preset.update", { species_name: speciesName, name }, { entityType: "vaccination_preset", entityId: id });
        setFlash(req, "success", "Standardimpfung aktualisiert.");
      } else {
        const result = db.prepare("INSERT INTO vaccination_presets (species_name, name) VALUES (?, ?)").run(speciesName, name);
        createAuditLog(req, "vaccination_preset.create", { species_name: speciesName, name }, { entityType: "vaccination_preset", entityId: result.lastInsertRowid });
        setFlash(req, "success", "Standardimpfung angelegt.");
      }
    } catch {
      setFlash(req, "error", id ? "Standardimpfung konnte nicht aktualisiert werden." : "Standardimpfung konnte nicht angelegt werden (Eintrag ggf. bereits vorhanden).");
    }
    return redirectAfterPost(res, returnPath(req));
  }

  router.post("/veterinarians", (req, res) => saveVeterinarian(req, res));
  router.post("/veterinarians/:id/update", (req, res) => saveVeterinarian(req, res, req.params.id));

  function saveVeterinarian(req, res, id = null) {
    const payload = normalizeVeterinarianPayload(req.body);
    const error = validateVeterinarian(payload, req.body?.name);
    if (error) return validationFailure(req, res, error);
    const name = String(req.body.name).trim();
    try {
      const existing = id ? db.prepare("SELECT * FROM veterinarians WHERE id = ?").get(id) : null;
      let entityId = id;
      if (id) {
        db.prepare("UPDATE veterinarians SET name = ?, street = ?, postal_code = ?, city = ?, country = ?, email = ?, phone = ?, notes = ? WHERE id = ?")
          .run(name, payload.street, payload.postal_code, payload.city, payload.country, payload.email, payload.phone, payload.notes, id);
      } else {
        entityId = db.prepare("INSERT INTO veterinarians (name, street, postal_code, city, country, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(name, payload.street, payload.postal_code, payload.city, payload.country, payload.email, payload.phone, payload.notes).lastInsertRowid;
      }
      createAuditLog(req, id ? "veterinarian.update" : "veterinarian.create", {
        veterinarian_id: entityId, name, previous_name: existing?.name || "", city: payload.city, email: payload.email, phone: payload.phone,
      }, { entityType: "veterinarian", entityId });
      setFlash(req, "success", id ? "Tierarzt aktualisiert." : "Tierarzt gespeichert.");
    } catch {
      setFlash(req, "error", id ? "Tierarzt konnte nicht aktualisiert werden." : "Tierarzt konnte nicht gespeichert werden.");
    }
    return redirectAfterPost(res, returnPath(req));
  }

  router.post("/veterinarians/:id/set-default", (req, res) => {
    const item = db.prepare("SELECT id, name FROM veterinarians WHERE id = ?").get(req.params.id);
    if (!item) return validationFailure(req, res, "Tierarzt nicht gefunden.");
    upsertSetting(db, "default_veterinarian_id", String(item.id));
    createAuditLog(req, "veterinarian.set_default", { veterinarian_id: item.id, name: item.name || "" }, { entityType: "veterinarian", entityId: item.id });
    setFlash(req, "success", "Standardtierarzt gesetzt.");
    res.redirect(backTo(req, "/admin/stammdaten"));
  });

  router.post("/veterinarians/:id/delete", (req, res) => {
    const item = db.prepare("SELECT * FROM veterinarians WHERE id = ?").get(req.params.id);
    if (String(getSettingsObject(db).default_veterinarian_id || "") === String(req.params.id)) upsertSetting(db, "default_veterinarian_id", "");
    db.prepare("DELETE FROM veterinarians WHERE id = ?").run(req.params.id);
    createAuditLog(req, "veterinarian.delete", { veterinarian_id: req.params.id, name: item?.name || "" }, { entityType: "veterinarian", entityId: req.params.id });
    setFlash(req, "success", "Tierarzt entfernt.");
    res.redirect(backTo(req, "/admin/stammdaten"));
  });

  return router;
}

module.exports = { createMasterdataRouter };
