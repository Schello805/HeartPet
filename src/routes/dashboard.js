const express = require("express");
const sharp = require("sharp");

function createDashboardRouter({ dashboard, search, db }) {
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
  router.get("/api/breed-images/:id", async (req, res) => {
    const breed = db.prepare("SELECT image_url, source FROM species_breeds WHERE id = ?").get(req.params.id);
    if (!breed?.image_url) return res.sendStatus(404);
    const allowedHosts = { dogapi: "images.dogapi.dog", thecatapi: "cdn2.thecatapi.com", chickenapi: "qwex.co" };
    let url;
    try { url = new URL(breed.image_url); } catch { return res.sendStatus(404); }
    if (url.protocol !== "https:" || url.hostname !== allowedHosts[breed.source]) return res.sendStatus(404);
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
      const type = response.headers.get("content-type")?.split(";")[0];
      if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(type)) return res.sendStatus(502);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) return res.sendStatus(502);
        chunks.push(chunk);
      }
      const preview = await sharp(Buffer.concat(chunks), { limitInputPixels: 16_000_000 })
        .resize({ width: 400, height: 300, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 74 })
        .toBuffer();
      res.set("Cache-Control", "private, max-age=86400");
      res.type("image/webp").send(preview);
    } catch {
      res.sendStatus(502);
    }
  });
  ["/admin/suggest", "/animals/suggest", "/api/search/suggest", "/api/suggest", "/search/suggest", "/suggest"].forEach((path) => router.get(path, renderSuggestions));
  router.get(/^\/.+\/suggest$/, renderSuggestions);
  router.heartpetMountPath = "";
  return router;
}

module.exports = { createDashboardRouter };
