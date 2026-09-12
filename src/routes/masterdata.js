const express = require("express");

function createMasterdataRouter({
  backTo,
  db,
  getAdminViewData,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  renderNotFound,
  requireAdmin,
  safeLocalReturnPath,
  setFlash,
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

  return router;
}

module.exports = { createMasterdataRouter };
