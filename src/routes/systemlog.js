const express = require("express");

function createSystemlogRouter(dependencies) {
  const {
    buildInstallationChecks,
    buildOperationalHealthChecks,
    captureCameraFrame,
    createAuditLog,
    formatAuditLogEntry,
    getAdminViewData,
    homematic,
    getInstanceTimeZone,
    getRuntimeMetricsSnapshot,
    getSettings,
    isEmailConfigured,
    isNtfyConfigured,
    isTelegramConfigured,
    parseCoopCameras,
    readAppRevision,
    redactSensitiveText,
    repository,
    requireAdmin,
    runtimeRevision,
    dataDirectoryConfigured,
    secureCookie,
    setFlash,
    summarizeOperationalChecks,
  } = dependencies;
  const router = express.Router();
  router.use(requireAdmin);

  router.get("/systemlog", (req, res) => {
    const level = String(req.query.level || "all").trim();
    const auditLogs = repository.listAuditLogs().map(formatAuditLogEntry);
    const settings = getSettings();
    const availableRevision = readAppRevision();
    const installationChecks = buildInstallationChecks({
      settings,
      requestBaseUrl: `${req.protocol}://${req.get("host")}`,
      runtimeRevision,
      availableRevision,
      dataDirectoryConfigured,
      secureCookie,
      notificationChannels: {
        "E-Mail": { enabled: settings.reminder_email_enabled === "true", configured: isEmailConfigured(settings) },
        Telegram: { enabled: settings.reminder_telegram_enabled === "true", configured: isTelegramConfigured(settings) },
        ntfy: { enabled: settings.reminder_ntfy_enabled === "true", configured: isNtfyConfigured(settings) },
      },
    });
    const overview = {
      ...repository.getOverviewCounts(),
      instanceTimezone: getInstanceTimeZone(),
      emailReady: isEmailConfigured(settings),
      telegramReady: isTelegramConfigured(settings),
      ntfyReady: isNtfyConfigured(settings),
      emailEnabled: settings.reminder_email_enabled === "true",
      telegramEnabled: settings.reminder_telegram_enabled === "true",
      ntfyEnabled: settings.reminder_ntfy_enabled === "true",
      runtime: getRuntimeMetricsSnapshot(),
      healthChecks: buildOperationalHealthChecks(settings),
      installationChecks,
    };
    res.render("pages/admin-systemlog", {
      ...getAdminViewData("Systemlog", "/admin/systemlog"),
      filters: { level },
      notificationLogs: repository.listNotificationLogs(level),
      auditLogs,
      latestCcuLog: auditLogs.find((item) => String(item.action || "").startsWith("coop.")) || null,
      overview,
    });
  });

  router.get("/health", (req, res) => {
    const settings = getSettings();
    const checks = buildOperationalHealthChecks(settings);
    const availableRevision = readAppRevision();
    const installationChecks = buildInstallationChecks({
      settings,
      requestBaseUrl: `${req.protocol}://${req.get("host")}`,
      runtimeRevision,
      availableRevision,
      dataDirectoryConfigured,
      secureCookie,
    });
    res.json({
      ...summarizeOperationalChecks(checks),
      revision: runtimeRevision,
      availableRevision,
      restartRequired: availableRevision !== runtimeRevision,
      checkedAt: new Date().toISOString(),
      runtime: getRuntimeMetricsSnapshot(),
      checks,
      installationChecks,
    });
  });

  router.post("/systemlog/diagnose", async (req, res) => {
    const settings = getSettings();
    const results = [];
    const run = async (name, callback) => {
      const startedAt = Date.now();
      try {
        await callback();
        results.push({ name, ok: true, durationMs: Date.now() - startedAt });
      } catch (error) {
        results.push({ name, ok: false, durationMs: Date.now() - startedAt, error: redactSensitiveText(error.message) });
      }
    };
    await run("Datenbank", repository.checkDatabase);
    if (homematic.getClimateDatapointIds(settings)) await run("OpenCCU Klima", async () => {
      const climate = await homematic.readClimate(settings);
      if (climate.error) throw new Error(climate.error);
    });
    for (const camera of parseCoopCameras(settings.coop_camera_streams)) await run(`Kamera ${camera.name}`, async () => {
      const frame = await captureCameraFrame({ ...camera, url: camera.snapshotUrl, protocol: camera.snapshotProtocol });
      if (!frame?.length) throw new Error("Kein Kamerabild empfangen.");
    });
    const ok = results.every((item) => item.ok);
    createAuditLog(req, ok ? "system.diagnostic" : "system.diagnostic_failed", { results }, { entityType: "system" });
    setFlash(req, ok ? "success" : "error", ok ? "Gerätediagnose erfolgreich abgeschlossen." : `${results.filter((item) => !item.ok).length} Diagnose-Prüfung(en) sind fehlgeschlagen.`);
    res.redirect("/admin/systemlog");
  });

  for (const alias of ["/system-log", "/log"]) router.get(alias, (req, res) => res.redirect("/admin/systemlog"));
  return router;
}

module.exports = { createSystemlogRouter };
