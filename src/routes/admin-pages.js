const express = require("express");

function createAdminPagesRouter({
  captureCameraFrame,
  getAdminViewData,
  isCameraUrl,
  isRtspUrl,
  normalizeConfiguredUrl,
  requireAdmin,
}) {
  const router = express.Router();

  router.get("/admin", requireAdmin, (req, res) => {
    res.redirect("/admin/allgemein");
  });

  router.get("/admin/allgemein", requireAdmin, (req, res) => {
    res.render("pages/admin-general", getAdminViewData("Allgemein", "/admin/allgemein"));
  });

  router.get("/admin/stall", requireAdmin, (req, res) => {
    res.render("pages/admin-general", getAdminViewData("Stall", "/admin/stall"));
  });

  router.post("/admin/coop/camera-preview", requireAdmin, async (req, res) => {
    const url = normalizeConfiguredUrl(req.body.url);
    if (!isCameraUrl(url)) {
      return res.status(400).send("Bitte eine vollständige HTTP-, HTTPS- oder RTSP-URL eingeben.");
    }

    try {
      const buffer = await captureCameraFrame({
        name: "Vorschau",
        url,
        protocol: isRtspUrl(url) ? "rtsp" : "http",
      });
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "no-store");
      return res.send(buffer);
    } catch (error) {
      console.error(`[HeartPet] Kamera-Vorschau fehlgeschlagen: ${error.message}`);
      return res.status(502).send(error.message);
    }
  });

  ["/admin/general", "/admin/settings"].forEach((aliasPath) => {
    router.get(aliasPath, requireAdmin, (req, res) => {
      const suffix = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
      res.redirect(`/admin/allgemein${suffix}`);
    });
  });

  router.get("/admin/kommunikation", requireAdmin, (req, res) => {
    res.redirect("/admin/benachrichtigungen");
  });

  router.get("/admin/benachrichtigungen", requireAdmin, (req, res) => {
    res.render("pages/admin-communication", getAdminViewData("Benachrichtigungen", "/admin/benachrichtigungen"));
  });

  ["/benachrichtigungen", "/admin/notifications", "/notifications"].forEach((aliasPath) => {
    router.get(aliasPath, requireAdmin, (req, res) => {
      res.redirect("/admin/benachrichtigungen");
    });
  });
  router.get(/^\/.+\/benachrichtigungen$/, requireAdmin, (req, res) => {
    res.redirect("/admin/benachrichtigungen");
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAdminPagesRouter };
