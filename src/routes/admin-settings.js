const express = require("express");

function createAdminSettingsRouter({
  backTo,
  createNotificationLog,
  db,
  getSettingsObject,
  homematicSessionService,
  isHttpUrl,
  normalizeAppBaseUrl,
  normalizeSettingsInputValue,
  parseBooleanSettingValue,
  parseCoopCameraLines,
  requireAdmin,
  resyncAllGeneratedReminders,
  safeDeleteUploadedFile,
  sendTestEmail,
  sendTestNtfy,
  sendTestTelegram,
  setFlash,
  upload,
  upsertSetting,
  verifySmtpConnection,
}) {
  const router = express.Router();

  router.post("/admin/settings", requireAdmin, upload.single("app_logo"), async (req, res) => {
    const booleanKeys = new Set([
      "smtp_secure",
      "reminder_email_enabled",
      "reminder_telegram_enabled",
      "reminder_ntfy_enabled",
      "browser_notifications_enabled",
      "daily_digest_enabled",
      "daily_digest_only_when_open",
    ]);
    const secretKeys = new Set([
      "smtp_password",
      "telegram_bot_token",
      "ntfy_access_token",
      "homematic_xmlapi_token",
      "homematic_ccu_password",
    ]);
    const fields = String(req.body._fields || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const urlSettingKeys = new Set([
      "homematic_ccu_url",
      "homematic_door_open_url",
      "homematic_door_close_url",
      "homematic_climate_url",
      "homematic_temperature_url",
      "homematic_humidity_url",
    ]);
    const invalidUrlField = fields.find((key) => {
      if (!urlSettingKeys.has(key)) return false;
      const value = String(req.body[key] || "").trim();
      return value && !isHttpUrl(value);
    });
    const invalidCamera = fields.includes("coop_camera_streams")
      ? parseCoopCameraLines(req.body.coop_camera_streams).find((camera) => !camera.valid)
      : null;
    const submittedAppDomain = String(req.body.app_domain || "").trim();
    const normalizedAppDomain = normalizeAppBaseUrl(submittedAppDomain);
    const currentSettings = getSettingsObject(db);
    const accessMode = fields.includes("access_mode")
      ? (req.body.access_mode === "domain" ? "domain" : "lan")
      : (fields.includes("app_domain") && submittedAppDomain
        ? "domain"
        : (currentSettings.access_mode === "domain" ? "domain" : "lan"));
    const invalidAppDomain = fields.includes("app_domain") && (
      (submittedAppDomain && !normalizedAppDomain)
      || (accessMode === "domain" && (!normalizedAppDomain || !normalizedAppDomain.startsWith("https://")))
    );
    const invalidDoorDatapoint = ["homematic_door_open_datapoint_id", "homematic_door_close_datapoint_id", "homematic_door_command_datapoint_id"].find((key) =>
      fields.includes(key) && String(req.body[key] || "").trim() && !/^\d+$/.test(String(req.body[key]).trim())
    );
    const invalidDoorValue = ["homematic_door_open_value", "homematic_door_close_value"].find((key) =>
      fields.includes(key) && !/^-?\d+(?:[.,]\d+)?$/.test(String(req.body[key] || "").trim())
    );
    if (invalidUrlField || invalidCamera || invalidAppDomain || invalidDoorDatapoint || invalidDoorValue) {
      setFlash(req, "error", invalidCamera
        ? `Ungültige Kamera-URL in der Zeile „${invalidCamera.source}“.`
        : invalidAppDomain
          ? "Für den Domainbetrieb ist eine gültige HTTPS-Adresse ohne Pfad erforderlich, zum Beispiel https://tiere.example.de."
        : invalidDoorDatapoint
          ? "Der Tür-Datenpunkt muss eine numerische ISE-ID sein."
          : invalidDoorValue
            ? "Öffnungs- und Schließwert müssen Zahlen sein."
            : "Bitte für Homematic eine vollständige HTTP- oder HTTPS-URL eingeben.");
      return res.redirect(backTo(req, "/admin/allgemein"));
    }

    const settingsBeforeSave = getSettingsObject(db);
    const ccuConnectionChanged = ["homematic_ccu_url", "homematic_xmlapi_token", "homematic_ccu_username", "homematic_ccu_password"].some((key) => {
      if (!fields.includes(key)) return false;
      const submitted = String(req.body[key] || "");
      if (secretKeys.has(key) && !submitted) return false;
      return normalizeSettingsInputValue(key, submitted) !== String(settingsBeforeSave[key] || "");
    });

    fields.forEach((key) => {
      if (secretKeys.has(key) && !String(req.body[key] || "")) {
        return;
      }
      if (booleanKeys.has(key)) {
        upsertSetting(db, key, parseBooleanSettingValue(req.body[key]) ? "true" : "false");
        return;
      }

      if (key === "app_domain") {
        upsertSetting(db, key, accessMode === "domain" ? normalizedAppDomain : "");
        return;
      }

      upsertSetting(db, key, normalizeSettingsInputValue(key, req.body[key]));
    });

    if (!fields.includes("access_mode") && fields.includes("app_domain") && submittedAppDomain) {
      upsertSetting(db, "access_mode", "domain");
    }

    if (ccuConnectionChanged) {
      await homematicSessionService.reset(settingsBeforeSave);
    }

    if (req.file) {
      if (!String(req.file.mimetype || "").startsWith("image/")) {
        safeDeleteUploadedFile(req.file.filename);
        setFlash(req, "error", "Bitte lade für das App-Logo eine Bilddatei hoch.");
        return res.redirect(backTo(req, "/admin/allgemein"));
      }

      const currentSettings = getSettingsObject(db);
      const previousLogo = String(currentSettings.app_logo_stored_name || "").trim();
      upsertSetting(db, "app_logo_stored_name", req.file.filename);
      safeDeleteUploadedFile(previousLogo, req.file.filename);
    }

    if (fields.some((key) =>
      key.endsWith("_reminder_lead_days") ||
      key.endsWith("_reminder_repeat_count") ||
      key === "reminder_email_enabled" ||
      key === "reminder_telegram_enabled"
      || key === "reminder_ntfy_enabled"
    )) {
      resyncAllGeneratedReminders();
    }

    if (fields.length === 1 && fields[0] === "reminder_email_enabled") {
      setFlash(req, "success", parseBooleanSettingValue(req.body.reminder_email_enabled)
        ? "E-Mail-Benachrichtigungen wurden aktiviert."
        : "E-Mail-Benachrichtigungen wurden deaktiviert.");
    } else if (fields.length === 1 && fields[0] === "reminder_telegram_enabled") {
      setFlash(req, "success", parseBooleanSettingValue(req.body.reminder_telegram_enabled)
        ? "Telegram-Benachrichtigungen wurden aktiviert."
        : "Telegram-Benachrichtigungen wurden deaktiviert.");
    } else if (fields.length === 1 && fields[0] === "reminder_ntfy_enabled") {
      setFlash(req, "success", parseBooleanSettingValue(req.body.reminder_ntfy_enabled)
        ? "ntfy-Benachrichtigungen wurden aktiviert."
        : "ntfy-Benachrichtigungen wurden deaktiviert.");
    } else {
      setFlash(req, "success", "Einstellungen gespeichert.");
    }
    res.redirect(backTo(req, "/admin/allgemein"));
  });

  router.post("/admin/settings/app-logo/delete", requireAdmin, (req, res) => {
    const currentSettings = getSettingsObject(db);
    const previousLogo = String(currentSettings.app_logo_stored_name || "").trim();
    upsertSetting(db, "app_logo_stored_name", "");
    safeDeleteUploadedFile(previousLogo);
    setFlash(req, "success", "Das App-Logo wurde auf das Standardlogo zurückgesetzt.");
    res.redirect(backTo(req, "/admin/allgemein"));
  });

  router.post("/admin/test-email", requireAdmin, async (req, res) => {
    try {
      await sendTestEmail(getSettingsObject(db));
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "email",
        type: "test",
        recipient: getSettingsObject(db).notification_email_to || getSettingsObject(db).smtp_user || "",
        subject: "SMTP-Testmail",
        status: "sent",
        details: { source: "admin.test-email" },
      });
      setFlash(req, "success", "SMTP-Testmail wurde versendet.");
    } catch (error) {
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "email",
        type: "test",
        recipient: getSettingsObject(db).notification_email_to || getSettingsObject(db).smtp_user || "",
        subject: "SMTP-Testmail",
        status: "error",
        error: error.message,
        details: { source: "admin.test-email" },
      });
      setFlash(req, "error", `SMTP-Test fehlgeschlagen: ${error.message}`);
    }

    res.redirect("/admin/benachrichtigungen");
  });

  async function handleSmtpConnectionTest(req, res) {
    try {
      await verifySmtpConnection(getSettingsObject(db));
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "email",
        type: "smtp_connection_check",
        recipient: getSettingsObject(db).smtp_host || "",
        subject: "SMTP-Verbindung prüfen",
        status: "sent",
        details: {},
      });
      setFlash(req, "success", "SMTP-Verbindung erfolgreich geprüft.");
    } catch (error) {
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "email",
        type: "smtp_connection_check",
        recipient: getSettingsObject(db).smtp_host || "",
        subject: "SMTP-Verbindung prüfen",
        status: "error",
        error: error.message,
        details: {},
      });
      setFlash(req, "error", `SMTP-Verbindung fehlgeschlagen: ${error.message}`);
    }
    res.redirect("/admin/benachrichtigungen");
  }

  [
    "/admin/test-smtp-connection",
    "/test-smtp-connection",
    "/admin/benachrichtigungen/test-smtp-connection",
  ].forEach((path) => {
    router.post(path, requireAdmin, handleSmtpConnectionTest);
  });

  router.get("/admin/test-smtp-connection", requireAdmin, (req, res) => {
    setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
    res.redirect("/admin/benachrichtigungen");
  });
  router.get("/test-smtp-connection", requireAdmin, (req, res) => {
    setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
    res.redirect("/admin/benachrichtigungen");
  });
  router.get("/admin/benachrichtigungen/test-smtp-connection", requireAdmin, (req, res) => {
    setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
    res.redirect("/admin/benachrichtigungen");
  });
  router.all(/^\/.*test-smtp-connection.*$/, requireAdmin, async (req, res) => {
    if (req.method === "POST") {
      return handleSmtpConnectionTest(req, res);
    }
    setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
    return res.redirect("/admin/benachrichtigungen");
  });

  router.post("/admin/test-telegram", requireAdmin, async (req, res) => {
    try {
      await sendTestTelegram(getSettingsObject(db));
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "telegram",
        type: "test",
        recipient: getSettingsObject(db).telegram_chat_id || "",
        subject: "Telegram-Testnachricht",
        status: "sent",
        details: { source: "admin.test-telegram" },
      });
      setFlash(req, "success", "Telegram-Testnachricht wurde versendet.");
    } catch (error) {
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "telegram",
        type: "test",
        recipient: getSettingsObject(db).telegram_chat_id || "",
        subject: "Telegram-Testnachricht",
        status: "error",
        error: error.message,
        details: { source: "admin.test-telegram" },
      });
      setFlash(req, "error", `Telegram-Test fehlgeschlagen: ${error.message}`);
    }

    res.redirect("/admin/benachrichtigungen");
  });

  router.post("/admin/test-ntfy", requireAdmin, async (req, res) => {
    const settings = getSettingsObject(db);
    try {
      await sendTestNtfy(settings);
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "ntfy",
        type: "test",
        recipient: settings.ntfy_topic || "",
        subject: "ntfy-Testnachricht",
        status: "sent",
        details: { source: "admin.test-ntfy" },
      });
      setFlash(req, "success", "ntfy-Testnachricht wurde versendet.");
    } catch (error) {
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "ntfy",
        type: "test",
        recipient: settings.ntfy_topic || "",
        subject: "ntfy-Testnachricht",
        status: "error",
        error: error.message,
        details: { source: "admin.test-ntfy" },
      });
      setFlash(req, "error", `ntfy-Test fehlgeschlagen: ${error.message}`);
    }
    res.redirect("/admin/benachrichtigungen");
  });

  router.heartpetMountPath = "";
  return router;
}

module.exports = { createAdminSettingsRouter };
