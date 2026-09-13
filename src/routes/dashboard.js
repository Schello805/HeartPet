const express = require("express");

function createDashboardRouter({ dashboard, search }) {
  const router = express.Router();
  const renderSuggestions = (req, res) => {
    const results = search.search(req.query.q).slice(0, 12).map((item) => ({ ...item, when: item.when || "" }));
    return res.json({ results });
  };

  router.get("/", async (req, res) => res.render("pages/dashboard", await dashboard.buildView(req.query.q)));
  router.get("/suche", (req, res) => {
    const q = String(req.query.q || "").trim();
    return res.redirect(q ? `/?q=${encodeURIComponent(q)}` : "/");
  });
  router.get("/api/species/search", (req, res) => res.json({ results: search.searchSpecies(req.query.q) }));
  ["/admin/suggest", "/animals/suggest", "/api/search/suggest", "/api/suggest", "/search/suggest", "/suggest"].forEach((path) => router.get(path, renderSuggestions));
  router.get(/^\/.+\/suggest$/, renderSuggestions);
  router.heartpetMountPath = "";
  return router;
}

module.exports = { createDashboardRouter };
