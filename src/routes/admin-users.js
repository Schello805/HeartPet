const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");

function createAdminUsersRouter({
  PASSWORD_HASH_ROUNDS,
  backTo,
  createAuditLog,
  db,
  normalizeUserPermissions,
  notifyAdminsAboutCreatedUser,
  redirectAfterPost,
  renderNotFound,
  requestEmailChangeConfirmation,
  requireAdmin,
  safeLocalReturnPath,
  sendInviteEmailForUser,
  setFlash,
  validateNewPassword,
}) {
  const router = express.Router();

  router.post("/admin/users", requireAdmin, async (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, backTo(req, "/admin/benutzer"));
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "viewer");

    if (!name || !email) {
      setFlash(req, "error", "Name und E-Mail sind Pflichtfelder.");
      return redirectAfterPost(res, returnTo);
    }

    const duplicate = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (duplicate) {
      setFlash(req, "error", "Diese E-Mail-Adresse wird bereits verwendet.");
      return redirectAfterPost(res, returnTo);
    }

    const randomPassword = crypto.randomBytes(24).toString("hex");
    const passwordHash = bcrypt.hashSync(randomPassword, PASSWORD_HASH_ROUNDS);
    const userPermissions = normalizeUserPermissions(role, req.body);
    const userResult = db.prepare(`
      INSERT INTO users (
        name, email, password_hash, role, must_change_password,
        can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
        can_manage_feedings, can_manage_notes, can_manage_reminders
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      email,
      passwordHash,
      role,
      1,
      userPermissions.can_edit_animals,
      userPermissions.can_manage_documents,
      userPermissions.can_manage_gallery,
      userPermissions.can_manage_health,
      userPermissions.can_manage_feedings,
      userPermissions.can_manage_notes,
      userPermissions.can_manage_reminders
    );
    createAuditLog(req, "user.create", { target_user_id: userResult.lastInsertRowid, role, email }, { entityType: "user", entityId: userResult.lastInsertRowid });

    await notifyAdminsAboutCreatedUser(req, {
      id: userResult.lastInsertRowid,
      name,
      email,
      role,
    });

    if (req.body.send_invite_email) {
      try {
        await sendInviteEmailForUser(req, {
          id: userResult.lastInsertRowid,
          name,
          email,
          role,
        });
        setFlash(req, "success", `Benutzer angelegt und Einladungs-Mail an ${email} versendet.`);
        return redirectAfterPost(res, returnTo);
      } catch (error) {
        console.error("[HeartPet] Einladungs-Mail fehlgeschlagen:", error.message);
        setFlash(req, "error", `Benutzer angelegt, Einladungs-Mail an ${email} fehlgeschlagen: ${error.message}`);
        return redirectAfterPost(res, returnTo);
      }
    }

    setFlash(req, "success", "Benutzer angelegt.");
    return redirectAfterPost(res, returnTo);
  });

  router.post("/admin/users/:id/resend-invite", requireAdmin, async (req, res) => {
    const returnTo = safeLocalReturnPath(req.body.return_to, backTo(req, "/admin/benutzer"));
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!user) {
      return renderNotFound(req, res, "Benutzer nicht gefunden.");
    }

    if (String(req.session.user.id) === String(req.params.id)) {
      setFlash(req, "error", "Für dein eigenes Konto ist hier keine Einladungs-Mail vorgesehen.");
      return redirectAfterPost(res, returnTo);
    }

    if (!user.must_change_password) {
      setFlash(req, "error", "Für diesen Nutzer ist aktuell keine offene Einladung mehr nötig.");
      return redirectAfterPost(res, returnTo);
    }

    try {
      await sendInviteEmailForUser(req, user, {
        auditSuccessAction: "user.invite_email_resent",
        auditFailureAction: "user.invite_email_resend_failed",
      });
      setFlash(req, "success", `Einladungs-Mail an ${user.email} erneut versendet.`);
    } catch (error) {
      console.error("[HeartPet] Erneuter Einladungs-Versand fehlgeschlagen:", error.message);
      setFlash(req, "error", `Einladungs-Mail an ${user.email} fehlgeschlagen: ${error.message}`);
    }

    return redirectAfterPost(res, returnTo);
  });

  router.post("/admin/users/:id/permissions", requireAdmin, (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!user) {
      return renderNotFound(req, res, "Benutzer nicht gefunden.");
    }

    if (String(req.session.user.id) === String(req.params.id)) {
      setFlash(req, "error", "Deinen eigenen Admin-Account verwaltest du im Profilbereich.");
      return res.redirect("/admin/benutzer");
    }

    const userPermissions = normalizeUserPermissions(req.body.role, req.body);
    db.prepare(`
      UPDATE users
      SET role = ?,
          can_edit_animals = ?,
          can_manage_documents = ?,
          can_manage_gallery = ?,
          can_manage_health = ?,
          can_manage_feedings = ?,
          can_manage_notes = ?,
          can_manage_reminders = ?
      WHERE id = ?
    `).run(
      req.body.role || user.role,
      userPermissions.can_edit_animals,
      userPermissions.can_manage_documents,
      userPermissions.can_manage_gallery,
      userPermissions.can_manage_health,
      userPermissions.can_manage_feedings,
      userPermissions.can_manage_notes,
      userPermissions.can_manage_reminders,
      req.params.id
    );
    createAuditLog(req, "user.permissions_update", { target_user_id: req.params.id, role: req.body.role || user.role }, { entityType: "user", entityId: req.params.id });

    setFlash(req, "success", "Benutzerrechte aktualisiert.");
    res.redirect("/admin/benutzer");
  });

  router.post("/admin/users/:id/update", requireAdmin, async (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!user) {
      return renderNotFound(req, res, "Benutzer nicht gefunden.");
    }

    if (String(req.session.user.id) === String(req.params.id)) {
      setFlash(req, "error", "Deinen eigenen Admin-Account verwaltest du im Profilbereich.");
      return res.redirect("/admin/benutzer");
    }

    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const emailChanged = email !== String(user.email || "").trim().toLowerCase();

    if (!name || !email) {
      setFlash(req, "error", "Name und E-Mail sind Pflichtfelder.");
      return res.redirect("/admin/benutzer");
    }

    if (emailChanged) {
      const duplicate = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, req.params.id);
      if (duplicate) {
        setFlash(req, "error", "Diese E-Mail-Adresse wird bereits verwendet.");
        return res.redirect("/admin/benutzer");
      }
    }

    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.params.id);

    if (emailChanged) {
      try {
        await requestEmailChangeConfirmation({
          userId: user.id,
          requestedByUserId: req.session.user.id,
          newEmail: email,
          displayName: name,
        });
        createAuditLog(req, "user.email_change_requested", { target_user_id: req.params.id, new_email: email }, { entityType: "user", entityId: req.params.id });
        setFlash(req, "success", `Name gespeichert. E-Mail-Änderung wurde an ${email} zur Bestätigung versendet.`);
      } catch (error) {
        setFlash(req, "error", `Name gespeichert, E-Mail-Änderung fehlgeschlagen: ${error.message}`);
      }
      return res.redirect("/admin/benutzer");
    }

    setFlash(req, "success", "Benutzerdaten aktualisiert.");
    createAuditLog(req, "user.profile_update", { target_user_id: req.params.id, name }, { entityType: "user", entityId: req.params.id });
    res.redirect("/admin/benutzer");
  });

  router.post("/admin/users/:id/save", requireAdmin, async (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!user) {
      return renderNotFound(req, res, "Benutzer nicht gefunden.");
    }

    if (String(req.session.user.id) === String(req.params.id)) {
      setFlash(req, "error", "Deinen eigenen Admin-Account verwaltest du im Profilbereich.");
      return res.redirect("/admin/benutzer");
    }

    const returnTo = safeLocalReturnPath(req.body.return_to, "/admin/benutzer");
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const nextRole = String(req.body.role || user.role || "viewer");

    if (!name || !email) {
      setFlash(req, "error", "Name und E-Mail sind Pflichtfelder.");
      return redirectAfterPost(res, returnTo);
    }

    const emailChanged = email !== String(user.email || "").trim().toLowerCase();
    if (emailChanged) {
      const duplicate = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, req.params.id);
      if (duplicate) {
        setFlash(req, "error", "Diese E-Mail-Adresse wird bereits verwendet.");
        return redirectAfterPost(res, returnTo);
      }
    }

    const userPermissions = normalizeUserPermissions(nextRole, req.body);
    db.prepare(`
      UPDATE users
      SET name = ?,
          role = ?,
          can_edit_animals = ?,
          can_manage_documents = ?,
          can_manage_gallery = ?,
          can_manage_health = ?,
          can_manage_feedings = ?,
          can_manage_notes = ?,
          can_manage_reminders = ?
      WHERE id = ?
    `).run(
      name,
      nextRole,
      userPermissions.can_edit_animals,
      userPermissions.can_manage_documents,
      userPermissions.can_manage_gallery,
      userPermissions.can_manage_health,
      userPermissions.can_manage_feedings,
      userPermissions.can_manage_notes,
      userPermissions.can_manage_reminders,
      req.params.id
    );

    if (emailChanged) {
      try {
        await requestEmailChangeConfirmation({
          userId: user.id,
          requestedByUserId: req.session.user.id,
          newEmail: email,
          displayName: name,
        });
        createAuditLog(req, "user.email_change_requested", { target_user_id: req.params.id, new_email: email, role: nextRole }, { entityType: "user", entityId: req.params.id });
        setFlash(req, "success", `Benutzer gespeichert. E-Mail-Änderung wurde an ${email} zur Bestätigung versendet.`);
        return redirectAfterPost(res, returnTo);
      } catch (error) {
        setFlash(req, "error", `Benutzer gespeichert, E-Mail-Änderung fehlgeschlagen: ${error.message}`);
        return redirectAfterPost(res, returnTo);
      }
    }

    createAuditLog(req, "user.full_update", { target_user_id: req.params.id, role: nextRole, name }, { entityType: "user", entityId: req.params.id });
    setFlash(req, "success", "Benutzer gespeichert.");
    return redirectAfterPost(res, returnTo);
  });

  router.post("/admin/users/:id/delete", requireAdmin, (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
    if (!user) {
      return renderNotFound(req, res, "Benutzer nicht gefunden.");
    }

    if (String(req.session.user.id) === String(req.params.id)) {
      setFlash(req, "error", "Dein eigenes Konto kann hier nicht gelöscht werden.");
      return res.redirect("/admin/benutzer");
    }

    if (user.role === "admin") {
      const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
      if (Number(adminCount) <= 1) {
        setFlash(req, "error", "Der letzte Admin kann nicht gelöscht werden.");
        return res.redirect("/admin/benutzer");
      }
    }

    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    createAuditLog(req, "user.delete", { target_user_id: req.params.id, email: user.email }, { entityType: "user", entityId: req.params.id });
    setFlash(req, "success", "Benutzer gelöscht.");
    res.redirect("/admin/benutzer");
  });

  router.post("/admin/profile", requireAdmin, async (req, res) => {
    if (!req.session.user) {
      return res.redirect("/login");
    }

    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const currentUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
    const emailChanged = email !== String(currentUser?.email || "").trim().toLowerCase();

    if (!name || !email) {
      setFlash(req, "error", "Name und E-Mail sind Pflichtfelder.");
      return res.redirect("/admin/benutzer");
    }

    if (emailChanged) {
      const duplicate = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(email, req.session.user.id);
      if (duplicate) {
        setFlash(req, "error", "Diese E-Mail-Adresse wird bereits verwendet.");
        return res.redirect("/admin/benutzer");
      }
    }

    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.session.user.id);
    req.session.user.name = name;

    if (emailChanged) {
      try {
        await requestEmailChangeConfirmation({
          userId: req.session.user.id,
          requestedByUserId: req.session.user.id,
          newEmail: email,
          displayName: name,
        });
        createAuditLog(req, "self.email_change_requested", { user_id: req.session.user.id, new_email: email }, { entityType: "user", entityId: req.session.user.id });
        setFlash(req, "success", `Profil gespeichert. E-Mail-Änderung wurde an ${email} zur Bestätigung versendet.`);
      } catch (error) {
        setFlash(req, "error", `Profil gespeichert, E-Mail-Änderung fehlgeschlagen: ${error.message}`);
      }
      return res.redirect("/admin/benutzer");
    }

    setFlash(req, "success", "Profil aktualisiert.");
    createAuditLog(req, "self.profile_update", { user_id: req.session.user.id, name }, { entityType: "user", entityId: req.session.user.id });
    res.redirect("/admin/benutzer");
  });

  router.post("/admin/password", async (req, res) => {
    if (!req.session.user) {
      return res.redirect("/login");
    }

    if (String(req.body.new_password || "") !== String(req.body.new_password_confirm || "")) {
      setFlash(req, "error", "Die neuen Passwörter stimmen nicht überein.");
      return res.redirect("/admin/benutzer");
    }
    const passwordError = await validateNewPassword(req.body.new_password);
    if (passwordError) {
      setFlash(req, "error", passwordError);
      return res.redirect("/admin/benutzer");
    }

    const currentUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
    if (!currentUser || !bcrypt.compareSync(req.body.current_password, currentUser.password_hash)) {
      setFlash(req, "error", "Aktuelles Passwort ist nicht korrekt.");
      return res.redirect("/admin/benutzer");
    }

    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?")
      .run(bcrypt.hashSync(req.body.new_password, PASSWORD_HASH_ROUNDS), currentUser.id);

    req.session.user.mustChangePassword = false;
    req.session.user.sessionVersion = Number(currentUser.session_version || 0) + 1;
    createAuditLog(req, "self.password_change", { user_id: currentUser.id }, { entityType: "user", entityId: currentUser.id });
    setFlash(req, "success", "Passwort wurde aktualisiert.");
    res.redirect("/admin/benutzer");
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAdminUsersRouter };
