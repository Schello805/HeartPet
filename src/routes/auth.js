const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const dayjs = require("dayjs");

function createAuthRouter({
  db, isSetupComplete, setFlash, validateNewPassword, normalizeVeterinarianPayload,
  validateVeterinarian, passwordHashRounds, ensureSpeciesExists, upsertSetting,
  regenerateSession, safeLocalReturnPath, loginAttempts, userPresenceWrites, requireAuth,
  passwordResetAttempts, getSettingsObject, resolveAppBaseUrl, sendPasswordResetEmail,
  createNotificationLog, createAuditLog, normalizeAppBaseUrl,
}) {
  const router = express.Router();
  const PASSWORD_HASH_ROUNDS = passwordHashRounds;

  router.get("/setup", (req, res) => {
    res.render("pages/setup", {
      pageTitle: "Ersteinrichtung",
      species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    });
  });

  router.get("/setup/complete", (req, res) => {
    if (!isSetupComplete()) return res.redirect("/setup");
    if (!req.session?.user) return res.redirect("/login?return_to=%2Fsetup%2Fcomplete");

    const settings = getSettingsObject(db);
    const appBaseUrl = resolveAppBaseUrl(settings);
    const currentUrl = `${req.protocol}://${req.get("host")}`;
    const accessMode = settings.access_mode === "domain" ? "domain" : "lan";
    let addressMatches = accessMode === "lan";
    if (accessMode === "domain") {
      try {
        const expected = new URL(appBaseUrl);
        const current = new URL(currentUrl);
        addressMatches = expected.protocol === current.protocol && expected.host === current.host;
      } catch {
        addressMatches = false;
      }
    }

    res.render("pages/setup-complete", {
      pageTitle: "Einrichtung abgeschlossen",
      accessMode,
      appBaseUrl,
      currentUrl,
      addressMatches,
      animalId: Number(req.query.animal_id || 0) || null,
    });
  });
  
  router.post("/setup", async (req, res) => {
    if (isSetupComplete()) {
      return res.redirect(req.session?.user ? "/" : "/login");
    }
  
    const body = req.body || {};
    const adminName = String(body.admin_name || "").trim();
    const adminEmail = String(body.admin_email || "").trim().toLowerCase();
    const adminPassword = String(body.admin_password || "");
    const organizationName = String(body.organization_name || "").trim();
    const accessMode = body.access_mode === "domain" ? "domain" : "lan";
    const submittedAppDomain = String(body.app_domain || "").trim();
    const appDomain = accessMode === "domain" ? normalizeAppBaseUrl(submittedAppDomain) : "";
    const veterinarianName = String(body.veterinarian_name || "").trim();
    const animalName = String(body.animal_name || "").trim();
    const speciesName = String(body.species_name || "").trim();
  
    if (!adminName || !adminEmail || !adminPassword) {
      setFlash(req, "error", "Bitte fülle die Pflichtfelder für den Administrator aus.");
      return res.redirect("/setup");
    }

    if ((animalName && !speciesName) || (!animalName && speciesName)) {
      setFlash(req, "error", "Für das erste Tier müssen Name und Tierart gemeinsam angegeben werden.");
      return res.redirect("/setup");
    }

    if (accessMode === "domain" && (!appDomain || !appDomain.startsWith("https://"))) {
      setFlash(req, "error", "Für den Domainbetrieb ist eine gültige HTTPS-Adresse ohne Pfad erforderlich.");
      return res.redirect("/setup");
    }
  
    const passwordError = await validateNewPassword(adminPassword);
    if (passwordError) {
      setFlash(req, "error", passwordError);
      return res.redirect("/setup");
    }
  
    const duplicateUser = db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail);
    if (duplicateUser) {
      setFlash(req, "error", "Diese E-Mail-Adresse ist bereits vergeben.");
      return res.redirect("/setup");
    }
  
    let veterinarianPayload = null;
    if (veterinarianName) {
      veterinarianPayload = normalizeVeterinarianPayload(body, "veterinarian_");
      const addressError = validateVeterinarian(veterinarianPayload, body.veterinarian_name);
      if (addressError) {
        setFlash(req, "error", addressError);
        return res.redirect("/setup");
      }
    }
  
    const setupTx = db.transaction(() => {
      const userResult = db.prepare(`
        INSERT INTO users (
          name, email, password_hash, role, must_change_password,
          can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
          can_manage_feedings, can_manage_notes, can_manage_reminders
        )
        VALUES (?, ?, ?, 'admin', 0, 1, 1, 1, 1, 1, 1, 1)
      `).run(adminName, adminEmail, bcrypt.hashSync(adminPassword, PASSWORD_HASH_ROUNDS));
  
      let veterinarianId = null;
      if (veterinarianPayload) {
        veterinarianId = db.prepare(`
          INSERT INTO veterinarians (name, street, postal_code, city, country, email, phone, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          veterinarianName,
          veterinarianPayload.street,
          veterinarianPayload.postal_code,
          veterinarianPayload.city,
          veterinarianPayload.country,
          veterinarianPayload.email,
          veterinarianPayload.phone,
          veterinarianPayload.notes
        ).lastInsertRowid;
      }

      let animalId = null;
      if (animalName && speciesName) {
        const species = ensureSpeciesExists(speciesName);
        animalId = db.prepare(`
          INSERT INTO animals (
            name, species_id, sex, birth_date, intake_date, source, microchip_number,
            status, color, breed, weight_kg, veterinarian_id, notes, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Aktiv', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          animalName,
          species.id,
          body.animal_sex || "",
          body.animal_birth_date || null,
          body.animal_intake_date || dayjs().format("YYYY-MM-DD"),
          body.animal_source || "",
          body.animal_microchip_number || "",
          body.animal_color || "",
          body.animal_breed || "",
          body.animal_weight_kg || null,
          veterinarianId,
          body.animal_notes || ""
        ).lastInsertRowid;
      }
  
      if (organizationName) {
        upsertSetting(db, "organization_name", organizationName);
      }
      upsertSetting(db, "access_mode", accessMode);
      upsertSetting(db, "app_domain", appDomain);
      upsertSetting(db, "setup_complete", "true");
  
      return {
        userId: userResult.lastInsertRowid,
        animalId,
      };
    });
  
    const result = setupTx();
    await regenerateSession(req);
    req.session.user = {
      id: result.userId,
      name: adminName,
      email: adminEmail,
      role: "admin",
      mustChangePassword: false,
      sessionVersion: 0,
    };
  
    setFlash(req, "success", "Ersteinrichtung abgeschlossen.");
    const animalQuery = result.animalId ? `?animal_id=${result.animalId}` : "";
    res.redirect(`/setup/complete${animalQuery}`);
  });
  
  router.get("/login", (req, res) => {
    const returnTo = safeLocalReturnPath(req.query.return_to, "");
    if (req.session?.user) {
      return res.redirect(returnTo || "/");
    }
  
    res.render("pages/login", { pageTitle: "Login", returnTo });
  });
  
  router.post("/login", async (req, res) => {
    const body = req.body || {};
    const returnTo = safeLocalReturnPath(body.return_to || req.query.return_to, "");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const attemptKey = `${req.ip}|${email}`;
    if (loginAttempts.size > 1000) {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [key, value] of loginAttempts) {
        if (Number(value.updatedAt || 0) < cutoff || loginAttempts.size > 1000) loginAttempts.delete(key);
      }
    }
    const attempt = loginAttempts.get(attemptKey);
    if (attempt?.blockedUntil > Date.now()) {
      setFlash(req, "error", "Zu viele fehlgeschlagene Anmeldeversuche. Bitte warte 15 Minuten.");
      return res.redirect("/login");
    }
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      const failures = Number(attempt?.failures || 0) + 1;
      loginAttempts.set(attemptKey, { failures, blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0, updatedAt: Date.now() });
      setFlash(req, "error", "Login fehlgeschlagen. Bitte prüfe E-Mail und Passwort.");
      return res.redirect("/login");
    }
  
    if (user.must_change_password) {
      setFlash(req, "error", "Bitte zuerst über den Einladungslink ein Passwort festlegen.");
      return res.redirect("/login");
    }
  
    loginAttempts.delete(attemptKey);
    db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP, last_logout_at = NULL WHERE id = ?").run(user.id);
    userPresenceWrites.set(user.id, Date.now());
  
    await regenerateSession(req);
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword: Boolean(user.must_change_password),
      sessionVersion: Number(user.session_version || 0),
    };
  
    setFlash(req, "success", "Login erfolgreich.");
    res.redirect(returnTo || "/");
  });
  
  router.post("/logout", requireAuth, (req, res) => {
    db.prepare("UPDATE users SET last_logout_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.session.user.id);
    userPresenceWrites.delete(req.session.user.id);
    req.session.destroy(() => {
      res.redirect("/login");
    });
  });
  
  router.get("/password-forgot", (req, res) => {
    if (req.session?.user) return res.redirect("/");
    res.render("pages/password-forgot", { pageTitle: "Passwort vergessen" });
  });
  
  router.post("/password-forgot", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const attemptKey = `${req.ip}|${email}`;
    const now = Date.now();
    if (passwordResetAttempts.size > 1000) {
      for (const [key, timestamps] of passwordResetAttempts) {
        const active = timestamps.filter((timestamp) => now - timestamp < 60 * 60 * 1000);
        if (active.length) passwordResetAttempts.set(key, active);
        else passwordResetAttempts.delete(key);
      }
    }
    const recentAttempts = (passwordResetAttempts.get(attemptKey) || []).filter((timestamp) => now - timestamp < 60 * 60 * 1000);
    if (recentAttempts.length < 3) {
      recentAttempts.push(now);
      passwordResetAttempts.set(attemptKey, recentAttempts);
      const user = db.prepare("SELECT id, name, email FROM users WHERE email = ?").get(email);
      if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const settings = getSettingsObject(db);
        const resetUrl = `${resolveAppBaseUrl(settings)}/password-reset?token=${encodeURIComponent(token)}`;
        db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL").run(user.id);
        db.prepare("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+30 minutes'))").run(user.id, tokenHash);
        try {
          await sendPasswordResetEmail(settings, { recipient: user.email, name: user.name, resetUrl });
          createNotificationLog({ userId: user.id, channel: "email", type: "password_reset", recipient: user.email, subject: "Passwort zurücksetzen", status: "sent" });
          createAuditLog(req, "user.password_reset_requested", {}, { entityType: "user", entityId: user.id });
        } catch (error) {
          db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
          createNotificationLog({ userId: user.id, channel: "email", type: "password_reset", recipient: user.email, subject: "Passwort zurücksetzen", status: "error", error: error.message });
          console.error("[HeartPet] Passwort-Reset-Mail fehlgeschlagen:", error.message);
        }
      }
    }
    setFlash(req, "success", "Falls ein Konto mit dieser E-Mail-Adresse existiert, wurde ein Link zum Zurücksetzen versendet.");
    res.redirect("/login");
  });
  
  router.get("/password-reset", (req, res) => {
    const token = String(req.query.token || "").trim();
    const tokenHash = token ? crypto.createHash("sha256").update(token).digest("hex") : "";
    const reset = tokenHash ? db.prepare(`
      SELECT id FROM password_reset_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at >= CURRENT_TIMESTAMP
    `).get(tokenHash) : null;
    res.status(reset ? 200 : 400).render("pages/password-reset", {
      pageTitle: "Neues Passwort",
      token,
      valid: Boolean(reset),
    });
  });
  
  router.post("/password-reset", async (req, res) => {
    const token = String(req.body.token || "").trim();
    const redirectUrl = `/password-reset?token=${encodeURIComponent(token)}`;
    if (String(req.body.new_password || "") !== String(req.body.new_password_confirm || "")) {
      setFlash(req, "error", "Die neuen Passwörter stimmen nicht überein.");
      return res.redirect(redirectUrl);
    }
    const passwordError = await validateNewPassword(req.body.new_password);
    if (passwordError) {
      setFlash(req, "error", passwordError);
      return res.redirect(redirectUrl);
    }
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const reset = db.prepare(`
      SELECT * FROM password_reset_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at >= CURRENT_TIMESTAMP
    `).get(tokenHash);
    if (!reset) {
      setFlash(req, "error", "Der Link ist ungültig oder abgelaufen.");
      return res.redirect("/password-forgot");
    }
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?")
        .run(bcrypt.hashSync(req.body.new_password, PASSWORD_HASH_ROUNDS), reset.user_id);
      db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(reset.id);
      db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").run(reset.user_id);
    })();
    userPresenceWrites.delete(reset.user_id);
    createAuditLog(req, "user.password_reset_completed", {}, { entityType: "user", entityId: reset.user_id });
    setFlash(req, "success", "Passwort gespeichert. Du kannst dich jetzt anmelden.");
    return res.redirect("/login");
  });
  
  router.get("/email-change/confirm", (req, res) => {
    const token = String(req.query.token || "").trim();
    if (!token) {
      setFlash(req, "error", "Ungültiger Bestätigungslink.");
      return res.redirect("/login");
    }
  
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const request = db.prepare(`
      SELECT *
      FROM email_change_requests
      WHERE token_hash = ?
        AND confirmed_at IS NULL
        AND expires_at >= CURRENT_TIMESTAMP
    `).get(tokenHash);
  
    if (!request) {
      setFlash(req, "error", "Der Bestätigungslink ist ungültig oder abgelaufen.");
      return res.redirect("/login");
    }
  
    const duplicate = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(request.new_email, request.user_id);
    if (duplicate) {
      setFlash(req, "error", "Diese E-Mail-Adresse wird bereits verwendet.");
      return res.redirect("/login");
    }
  
    const tx = db.transaction(() => {
      db.prepare("UPDATE users SET email = ? WHERE id = ?").run(request.new_email, request.user_id);
      db.prepare("UPDATE email_change_requests SET confirmed_at = CURRENT_TIMESTAMP WHERE id = ?").run(request.id);
      db.prepare("UPDATE email_change_requests SET confirmed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id != ? AND confirmed_at IS NULL")
        .run(request.user_id, request.id);
    });
    tx();
  
    if (req.session.user && String(req.session.user.id) === String(request.user_id)) {
      req.session.user.email = request.new_email;
    }
  
    createAuditLog(req, "email_change.confirmed", {
      user_id: request.user_id,
      new_email: request.new_email,
      request_id: request.id,
    }, { entityType: "user", entityId: request.user_id });
  
    setFlash(req, "success", "E-Mail-Adresse erfolgreich bestätigt und aktualisiert.");
    res.redirect(req.session.user ? "/admin/benutzer" : "/login");
  });
  
  router.get("/invite/accept", (req, res) => {
    const token = String(req.query.token || "").trim();
    if (!token) {
      setFlash(req, "error", "Ungültiger Einladungslink.");
      return res.redirect("/login");
    }
  
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const invite = db.prepare(`
      SELECT user_invites.*, users.email AS email
      FROM user_invites
      INNER JOIN users ON users.id = user_invites.user_id
      WHERE user_invites.token_hash = ?
        AND user_invites.used_at IS NULL
        AND user_invites.expires_at >= CURRENT_TIMESTAMP
    `).get(tokenHash);
  
    if (!invite) {
      setFlash(req, "error", "Der Einladungslink ist ungültig oder abgelaufen.");
      return res.redirect("/login");
    }
  
    res.render("pages/invite-accept", {
      pageTitle: "Passwort festlegen",
      token,
      email: invite.email || "",
    });
  });
  
  router.post("/invite/accept", async (req, res) => {
    const token = String(req.body.token || "").trim();
    if (!token) {
      setFlash(req, "error", "Ungültiger Einladungslink.");
      return res.redirect("/login");
    }
  
    if (String(req.body.new_password || "") !== String(req.body.new_password_confirm || "")) {
      setFlash(req, "error", "Die neuen Passwörter stimmen nicht überein.");
      return res.redirect(`/invite/accept?token=${encodeURIComponent(token)}`);
    }
    const passwordError = await validateNewPassword(req.body.new_password);
    if (passwordError) {
      setFlash(req, "error", passwordError);
      return res.redirect(`/invite/accept?token=${encodeURIComponent(token)}`);
    }
  
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const invite = db.prepare(`
      SELECT user_invites.*, users.id AS user_id, users.email AS email
      FROM user_invites
      INNER JOIN users ON users.id = user_invites.user_id
      WHERE user_invites.token_hash = ?
        AND user_invites.used_at IS NULL
        AND user_invites.expires_at >= CURRENT_TIMESTAMP
    `).get(tokenHash);
  
    if (!invite) {
      setFlash(req, "error", "Der Einladungslink ist ungültig oder abgelaufen.");
      return res.redirect("/login");
    }
  
    const tx = db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?")
        .run(bcrypt.hashSync(req.body.new_password, PASSWORD_HASH_ROUNDS), invite.user_id);
      db.prepare("UPDATE user_invites SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(invite.id);
      db.prepare("UPDATE user_invites SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id != ? AND used_at IS NULL")
        .run(invite.user_id, invite.id);
    });
    tx();
  
    createAuditLog(req, "user.invite_accepted", { user_id: invite.user_id }, { entityType: "user", entityId: invite.user_id });
    setFlash(req, "success", "Passwort gespeichert. Du kannst dich jetzt einloggen.");
    res.redirect("/login");
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAuthRouter };
