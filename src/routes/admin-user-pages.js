const express = require("express");

function createAdminUserPagesRouter({
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

  router.get("/admin/benutzer", requireAdmin, (req, res) => {
    const viewData = getAdminViewData("Benutzer", "/admin/benutzer");
    viewData.selfUser = db.prepare(`
      SELECT id, name, email, role, must_change_password, last_login_at, last_seen_at, last_logout_at,
        CASE
          WHEN last_seen_at IS NOT NULL
            AND datetime(last_seen_at) >= datetime('now', '-5 minutes')
            AND (last_logout_at IS NULL OR datetime(last_seen_at) > datetime(last_logout_at))
          THEN 1 ELSE 0
        END AS is_online
      FROM users
      WHERE id = ?
    `).get(req.session.user.id);
    viewData.users = (viewData.users || []).filter((user) => String(user.id) !== String(req.session.user.id));
    res.render("pages/admin-users", viewData);
  });

  ["/admin/users", "/admin/user-management"].forEach((aliasPath) => {
    router.get(aliasPath, requireAdmin, (req, res) => {
      const suffix = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
      res.redirect(`/admin/benutzer${suffix}`);
    });
  });

  router.get("/admin/users/new", requireAdmin, (req, res) => {
    if (!isDrawerRequest(req)) {
      return redirectDocumentDrawerRequest(req, res, "/admin/benutzer");
    }
    res.render("pages/admin-user-drawer", {
      pageTitle: "Benutzer anlegen",
      mode: "create",
      item: null,
      returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/benutzer")),
    });
  });

  router.get("/admin/benutzer/neu", requireAdmin, (req, res) => {
    const query = new URLSearchParams();
    const returnTo = safeLocalReturnPath(req.query.return_to, "");
    if (returnTo) {
      query.set("return_to", returnTo);
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    res.redirect(`/admin/users/new${suffix}`);
  });

  router.get("/admin/users/:id/edit", requireAdmin, (req, res) => {
    if (!isDrawerRequest(req)) {
      return redirectDocumentDrawerRequest(req, res, "/admin/benutzer");
    }
    const item = db.prepare(`
      SELECT
        id, name, email, role, must_change_password,
        can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
        can_manage_feedings, can_manage_notes, can_manage_reminders
      FROM users
      WHERE id = ?
    `).get(req.params.id);
    if (!item) {
      return renderNotFound(req, res, "Benutzer nicht gefunden.");
    }

    if (String(req.session.user.id) === String(req.params.id)) {
      setFlash(req, "error", "Deinen eigenen Admin-Account verwaltest du im Profilbereich.");
      return res.redirect("/admin/benutzer");
    }

    res.render("pages/admin-user-drawer", {
      pageTitle: "Benutzer bearbeiten",
      mode: "edit",
      item,
      returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/benutzer")),
    });
  });

  router.get("/admin/users/:id/update", requireAdmin, (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(req, res, "/admin/benutzer", `/admin/users/${req.params.id}/edit`);
  });

  router.get("/admin/users/:id/save", requireAdmin, (req, res) => {
    setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
    redirectDocumentDrawerRequest(req, res, "/admin/benutzer", `/admin/users/${req.params.id}/edit`);
  });

  router.get("/admin/import", requireAdmin, (req, res) => {
    res.render("pages/admin-import", getAdminViewData("Import", "/admin/import"));
  });

  router.get("/admin/imports", requireAdmin, (req, res) => {
    const suffix = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    res.redirect(`/admin/import${suffix}`);
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAdminUserPagesRouter };
