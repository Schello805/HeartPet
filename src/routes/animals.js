const express = require("express");

function createAnimalsRouter({ animalWorkspace, renderNotFound, renderSearchSuggestions, requireAdmin }) {
  const router = express.Router();

  router.get("/historie", (req, res) => res.render("pages/animals-index", animalWorkspace.buildWorkspace(req, "history")));
  router.get("/history", (req, res) => res.redirect("/animals/historie"));
  router.get("/ruhestaette", (req, res) => res.redirect("/animals/historie?status=Verstorben"));
  router.get("/ruhestatte", (req, res) => res.redirect("/animals/historie?status=Verstorben"));
  router.get("/", (req, res) => res.render("pages/animals-index", animalWorkspace.buildWorkspace(req, "active")));
  router.get("/suggest", renderSearchSuggestions);
  router.get("/systemlog", requireAdmin, (req, res) => res.redirect("/admin/systemlog"));
  router.get(/^\/(\d+)\/workspace-panel$/, (req, res) => {
    const animalId = req.params[0];
    const animalView = animalWorkspace.buildDetailView(animalId, req);
    if (!animalView) return renderNotFound(req, res, "Tier nicht gefunden.");
    return res.render("pages/animal-workspace-detail", {
      selectedAnimal: animalWorkspace.buildWorkspaceAnimal(animalView), selectedAnimalView: animalView,
    });
  });
  router.get(/^\/(\d+)$/, (req, res) => {
    const animalId = req.params[0];
    const animalView = animalWorkspace.buildDetailView(animalId, req);
    if (!animalView) return renderNotFound(req, res, "Tier nicht gefunden.");
    return res.render("pages/animal-show", { pageTitle: animalView.animal.name, ...animalView });
  });
  router.heartpetMountPath = "/animals";
  return router;
}

module.exports = { createAnimalsRouter };
