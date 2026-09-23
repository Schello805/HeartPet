const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const dayjs = require("dayjs");

const { initDatabase, getSettingsObject, upsertSetting } = require("./db");
const { createSessionMiddleware } = require("./http-session");
const { createImportUploadMiddleware, createStoredUploadName, createUploadMiddleware } = require("./uploads");
const {
  buildPermissions,
  formatCurrency,
  formatDate,
  formatDateTime,
  getAnimalAge,
  getAnimalInitial,
  getAnimalSpeciesIcon,
  getAnimalLifecycle,
  getReminderStatusMeta,
  getRoleLabel,
  isActiveAnimalStatus,
  normalizeAnimalStatus,
  summarizeReminderState,
} = require("./view-helpers");
const {
  processDueReminders,
  sendEmailReminder,
  sendTelegramReminder,
  sendNtfyReminder,
  sendDailyDigestEmail,
  sendDailyDigestTelegram,
  sendDailyDigestNtfy,
  sendTestEmail,
  sendTestTelegram,
  sendTestNtfy,
  sendUserInviteEmail,
  sendUserCreatedAdminEmail,
  sendEmailChangeConfirmation,
  sendPasswordResetEmail,
  verifySmtpConnection,
  isEmailEnabled,
  isTelegramEnabled,
  isNtfyEnabled,
  isEmailConfigured,
  isTelegramConfigured,
  isNtfyConfigured,
  verifyReminderActionToken,
} = require("./reminders");
const { buildAnimalExportPayload, createAnimalPdf } = require("./exporters");
const { PASSWORD_HASH_ROUNDS, validateNewPassword } = require("./password-security");
const { buildAnimalTimeline } = require("./animal-timeline");
const { createAnimalRepository } = require("./animal-repository");
const { createSystemlogRepository } = require("./repositories/systemlog-repository");
const { createReminderRepository } = require("./repositories/reminder-repository");
const { buildCoreOperationalChecks, buildInstallationChecks, summarizeOperationalChecks } = require("./operational-health");
const { getVaccinationSuggestionGroups, getVaccinationSuggestionsForSpecies } = require("./vaccination-suggestions");
const { resolveStoredFilePath } = require("./storage-paths");
const {
  FIELD_SCHEMAS,
  htmlConstraints,
  isValidEmail,
  normalizeVeterinarianPayload,
  validateText,
  validateVeterinarian,
} = require("./validation");
const {
  createHomematicSessionService,
  getLoginRetryDelay: getHomematicLoginRetryDelay,
  resolveRenewedSessionId: resolveRenewedHomematicSid,
  shouldReplaceSessionAfterRenewError: shouldReplaceHomematicSessionAfterRenewError,
} = require("./services/homematic-session");
const { createHomematicService } = require("./services/homematic");
const {
  buildHomematicClimateUrl,
  buildHomematicCommandUrl,
  buildHomematicXmlApiUrl,
  callHomematicJsonRpc,
  decodeHomematicXmlBuffer,
  findHomematicValue,
  findHomematicXmlDatapoint,
  getHomematicApiUrl,
  getHomematicCommandResponseError,
  getHomematicDoorCommand,
  getHomematicDoorCommandSequence,
  isCameraUrl,
  isHttpUrl,
  isRtspUrl,
  normalizeConfiguredUrl,
  normalizeHomematicXmlApiToken,
  parseHomematicDatapoints,
  parseHomematicStateChange,
  parseHomematicTextValue,
  parseWritableHomematicDatapoints,
} = require("./services/homematic-utils");
const { createAnimalWorkspaceService } = require("./services/animal-workspace");
const { createDashboardService } = require("./services/dashboard");
const { createSearchService } = require("./services/search");
const { createAnimalsRouter } = require("./routes/animals");
const { createAnimalRecordsRouter } = require("./routes/animal-records");
const { createAnimalMediaRouter } = require("./routes/animal-media");
const { createAnimalDownloadsRouter } = require("./routes/animal-downloads");
const { createAnimalHealthRouter } = require("./routes/animal-health");
const { createAnimalEntriesRouter } = require("./routes/animal-entries");
const { createAnimalRemindersRouter } = require("./routes/animal-reminders");
const { createAuthRouter } = require("./routes/auth");
const { createDashboardRouter } = require("./routes/dashboard");
const { createReminderActionsRouter } = require("./routes/reminder-actions");
const { createReminderApiRouter } = require("./routes/reminder-api");
const { createAdminPagesRouter } = require("./routes/admin-pages");
const { createAdminUserPagesRouter } = require("./routes/admin-user-pages");
const { createAdminSettingsRouter } = require("./routes/admin-settings");
const { createAdminUsersRouter } = require("./routes/admin-users");
const { createAdminImportRouter } = require("./routes/admin-import");
const { createCoopRouter } = require("./routes/coop");
const { createWeatherService, getWeatherCodeMeta } = require("./services/weather");
const { createCameraService } = require("./services/camera");
const { createAnimalReminderService } = require("./services/animal-reminders");
const { createMasterdataRouter } = require("./routes/masterdata");
const { createSystemlogRouter } = require("./routes/systemlog");
const { createCalendarRouter } = require("./routes/calendar");
const { createCareManagementRouter } = require("./routes/care-management");
const { createCalendarExportService } = require("./services/calendar-export");
const { createErrorHandler } = require("./middleware/error-handler");
const { createReminderScheduler } = require("./services/reminder-scheduler");
const { createNotificationChannels } = require("./services/notification-channels");
const { optimizeAnimalImageUpload } = require("./services/image-optimizer");
const { APP_ICON_SIZES, buildWebAppManifest, createAppIconPng } = require("./services/app-icons");
const { getDefaultAppBaseUrl, listLocalAccessUrls, resolveBindHost } = require("./runtime/network");
const { normalizeAppBaseUrl, resolveAppBaseUrl: resolveConfiguredAppBaseUrl } = require("./app-url");
const { FEDERAL_STATES, getDisposalGuidance, isValidFederalState } = require("./disposal-guidance");
const { listTimeZones, resolveInstanceTimeZone } = require("./instance-timezone");
const { createUpdateChecker } = require("./services/update-check");
const { createRuntimeMetrics } = require("./runtime/runtime-metrics");
const { startServer } = require("./runtime/start-server");

const app = express();
app.set("trust proxy", process.env.HEARTPET_TRUST_PROXY || "loopback");
const db = initDatabase();
const animalRepository = createAnimalRepository(db);
const systemlogRepository = createSystemlogRepository(db);
const reminderRepository = createReminderRepository(db);
const calendarExportService = createCalendarExportService(db);
const projectRoot = path.join(__dirname, "..");
const revisionPath = path.join(projectRoot, "REVISION");
const runtimeRevision = String(process.env.HEARTPET_RUNTIME_REVISION || "").trim() || readAppRevision();
const updateChecker = createUpdateChecker({ currentRevision: runtimeRevision });
const configuredDataDir = String(process.env.HEARTPET_DATA_DIR || "").trim();
const dataDir = configuredDataDir ? path.resolve(configuredDataDir) : path.join(projectRoot, "data");
const uploadsDir = path.join(dataDir, "uploads");
const upload = createUploadMiddleware(dataDir);
const importUpload = createImportUploadMiddleware();
const weatherCache = new Map();
const cameraFrameCache = new Map();
const cameraCacheDir = path.join(dataDir, "cache", "cameras");
const loginAttempts = new Map();
const passwordResetAttempts = new Map();
const userPresenceWrites = new Map();
const runtimeMetrics = createRuntimeMetrics();
const microchipRegistryOptions = ["TASSO", "FINDEFIX", "TASSO und FINDEFIX", "Anderes Register", "Nicht registriert"];
const microchipManufacturerSuggestions = ["Dechra", "Datamars", "MSD Animal Health", "Trovan", "Virbac"];
const {
  parseCoopCameraLines,
  parseCoopCameras,
  readCameraFrameCache,
  writeCameraFrameCache,
  streamRtspCamera,
  captureCameraFrame,
  checkRtspCamera,
  fetchWithTimeout,
  createAuthenticatedFetchTarget,
  redactSensitiveText,
  sanitizeLogText,
  buildDigestAuthorization,
  fetchCameraStream,
  describeFetchError,
  buildCameraPlaceholderSvg,
} = createCameraService({ cameraCacheDir, normalizeConfiguredUrl, isCameraUrl, isRtspUrl });
const homematicSessionService = createHomematicSessionService({
  callJsonRpc: callHomematicJsonRpc,
  describeError: describeFetchError,
  getApiUrl: getHomematicApiUrl,
  persistSessionId: (sid) => upsertSetting(db, "homematic_ccu_session_id", sid),
});
const loginHomematicCcu = homematicSessionService.login;
const homematic = createHomematicService({
  callJsonRpc: callHomematicJsonRpc,
  describeFetchError,
  fetchWithTimeout,
  login: loginHomematicCcu,
});
const { readOutdoorWeather } = createWeatherService({
  cache: weatherCache,
  fetchWithTimeout,
  describeFetchError,
  getTimeZone: getInstanceTimeZone,
});
const animalReminders = createAnimalReminderService({ db, getSettingsObject, parsePositiveInteger });
const {
  applyCompletionSideEffects,
  resyncAllGeneratedReminders,
  syncAppointmentReminders,
  syncMedicationReminders,
  syncVaccinationReminders,
} = animalReminders;
const animalWorkspace = createAnimalWorkspaceService({
  db,
  animalRepository,
  buildAnimalTimeline,
  formatDate,
  formatDateTime,
  getAnimalActivityEntries,
  getAnimalLifecycle,
  summarizeReminderState,
  getDisposalGuidance,
  getSettings: () => getSettingsObject(db),
});
const searchService = createSearchService({ db, formatDateTime });
const dashboardService = createDashboardService({
  db,
  animalWorkspace,
  getSettings: () => getSettingsObject(db),
  homematic,
  parseCameras: parseCoopCameras,
  readWeather: readOutdoorWeather,
  search: searchService.search,
});
const notificationChannels = createNotificationChannels({
  isEmailEnabled,
  isTelegramEnabled,
  isNtfyEnabled,
  sendEmailReminder,
  sendTelegramReminder,
  sendNtfyReminder,
  sendDailyDigestEmail,
  sendDailyDigestTelegram,
  sendDailyDigestNtfy,
});
const reminderScheduler = createReminderScheduler({
  db,
  getSettings: () => getSettingsObject(db),
  upsertSetting,
  formatDateTime,
  processDueReminders,
  createNotificationLog,
  repository: reminderRepository,
  notifications: notificationChannels,
});

app.set("view engine", "ejs");
app.set("views", path.join(projectRoot, "views"));

app.disable("x-powered-by");
app.use(runtimeMetrics.middleware);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    let originHost = "";
    try { originHost = new URL(req.headers.origin).host; } catch {}
    if (!originHost || originHost !== req.get("host")) return res.status(403).send("Anfrage aus fremder Quelle abgelehnt.");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const fetchSite = String(req.get("Sec-Fetch-Site") || "").toLowerCase();
    if (["cross-site", "none"].includes(fetchSite)) return res.status(403).send("Anfrage aus fremder Quelle abgelehnt.");
  }
  return next();
});
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 2000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Zu viele Anfragen. Bitte versuche es in einigen Minuten erneut.",
}));
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});
app.use(
  "/static",
  express.static(path.join(projectRoot, "public"), {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    },
  }),
);
app.get("/favicon.ico", (req, res) => {
  return res.redirect(302, `/app-icon/32.png?v=${encodeURIComponent(getAppIconVersion())}`);
});

app.get("/app-logo", (req, res) => {
  const storedName = String(getSettingsObject(db).app_logo_stored_name || "").trim();
  const fallback = path.join(projectRoot, "public", "images", "logo-heartpet.png");
  const logoPath = resolveStoredFilePath(uploadsDir, storedName);
  if (!logoPath) return res.sendFile(fallback);
  return res.sendFile(logoPath, (error) => {
    if (error && !res.headersSent) res.sendFile(fallback);
  });
});

app.get("/app.webmanifest", (req, res) => {
  res.set("Cache-Control", "no-cache, must-revalidate");
  return res.type("application/manifest+json").send(buildWebAppManifest(getSettingsObject(db), getAppIconVersion()));
});

app.get("/service-worker.js", (req, res) => {
  res.set("Cache-Control", "no-cache, must-revalidate");
  res.set("Service-Worker-Allowed", "/");
  return res.type("application/javascript").sendFile(path.join(projectRoot, "public", "service-worker.js"));
});

app.get(/^\/app-icon\/(32|180|192|512)\.png$/, async (req, res, next) => {
  const size = Number(req.params[0]);
  if (!APP_ICON_SIZES.has(size)) return res.sendStatus(404);
  try {
    const icon = await createAppIconPng(getAppLogoFilePath(getSettingsObject(db)), size);
    res.set("Cache-Control", "no-cache, must-revalidate");
    return res.type("image/png").send(icon);
  } catch (error) {
    return next(error);
  }
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

app.get("/sitemap.xml", (req, res) => res.sendStatus(404));

app.get("/health", (req, res) => {
  const summary = summarizeOperationalChecks(buildCoreOperationalChecks({ db, dataDir }));
  const availableRevision = readAppRevision();
  const restartRequired = availableRevision !== runtimeRevision;
  return res.status(summary.ok && !restartRequired ? 200 : 503).json({
    ok: summary.ok && !restartRequired,
    status: restartRequired ? "restart_required" : summary.status,
    service: "heartpet",
    pid: process.pid,
    revision: runtimeRevision,
    availableRevision,
    restartRequired,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use(createSessionMiddleware(dataDir));

app.use((req, res, next) => {
  const session = req.session || (req.session = {});
  const flash = session.flash || null;
  delete session.flash;
  let currentUserRecord = session.user
    ? db.prepare("SELECT * FROM users WHERE id = ?").get(session.user.id)
    : null;

  if (currentUserRecord && Number(session.user.sessionVersion || 0) !== Number(currentUserRecord.session_version || 0)) {
    delete session.user;
    currentUserRecord = null;
  }

  if (currentUserRecord) {
    const lastPresenceWrite = Number(userPresenceWrites.get(currentUserRecord.id) || 0);
    if (Date.now() - lastPresenceWrite >= 60_000) {
      db.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(currentUserRecord.id);
      userPresenceWrites.set(currentUserRecord.id, Date.now());
    }
    session.user = {
      id: currentUserRecord.id,
      name: currentUserRecord.name,
      email: currentUserRecord.email,
      role: currentUserRecord.role,
      mustChangePassword: Boolean(currentUserRecord.must_change_password),
      sessionVersion: Number(currentUserRecord.session_version || 0),
    };
  }

  res.locals.flash = flash;
  res.locals.currentUser = session.user || null;
  res.locals.appSettings = getSettingsObject(db);
  res.locals.appBaseUrl = resolveAppBaseUrl(res.locals.appSettings);
  res.locals.appLogoUrl = getAppLogoUrl(res.locals.appSettings);
  res.locals.appIconVersion = getAppIconVersion();
  res.locals.currentPath = req.path;
  res.locals.currentQuery = req.query || {};
  res.locals.appRevision = runtimeRevision;
  res.locals.runtimeFeatures = {
    memorialNoteEditor: true,
    vaccinationPresets: true,
    careManagement: true,
    calendarExport: true,
    disposalFacilities: true,
    updateStatus: true,
    webAppManifest: true,
    deploymentGuard: true,
  };
  res.locals.fieldConstraints = htmlConstraints;
  res.locals.seoMeta = buildSeoMeta(req, res.locals.appSettings);
  res.locals.animalSpeciesMenu = animalWorkspace.listActiveSpecies();
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.formatCurrency = formatCurrency;
  res.locals.getAnimalAge = getAnimalAge;
  res.locals.getAnimalInitial = getAnimalInitial;
  res.locals.getAnimalSpeciesIcon = getAnimalSpeciesIcon;
  res.locals.getRoleLabel = getRoleLabel;
  res.locals.getAnimalLifecycle = getAnimalLifecycle;
  res.locals.getReminderStatusMeta = getReminderStatusMeta;
  res.locals.permissions = buildPermissions(currentUserRecord || session.user);
  res.locals.editState = { type: "", id: null };
  res.locals.reminderBuckets = { overdue: [], open: [], done: [] };
  next();
});

function readAppRevision() {
  try {
    const revision = fs.readFileSync(revisionPath, "utf8").trim();
    return revision || "dev";
  } catch (error) {
    return "dev";
  }
}

app.use((req, res, next) => {
  const setupComplete = isSetupComplete();
  res.locals.setupComplete = setupComplete;

  if (!setupComplete) {
    return res.status(503).send("HeartPet ist noch nicht vollständig installiert. Führe ./scripts/install.sh --configure aus.");
  }

  next();
});

app.use(createAuthRouter({
  db, setFlash, validateNewPassword, passwordHashRounds: PASSWORD_HASH_ROUNDS,
  regenerateSession, safeLocalReturnPath, loginAttempts, userPresenceWrites,
  requireAuth, passwordResetAttempts, getSettingsObject, resolveAppBaseUrl,
  sendPasswordResetEmail, createNotificationLog, createAuditLog,
}));

app.use((req, res, next) => {
  if (req.session?.user?.mustChangePassword && req.path !== "/first-login/password" && req.path !== "/logout") {
    return res.redirect("/first-login/password");
  }
  next();
});

app.use(createReminderActionsRouter({
  db,
  getSettings: () => getSettingsObject(db),
  resolveAppBaseUrl,
  verifyActionToken: verifyReminderActionToken,
  isActiveAnimalStatus,
  applyCompletionSideEffects,
  createAuditLog,
}));

app.use(requireAuth);
app.get("/api/update-status", requireAdmin, async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  return res.json(await updateChecker.check());
});
app.use("/media", express.static(uploadsDir, {
  fallthrough: false,
  index: false,
  dotfiles: "deny",
  setHeaders(res) { res.setHeader("Cache-Control", "private, max-age=300"); },
}));

app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  res.on("finish", () => {
    if (res.statusCode >= 400 || !req.session?.user) return;
    createAuditLog(req, "request.change", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      fields: Object.keys(req.body || {}).filter((key) => !isSensitiveAuditField(key)),
    }, { entityType: "request" });
  });
  return next();
});

app.use(createDashboardRouter({ dashboard: dashboardService, search: searchService }));
app.use(createCalendarRouter({ calendar: calendarExportService, db, renderNotFound }));
app.use(createCareManagementRouter({
  createAuditLog,
  db,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  renderNotFound,
  requireAdmin,
  safeLocalReturnPath,
  setFlash,
}));

app.use(createCoopRouter({
  db, getSettingsObject, homematic, createAuditLog, setFlash, parseCoopCameras, streamRtspCamera, fetchCameraStream,
  redactSensitiveText, cameraFrameCache, readCameraFrameCache, captureCameraFrame, writeCameraFrameCache,
  describeFetchError, buildCameraPlaceholderSvg, checkRtspCamera, requireAdmin,
}));

app.use("/animals", createAnimalsRouter({
  animalWorkspace,
  renderNotFound,
  requireAdmin,
}));
app.use("/animals", createAnimalRecordsRouter({
  db,
  uploadsDir,
  requireAnimalEditor,
  findAnimal,
  renderNotFound,
  normalizeAnimalPayload,
  normalizeAnimalTransitionDetails,
  safeLocalReturnPath,
  getAnimalReturnTo,
  setFlash,
  requiresAnimalStatusTransitionConfirmation,
  isConfirmedAnimalStatusTransition,
  validateAnimalTransitionDetails,
  isActiveAnimalStatus,
  normalizeAnimalStatus,
  getAnimalLifecycle,
  buildAnimalTransitionSummary,
  closeOpenRemindersForAnimal,
  createAuditLog,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  microchipRegistryOptions,
  microchipManufacturerSuggestions,
  resolveStoredFilePath,
  duplicateAnimalRecord,
  deleteUploadedFileIfUnreferenced,
}));
app.use(createAnimalHealthRouter({
  db,
  upload,
  requireAnimalPermission,
  getVaccinationSuggestionGroups,
  getAnimalReturnTo,
  safeLocalReturnPath,
  getVaccinationCertificateError,
  discardUploadedFile,
  setFlash,
  reminders: animalReminders,
  createAuditLog,
  redirectDocumentDrawerRequest,
  renderNotFound,
  deleteUploadedFileIfUnreferenced,
}));
app.get("/admin/systemlog/systemlog", requireAdmin, (req, res) => {
  res.redirect("/admin/systemlog");
});


app.use(createAnimalEntriesRouter({
  buildPermissions,
  combineDateAndTime,
  createAuditLog,
  db,
  discardUploadedFile,
  findAnimal,
  getAnimalReturnTo,
  getCurrentUserRecord,
  getVaccinationCertificateError,
  getVaccinationSuggestionsForSpecies,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  renderNotFound,
  requireAnimalPermission,
  reminders: animalReminders,
  safeLocalReturnPath,
  setFlash,
  upload,
}));

app.use(createAnimalRemindersRouter({
  db, requireAnimalPermission, safeLocalReturnPath, parsePositiveInteger, setFlash,
  createAuditLog, reminders: animalReminders, findAnimal, isActiveAnimalStatus,
  renderNotFound, safeRefererPath, getAnimalReturnTo, redirectDocumentDrawerRequest,
}));


app.use(createAnimalMediaRouter({
  db,
  uploadsDir,
  upload,
  requireAnimalPermission,
  safeLocalReturnPath,
  setFlash,
  createAuditLog,
  resolveStoredFilePath,
  safeDeleteUploadedFile,
  findAnimal,
  renderNotFound,
  deleteUploadedFileIfUnreferenced,
  optimizeAnimalImageUpload,
}));

app.use(createAnimalDownloadsRouter({
  buildAnimalExportPayload,
  createAnimalPdf,
  db,
  findAnimal,
  getAnimalRelatedData,
  getSettingsObject,
  renderNotFound,
  resolveStoredFilePath,
  setFlash,
  uploadsDir,
}));

app.use(createAdminPagesRouter({
  captureCameraFrame,
  getAdminViewData,
  isCameraUrl,
  isRtspUrl,
  normalizeConfiguredUrl,
  requireAdmin,
}));

app.use("/admin", createMasterdataRouter({
  backTo,
  createAuditLog,
  db,
  FIELD_SCHEMAS,
  federalStates: FEDERAL_STATES,
  getSettingsObject,
  getAdminViewData,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  redirectAfterPost,
  renderNotFound,
  requireAdmin,
  safeLocalReturnPath,
  setFlash,
  upsertSetting,
  validateText,
  normalizeVeterinarianPayload,
  validateVeterinarian,
  isValidFederalState,
}));

app.use(createAdminUserPagesRouter({
  backTo,
  db,
  getAdminViewData,
  isDrawerRequest,
  redirectDocumentDrawerRequest,
  renderNotFound,
  requireAdmin,
  safeLocalReturnPath,
  setFlash,
}));

app.use("/admin", createSystemlogRouter({
  buildInstallationChecks,
  buildOperationalHealthChecks,
  captureCameraFrame,
  createAuditLog,
  formatAuditLogEntry,
  getAdminShellViewData,
  homematic,
  getInstanceTimeZone,
  getRuntimeMetricsSnapshot,
  getSettings: () => getSettingsObject(db),
  isEmailConfigured,
  isNtfyConfigured,
  isTelegramConfigured,
  parseCoopCameras,
  readAppRevision,
  redactSensitiveText,
  repository: systemlogRepository,
  requireAdmin,
  runtimeRevision,
  dataDirectoryConfigured: Boolean(configuredDataDir),
  secureCookie: String(process.env.HEARTPET_SECURE_COOKIE || "auto").trim().toLowerCase(),
  setFlash,
  summarizeOperationalChecks,
}));

["/systemlog", "/system-log"].forEach((aliasPath) => {
  app.get(aliasPath, requireAdmin, (req, res) => res.redirect("/admin/systemlog"));
});

app.get(/^\/.+\/(?:systemlog|system-log)$/, requireAdmin, (req, res) => res.redirect("/admin/systemlog"));

app.use(createAdminSettingsRouter({
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
  isValidFederalState,
}));

app.use(createAdminUsersRouter({
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
}));

app.use(createAdminImportRouter({
  closeOpenRemindersForAnimal,
  db,
  ensureSpeciesExists,
  importUpload,
  isActiveAnimalStatus,
  normalizeAnimalStatus,
  normalizeMicrochipRegistry,
  requireAdmin,
  resolveImportedCategoryId,
  restoreEmbeddedFile,
  setFlash,
  syncAppointmentReminders,
  syncMedicationReminders,
  syncVaccinationReminders,
}));

app.get("/hilfe", (req, res) => {
  res.render("pages/help", { pageTitle: "Hilfe" });
});

app.use(createReminderApiRouter({ repository: reminderRepository }));

app.use((req, res) => {
  renderNotFound(req, res, "Seite nicht gefunden.");
});

app.use(createErrorHandler({ redactSensitiveText, sanitizeLogText, setFlash }));

const port = Number(process.env.PORT || 3000);
const bindHost = resolveBindHost(process.env.HEARTPET_HOST);
if (require.main === module) {
  startServer({
    app,
    port,
    bindHost,
    scheduler: reminderScheduler,
    accessUrls: listLocalAccessUrls({ port, bindHost }),
    beforeClose: () => homematicSessionService.reset(getSettingsObject(db)),
  });
}

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    const target = safeLocalReturnPath(`${req.path}${req.url.includes("?") ? req.url.slice(req.path.length) : ""}`, "");
    return res.redirect(target ? `/login?return_to=${encodeURIComponent(target)}` : "/login");
  }
  next();
}

function isSetupComplete() {
  return getSettingsObject(db).setup_complete === "true";
}

function requireAdmin(req, res, next) {
  if (!req.session?.user || req.session.user.role !== "admin") {
    setFlash(req, "error", "Dieser Bereich ist nur für Administratoren verfügbar.");
    return res.redirect("/");
  }
  next();
}

function requireAnimalEditor(req, res, next) {
  const user = getCurrentUserRecord(req);
  if (!buildPermissions(user).canEditAnimals) {
    setFlash(req, "error", "Für diese Aktion fehlen die erforderlichen Rechte.");
    return res.redirect(safeRefererPath(req, "/"));
  }
  next();
}

function requireAnimalPermission(permissionKey) {
  return (req, res, next) => {
    const user = getCurrentUserRecord(req);
    if (!buildPermissions(user)[permissionKey]) {
      setFlash(req, "error", "Für diese Aktion fehlen die erforderlichen Rechte.");
      return res.redirect(safeRefererPath(req, "/"));
    }
    next();
  };
}

function getCurrentUserRecord(req) {
  if (!req.session?.user?.id) {
    return null;
  }
  return db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
}

function setFlash(req, type, message) {
  if (!req.session) req.session = {};
  req.session.flash = { type, message };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session?.regenerate) {
      req.session = req.session || {};
      return resolve();
    }
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function findAnimal(id) {
  return animalRepository.findById(id);
}

function getAnimalRelatedData(animalId) {
  return animalRepository.getRelated(animalId);
}

function normalizeAnimalPayload(body) {
  const speciesName = String(body.species_name || "").trim();
  const speciesId = speciesName ? ensureSpeciesExists(speciesName).id : null;
  const selectedVeterinarianId = String(body.veterinarian_id || "").trim();
  return {
    name: String(body.name || "").trim(),
    species_id: speciesId,
    species_name: speciesName,
    sex: body.sex || "",
    birth_date: body.birth_date || null,
    intake_date: body.intake_date || null,
    source: body.source || "",
    microchip_number: body.microchip_number || "",
    microchip_manufacturer: String(body.microchip_manufacturer || "").trim().slice(0, 120),
    microchip_registry: normalizeMicrochipRegistry(body.microchip_registry),
    status: normalizeAnimalStatus(body.status),
    color: body.color || "",
    breed: body.breed || "",
    weight_kg: body.weight_kg || null,
    veterinarian_id: selectedVeterinarianId || resolveDefaultVeterinarianId(speciesId),
    notes: body.notes || "",
  };
}

function normalizeMicrochipRegistry(value) {
  const registry = String(value || "").trim();
  return microchipRegistryOptions.includes(registry) ? registry : "";
}

function requiresAnimalStatusTransitionConfirmation(previousStatus, nextStatus) {
  return normalizeAnimalStatus(previousStatus) === "Aktiv" && normalizeAnimalStatus(nextStatus) !== "Aktiv";
}

function isConfirmedAnimalStatusTransition(body) {
  return String(body.status_transition_confirmed || "").trim().toLowerCase() === "true";
}

function getAnimalStatusContextConfig(status) {
  const normalized = normalizeAnimalStatus(status);
  const config = {
    Aktiv: {
      nameLabel: "",
      nameRequired: false,
      dateLabel: "",
      dateRequired: false,
      noteLabel: "",
    },
    Vermittelt: {
      nameLabel: "Vermittelt an",
      nameRequired: true,
      dateLabel: "Vermittelt am",
      dateRequired: true,
      noteLabel: "Übergabehinweis",
    },
    Verkauft: {
      nameLabel: "Verkauft an",
      nameRequired: true,
      dateLabel: "Verkauft am",
      dateRequired: true,
      noteLabel: "Verkaufshinweis",
    },
    Verstorben: {
      nameLabel: "Ort / Zusammenhang",
      nameRequired: false,
      dateLabel: "Abschied am",
      dateRequired: true,
      noteLabel: "Erinnerungsnotiz",
    },
  };
  return config[normalized];
}

function normalizeAnimalTransitionDetails(body, status) {
  const config = getAnimalStatusContextConfig(status);
  if (!config || normalizeAnimalStatus(status) === "Aktiv") {
    return {
      status_context_name: "",
      status_context_date: "",
      memorial_note: "",
    };
  }

  return {
    status_context_name: String(body.status_context_name || "").trim(),
    status_context_date: String(body.status_context_date || "").trim(),
    memorial_note: String(body.memorial_note || "").trim(),
  };
}

function validateAnimalTransitionDetails(status, details) {
  const config = getAnimalStatusContextConfig(status);
  if (!config || normalizeAnimalStatus(status) === "Aktiv") {
    return "";
  }

  if (config.nameRequired && !details.status_context_name) {
    return `${config.nameLabel} ist ein Pflichtfeld.`;
  }
  if (config.dateRequired && !details.status_context_date) {
    return `${config.dateLabel} ist ein Pflichtfeld.`;
  }
  if (details.status_context_date && !dayjs(details.status_context_date, "YYYY-MM-DD", true).isValid()) {
    return `${config.dateLabel} ist ungültig.`;
  }
  return "";
}


function buildAnimalTransitionSummary(status, details) {
  const config = getAnimalStatusContextConfig(status);
  const summaryParts = [];
  if (config?.nameLabel && details.status_context_name) {
    summaryParts.push(`${config.nameLabel}: ${details.status_context_name}`);
  }
  if (config?.dateLabel && details.status_context_date) {
    summaryParts.push(`${config.dateLabel}: ${formatDate(details.status_context_date)}`);
  }
  if (details.memorial_note) {
    summaryParts.push(details.memorial_note);
  }
  return summaryParts.join(" | ");
}

function resolveDefaultVeterinarianId(speciesId) {
  if (speciesId) {
    const fromSpecies = db.prepare("SELECT default_veterinarian_id FROM species WHERE id = ?").get(speciesId);
    if (fromSpecies?.default_veterinarian_id) {
      return fromSpecies.default_veterinarian_id;
    }
  }
  const fallback = String(getSettingsObject(db).default_veterinarian_id || "").trim();
  return fallback || null;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function combineDateAndTime(dateValue, timeValue, defaultTime = "09:00") {
  const date = String(dateValue || "").trim();
  if (!date) {
    return "";
  }

  const time = String(timeValue || "").trim() || defaultTime;
  return `${date}T${time}`;
}

function closeOpenRemindersForAnimal(animalId) {
  db.prepare(`
    UPDATE reminders
    SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        last_delivery_status = CASE
          WHEN source_kind IS NOT NULL THEN 'archived'
          ELSE 'closed'
        END,
        last_delivery_error = ''
    WHERE animal_id = ?
      AND completed_at IS NULL
  `).run(animalId);
}

async function sendInviteEmailForUser(req, user, options = {}) {
  const userId = user?.id;
  const name = String(user?.name || "").trim();
  const email = String(user?.email || "").trim().toLowerCase();
  const role = String(user?.role || "viewer");
  const auditSuccessAction = options.auditSuccessAction || "user.invite_email_sent";
  const auditFailureAction = options.auditFailureAction || "user.invite_email_failed";

  const inviteToken = crypto.randomBytes(32).toString("hex");
  const inviteTokenHash = crypto.createHash("sha256").update(inviteToken).digest("hex");
  const expiresAt = dayjs().add(48, "hour").format("YYYY-MM-DD HH:mm:ss");

  db.prepare("DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.prepare("INSERT INTO user_invites (user_id, token_hash, expires_at) VALUES (?, ?, ?)")
    .run(userId, inviteTokenHash, expiresAt);

  try {
    const settings = getSettingsObject(db);
    const appBaseUrl = resolveAppBaseUrl(settings);
    const inviteUrl = `${appBaseUrl}/invite/accept?token=${inviteToken}`;

    await sendUserInviteEmail(settings, {
      userId,
      name,
      email,
      roleLabel: getRoleLabel(role),
      inviteUrl,
    });

    createNotificationLog({
      userId: req.session.user?.id,
      channel: "email",
      type: "invite",
      recipient: email,
      subject: "Benutzer-Einladung",
      status: "sent",
      details: { target_user_id: userId },
    });
    createAuditLog(
      req,
      auditSuccessAction,
      { target_user_id: userId, email, role },
      { entityType: "user", entityId: userId }
    );
  } catch (error) {
    db.prepare("DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL").run(userId);
    createNotificationLog({
      userId: req.session.user?.id,
      channel: "email",
      type: "invite",
      recipient: email,
      subject: "Benutzer-Einladung",
      status: "error",
      error: error.message,
      details: { target_user_id: userId },
    });
    createAuditLog(
      req,
      auditFailureAction,
      { target_user_id: userId, email, role, error: error.message },
      { entityType: "user", entityId: userId }
    );
    throw error;
  }
}

async function notifyAdminsAboutCreatedUser(req, user) {
  const recipients = db.prepare(`
    SELECT email
    FROM users
    WHERE role = 'admin' AND id != ? AND TRIM(COALESCE(email, '')) != ''
    ORDER BY id ASC
  `).all(user.id).map((entry) => String(entry.email || "").trim().toLowerCase()).filter(Boolean);

  if (!recipients.length) {
    return;
  }

  const recipientLabel = recipients.join(", ");
  try {
    const settings = getSettingsObject(db);
    const appBaseUrl = resolveAppBaseUrl(settings);
    await sendUserCreatedAdminEmail(settings, {
      recipients,
      name: user.name,
      email: user.email,
      roleLabel: getRoleLabel(user.role),
      createdBy: req.session.user?.name || req.session.user?.email || "Administrator",
      usersUrl: `${appBaseUrl}/admin/benutzer`,
    });
    createNotificationLog({
      userId: req.session.user?.id,
      channel: "email",
      type: "admin_user_created",
      recipient: recipientLabel,
      subject: "Neuer Benutzer angelegt",
      status: "sent",
      details: { target_user_id: user.id },
    });
    createAuditLog(req, "user.admin_notification_sent", {
      target_user_id: user.id,
      email: user.email,
      recipients,
    }, { entityType: "user", entityId: user.id });
  } catch (error) {
    console.error("[HeartPet] Admin-Benachrichtigung fehlgeschlagen:", error.message);
    createNotificationLog({
      userId: req.session.user?.id,
      channel: "email",
      type: "admin_user_created",
      recipient: recipientLabel,
      subject: "Neuer Benutzer angelegt",
      status: "error",
      error: error.message,
      details: { target_user_id: user.id },
    });
    createAuditLog(req, "user.admin_notification_failed", {
      target_user_id: user.id,
      email: user.email,
      recipients,
      error: error.message,
    }, { entityType: "user", entityId: user.id });
  }
}

function renderNotFound(req, res, message) {
  res.status(404).render("pages/not-found", {
    pageTitle: "Nicht gefunden",
    message,
  });
}

function normalizeSettingsInputValue(key, value) {
  return String(value || "").trim();
}

function parseBooleanSettingValue(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function getRuntimeMetricsSnapshot() {
  return runtimeMetrics.snapshot();
}

function buildOperationalHealthChecks(settings) {
  const cameras = parseCoopCameras(settings.coop_camera_streams);
  const cachedCameras = cameras.filter((camera, index) => {
    const cached = cameraFrameCache.get(index) || readCameraFrameCache(index, camera.snapshotUrl);
    return cached?.createdAt && Date.now() - cached.createdAt < 5 * 60 * 1000;
  }).length;
  const xmlApi = homematic.getXmlApiConfig(settings);
  const ccuUsername = String(settings.homematic_ccu_username || "").trim();
  const ccuReady = Boolean(xmlApi?.token || ccuUsername);
  const ccuDetail = xmlApi?.token
    ? "XML-API mit Zugriffstoken"
    : ccuUsername
      ? "JSON-RPC mit Benutzeranmeldung"
      : xmlApi
        ? "XML-API-Token oder Benutzername fehlt"
        : "Nicht konfiguriert";
  return [
    ...buildCoreOperationalChecks({ db, dataDir }),
    { name: "OpenCCU", ok: ccuReady, detail: ccuDetail },
    { name: "Kameras", ok: cameras.length === 0 || cachedCameras === cameras.length, detail: cameras.length ? `${cachedCameras}/${cameras.length} mit aktuellem Cache` : "Keine Kameras konfiguriert" },
    { name: "Wetter", ok: Boolean(settings.weather_latitude && settings.weather_longitude), detail: weatherCache.size ? "Cache aktiv" : "Noch kein Cachewert" },
    { name: "Benachrichtigungen", ok: isEmailConfigured(settings) || isTelegramConfigured(settings) || isNtfyConfigured(settings), detail: "Mindestens ein Kanal konfiguriert" },
  ];
}


function getAppLogoUrl(settings) {
  const storedName = String(settings?.app_logo_stored_name || "").trim();
  return storedName ? "/app-logo" : "/static/images/logo-heartpet.png";
}

function getAppIconVersion() {
  const storedName = String(getSettingsObject(db).app_logo_stored_name || "").trim();
  return storedName || runtimeRevision;
}

function getAppLogoFilePath(settings) {
  const storedName = String(settings?.app_logo_stored_name || "").trim();
  if (!storedName) {
    return path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
  }
  return resolveStoredFilePath(uploadsDir, storedName) || path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
}

function safeDeleteUploadedFile(storedName, ignoreName = "") {
  const fileName = String(storedName || "").trim();
  if (!fileName || fileName === String(ignoreName || "").trim()) {
    return;
  }

  const fullPath = resolveStoredFilePath(uploadsDir, fileName);
  if (fullPath && fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch (error) {
      console.warn("[HeartPet] Altes Logo konnte nicht geloescht werden:", error.message);
    }
  }
}

function ensureSpeciesExists(name) {
  const existing = db.prepare("SELECT * FROM species WHERE name = ?").get(name);
  if (existing) {
    return existing;
  }

  const result = db.prepare("INSERT INTO species (name) VALUES (?)").run(name);
  return db.prepare("SELECT * FROM species WHERE id = ?").get(result.lastInsertRowid);
}

function ensureDocumentCategoryExists(name) {
  if (!name) {
    return null;
  }

  const existing = db.prepare("SELECT * FROM document_categories WHERE name = ?").get(name);
  if (existing) {
    return existing;
  }

  const result = db.prepare("INSERT INTO document_categories (name) VALUES (?)").run(String(name));
  return db.prepare("SELECT * FROM document_categories WHERE id = ?").get(result.lastInsertRowid);
}

function resolveImportedCategoryId(categoryRef) {
  if (!categoryRef) {
    return null;
  }

  if (Number.isInteger(categoryRef)) {
    return categoryRef;
  }

  const category = ensureDocumentCategoryExists(String(categoryRef));
  return category?.id || null;
}

function restoreEmbeddedFile(embeddedFile) {
  if (!embeddedFile || !embeddedFile.content) {
    return null;
  }

  fs.mkdirSync(uploadsDir, { recursive: true });

  const originalName = embeddedFile.original_name || embeddedFile.stored_name || "datei";
  const storedName = createStoredUploadName(embeddedFile.mime_type);
  const fullPath = resolveStoredFilePath(uploadsDir, storedName);
  const buffer = Buffer.from(embeddedFile.content, "base64");

  fs.writeFileSync(fullPath, buffer);

  return {
    stored_name: storedName,
    original_name: originalName,
    mime_type: embeddedFile.mime_type || "",
    file_size: buffer.length,
  };
}

function deleteUploadedFileIfUnreferenced(storedName) {
  if (!storedName) {
    return;
  }

  const referenceCount =
    db.prepare("SELECT COUNT(*) AS count FROM animals WHERE profile_image_stored_name = ?").get(storedName).count +
    db.prepare("SELECT COUNT(*) AS count FROM animal_images WHERE stored_name = ?").get(storedName).count +
    db.prepare("SELECT COUNT(*) AS count FROM documents WHERE stored_name = ?").get(storedName).count +
    db.prepare("SELECT COUNT(*) AS count FROM animal_vaccinations WHERE certificate_stored_name = ?").get(storedName).count;

  if (referenceCount > 0) {
    return;
  }

  const fullPath = resolveStoredFilePath(uploadsDir, storedName);
  if (fullPath && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

function discardUploadedFile(file) {
  if (file?.filename) {
    deleteUploadedFileIfUnreferenced(file.filename);
  }
}

function getVaccinationCertificateError(file) {
  if (!file) return "";
  const mimeType = String(file.mimetype || "").toLowerCase();
  if (mimeType !== "application/pdf" && !mimeType.startsWith("image/")) {
    return "Als Impfnachweis sind nur PDF- oder Bilddateien erlaubt.";
  }
  if (Number(file.size || 0) > 10 * 1024 * 1024) {
    return "Der Impfnachweis darf höchstens 10 MB groß sein.";
  }
  return "";
}

function normalizeUserPermissions(role, body = {}) {
  if (role === "admin") {
    return {
      can_edit_animals: 1,
      can_manage_documents: 1,
      can_manage_gallery: 1,
      can_manage_health: 1,
      can_manage_feedings: 1,
      can_manage_notes: 1,
      can_manage_reminders: 1,
    };
  }

  if (role === "viewer") {
    return {
      can_edit_animals: 0,
      can_manage_documents: 0,
      can_manage_gallery: 0,
      can_manage_health: 0,
      can_manage_feedings: 0,
      can_manage_notes: 0,
      can_manage_reminders: 0,
    };
  }

  return {
    can_edit_animals: body.can_edit_animals ? 1 : 0,
    can_manage_documents: body.can_manage_documents ? 1 : 0,
    can_manage_gallery: body.can_manage_gallery ? 1 : 0,
    can_manage_health: body.can_manage_health ? 1 : 0,
    can_manage_feedings: body.can_manage_feedings ? 1 : 0,
    can_manage_notes: body.can_manage_notes ? 1 : 0,
    can_manage_reminders: body.can_manage_reminders ? 1 : 0,
  };
}

function createAuditLog(req, action, details = {}, options = {}) {
  const actor = req?.session?.user || null;
  db.prepare(`
    INSERT INTO audit_logs (actor_user_id, actor_email, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    actor?.id || null,
    actor?.email || "",
    action,
    options.entityType || "",
    options.entityId != null ? String(options.entityId) : "",
    JSON.stringify(sanitizeDiagnosticDetails(details || {}))
  );
}

function isSensitiveAuditField(key) {
  return /password|token|secret|authorization|cookie|smtp|url/i.test(String(key || ""));
}

function sanitizeDiagnosticDetails(value, key = "") {
  if (isSensitiveAuditField(key)) return "[geschützt]";
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticDetails(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeDiagnosticDetails(childValue, childKey)]));
  }
  return typeof value === "string" ? redactSensitiveText(value) : value;
}

function createNotificationLog({ userId = null, channel, type, recipient = "", subject = "", status, error = "", details = {} }) {
  db.prepare(`
    INSERT INTO notification_logs (user_id, channel, notification_type, recipient, subject, status, error_message, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId || null,
    String(channel || "unknown"),
    String(type || "generic"),
    String(recipient || ""),
    String(subject || ""),
    String(status || "unknown"),
    String(error || ""),
    JSON.stringify(details || {})
  );
}

function getLastSuccessfulNotificationCheck(channel, types = ["test"]) {
  const placeholders = types.map(() => "?").join(", ");
  return db.prepare(`
    SELECT created_at
    FROM notification_logs
    WHERE channel = ?
      AND status = 'sent'
      AND notification_type IN (${placeholders})
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get(channel, ...types) || null;
}

function buildSeoMeta(req, settings) {
  const appName = String(settings?.app_name || "HeartPet").trim();
  return {
    description: `${appName} ist eine private Tierverwaltung.`,
    robots: "noindex,nofollow,noarchive,nosnippet",
  };
}

function parseAuditDetails(rawValue) {
  try {
    const parsed = rawValue ? JSON.parse(rawValue) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function duplicateAnimalRecord(animal, fileCopies) {
  const copiedAnimal = {
    ...animal,
    name: `${animal.name} (Kopie)`,
    profile_image_stored_name: animal.profile_image_stored_name
      ? fileCopies.get(animal.profile_image_stored_name)
      : null,
  };
  const animalColumns = db.prepare("PRAGMA table_info(animals)").all()
    .map((column) => column.name)
    .filter((column) => !["id", "created_at", "updated_at"].includes(column));
  const animalInsert = db.prepare(`
    INSERT INTO animals (${animalColumns.join(", ")}, created_at, updated_at)
    VALUES (${animalColumns.map((column) => `@${column}`).join(", ")}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(copiedAnimal);
  const newAnimalId = Number(animalInsert.lastInsertRowid);

  const idMaps = new Map();
  const copyRows = (tableName, transform = (row) => row) => {
    const rows = db.prepare(`SELECT * FROM ${tableName} WHERE animal_id = ? ORDER BY id`).all(animal.id);
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
      .map((column) => column.name)
      .filter((column) => column !== "id");
    const insert = db.prepare(`
      INSERT INTO ${tableName} (${columns.join(", ")})
      VALUES (${columns.map((column) => `@${column}`).join(", ")})
    `);
    const rowMap = new Map();
    rows.forEach((row) => {
      const payload = { ...row, ...transform(row), animal_id: newAnimalId };
      const result = insert.run(payload);
      rowMap.set(Number(row.id), Number(result.lastInsertRowid));
    });
    idMaps.set(tableName, rowMap);
  };

  copyRows("animal_conditions");
  copyRows("animal_medications");
  copyRows("animal_vaccinations", (row) => ({
    certificate_stored_name: row.certificate_stored_name
      ? fileCopies.get(row.certificate_stored_name)
      : null,
  }));
  copyRows("animal_appointments");
  copyRows("animal_feedings");
  copyRows("animal_notes");
  copyRows("documents", (row) => ({ stored_name: fileCopies.get(row.stored_name) }));
  copyRows("animal_images", (row) => ({ stored_name: fileCopies.get(row.stored_name) }));
  copyRows("reminders", (row) => {
    const sourceTable = {
      medication: "animal_medications",
      vaccination: "animal_vaccinations",
      appointment: "animal_appointments",
    }[row.source_kind];
    return {
      source_id: sourceTable && row.source_id ? idMaps.get(sourceTable)?.get(Number(row.source_id)) || null : null,
      last_notified_at: null,
      last_delivery_status: null,
      last_delivery_error: null,
    };
  });

  return newAnimalId;
}

function formatAuditLogEntry(entry) {
  const details = parseAuditDetails(entry.details);
  const actorLabel = entry.actor_email || "-";
  const entityType = entry.entity_type || "-";
  const entityId = entry.entity_id || "";
  const fallback = {
    actorLabel,
    actionLabel: entry.action,
    entityLabel: `${entityType}${entityId ? ` #${entityId}` : ""}`.trim(),
    detailsLabel: Object.keys(details || {}).length ? JSON.stringify(details) : "-",
    ...entry,
  };

  const make = (actionLabel, entityLabel, detailsLabel) => ({
    ...fallback,
    actionLabel,
    entityLabel,
    detailsLabel,
  });

  switch (entry.action) {
    case "coop.door_open":
      return make("Stalltür geöffnet", "Hühnerstall", "Homematic-Befehl erfolgreich gesendet");
    case "coop.door_open_failed":
      return make("Stalltür-Befehl fehlgeschlagen", "Hühnerstall", details.error || "Homematic nicht erreichbar");
    case "coop.door_close":
      return make("Stalltür geschlossen", "Hühnerstall", "Homematic-Befehl erfolgreich gesendet");
    case "coop.door_close_failed":
      return make("Stalltür-Befehl fehlgeschlagen", "Hühnerstall", details.error || "Homematic nicht erreichbar");
    case "coop.climate_check":
      return make("CCU-Klima geprüft", "Hühnerstall", `${details.temperature ?? "-"} °C · ${details.humidity ?? "-"} % Luftfeuchte`);
    case "coop.climate_check_failed":
      return make("CCU-Klimaprüfung fehlgeschlagen", "Hühnerstall", `${details.stage || "unbekannte Phase"} · ${details.error || "Homematic nicht erreichbar"}`);
    case "animal.create":
      return make("Tier angelegt", details.name || `Tier #${details.animal_id || entityId}`, details.transition_summary || `Status: ${details.status || "Aktiv"}`);
    case "animal.update":
      return make("Tier bearbeitet", details.name || `Tier #${details.animal_id || entityId}`, details.transition_details_updated ? "Abschlussdaten angepasst" : "Tierdaten aktualisiert");
    case "animal.duplicate":
      return make("Tier kopiert", details.name || `Tier #${details.animal_id || entityId}`, `Vollständige Kopie von Tier #${details.source_animal_id || "-"}`);
    case "animal.status_change":
      return make("Tierstatus geändert", details.name || `Tier #${details.animal_id || entityId}`, `${details.previous_status || "-"} -> ${details.next_status || "-"}${details.transition_summary ? ` · ${details.transition_summary}` : ""}`);
    case "animal.delete":
      return make("Tier gelöscht", details.name || `Tier #${details.animal_id || entityId}`, "Akte und zugehörige Inhalte entfernt");
    case "vaccination.bulk_create":
      return make(
        "Gruppenimpfung eingetragen",
        details.name || `Impfung #${entityId}`,
        `${Array.isArray(details.animal_names) ? details.animal_names.join(", ") : String(details.animal_names || "-")} · ${details.vaccination_date || "-"}`,
      );
    case "veterinarian.create":
      return make("Tierarzt angelegt", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, [details.city, details.email].filter(Boolean).join(" · ") || "Neuer Tierarzt hinterlegt");
    case "veterinarian.update":
      return make("Tierarzt bearbeitet", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, [details.city, details.email].filter(Boolean).join(" · ") || "Kontaktdaten aktualisiert");
    case "veterinarian.set_default":
      return make("Standardtierarzt gesetzt", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, "Wird als Fallback für neue Zuordnungen verwendet");
    case "veterinarian.delete":
      return make("Tierarzt gelöscht", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, "Eintrag aus den Stammdaten entfernt");
    case "disposal_facility.create":
      return make("Tierkörperbeseitigungsanlage angelegt", details.name || `Anlage #${entityId}`, [details.federal_state, details.city].filter(Boolean).join(" · "));
    case "disposal_facility.update":
      return make("Tierkörperbeseitigungsanlage bearbeitet", details.name || `Anlage #${entityId}`, [details.federal_state, details.city].filter(Boolean).join(" · "));
    case "disposal_facility.delete":
      return make("Tierkörperbeseitigungsanlage gelöscht", details.name || `Anlage #${entityId}`, "Eintrag aus den Stammdaten entfernt");
    case "species.create":
      return make("Tierart angelegt", details.name || `Tierart #${details.species_id || entityId}`, details.default_veterinarian_id ? `Standardtierarzt: #${details.default_veterinarian_id}` : "Ohne Standardtierarzt");
    case "species.update":
      return make("Tierart bearbeitet", details.name || `Tierart #${details.species_id || entityId}`, details.default_veterinarian_id ? `Standardtierarzt: #${details.default_veterinarian_id}` : "Einstellungen aktualisiert");
    case "species.delete":
      return make("Tierart gelöscht", details.name || `Tierart #${details.species_id || entityId}`, "Eintrag aus den Stammdaten entfernt");
    case "category.create":
      return make("Kategorie angelegt", details.name || `Kategorie #${details.category_id || entityId}`, details.is_required ? "Pflichtkategorie" : "Optionale Kategorie");
    case "category.update":
      return make("Kategorie bearbeitet", details.name || `Kategorie #${details.category_id || entityId}`, details.is_required ? "Pflichtkategorie" : "Optionale Kategorie");
    case "category.delete":
      return make("Kategorie gelöscht", details.name || `Kategorie #${details.category_id || entityId}`, "Eintrag aus den Stammdaten entfernt");
    case "user.create":
      return make("Benutzer angelegt", details.email || `Benutzer #${details.target_user_id || entityId}`, `Rolle: ${details.role || "-"}`);
    case "user.delete":
      return make("Benutzer gelöscht", details.email || `Benutzer #${details.target_user_id || entityId}`, "Zugang entfernt");
    case "user.invite_email_sent":
      return make("Einladungs-Mail versendet", details.email || `Benutzer #${details.user_id || entityId}`, "Erste Einladung erfolgreich verschickt");
    case "user.invite_email_resent":
      return make("Einladungs-Mail erneut versendet", details.email || `Benutzer #${details.user_id || entityId}`, "Offene Einladung erneut verschickt");
    case "user.invite_email_failed":
    case "user.invite_email_resend_failed":
      return make("Einladungs-Mail fehlgeschlagen", details.email || `Benutzer #${details.user_id || entityId}`, details.error || "Versandfehler");
    case "user.admin_notification_sent":
      return make("Admin informiert", details.email || `Benutzer #${details.target_user_id || entityId}`, "Neuer Benutzer wurde den Administratoren gemeldet");
    case "user.admin_notification_failed":
      return make("Admin-Benachrichtigung fehlgeschlagen", details.email || `Benutzer #${details.target_user_id || entityId}`, details.error || "Versandfehler");
    default:
      return fallback;
  }
}

function formatAnimalActivityEntry(entry) {
  const details = parseAuditDetails(entry.details);
  const animalName = details.name || details.title || entry.current_animal_name || "Tier";
  switch (entry.action) {
    case "animal.create":
      return {
        at: entry.created_at,
        title: `${animalName} angelegt`,
        details: details.transition_summary || "Neue Tierakte erstellt.",
      };
    case "animal.status_change":
      return {
        at: entry.created_at,
        title: `${animalName}: ${details.previous_status || "Aktiv"} → ${details.next_status || ""}`.trim(),
        details: details.transition_summary || "Statuswechsel dokumentiert.",
      };
    case "animal.note_create":
      return {
        at: entry.created_at,
        title: `Protokoll ergänzt: ${details.title || "Eintrag"}`,
        details: "Neuer Verlaufseintrag gespeichert.",
      };
    case "animal.note_update":
      return {
        at: entry.created_at,
        title: `Protokoll aktualisiert: ${details.title || "Eintrag"}`,
        details: "Vorhandener Verlaufseintrag angepasst.",
      };
    case "animal.note_delete":
      return {
        at: entry.created_at,
        title: "Protokoll entfernt",
        details: "Ein Verlaufseintrag wurde gelöscht.",
      };
    case "animal.document_create":
      return {
        at: entry.created_at,
        title: `Dokument hochgeladen: ${details.title || "Dokument"}`,
        details: "Neue Unterlage an der Akte gespeichert.",
      };
    case "animal.document_update":
      return {
        at: entry.created_at,
        title: `Dokument aktualisiert: ${details.title || "Dokument"}`,
        details: "Titel oder Kategorie wurden angepasst.",
      };
    case "animal.document_delete":
      return {
        at: entry.created_at,
        title: `Dokument gelöscht: ${details.title || "Dokument"}`,
        details: "Unterlage aus der Akte entfernt.",
      };
    case "animal.image_create":
      return {
        at: entry.created_at,
        title: `Foto ergänzt${details.title ? `: ${details.title}` : ""}`,
        details: "Galerie wurde erweitert.",
      };
    case "animal.image_update":
      return {
        at: entry.created_at,
        title: `Foto aktualisiert${details.title ? `: ${details.title}` : ""}`,
        details: "Der Bildtitel wurde angepasst.",
      };
    case "animal.image_delete":
      return {
        at: entry.created_at,
        title: `Foto gelöscht${details.title ? `: ${details.title}` : ""}`,
        details: "Galeriebild aus der Akte entfernt.",
      };
    case "animal.profile_image_update":
      return {
        at: entry.created_at,
        title: "Profilbild aktualisiert",
        details: details.original_name || "Profilbild wurde neu gesetzt.",
      };
    case "animal.profile_image_delete":
      return {
        at: entry.created_at,
        title: "Profilbild entfernt",
        details: "Das Titelbild der Akte wurde gelöscht.",
      };
    case "animal.update":
    default:
      return {
        at: entry.created_at,
        title: `${animalName} bearbeitet`,
        details: details.transition_details_updated ? "Abschlussdaten wurden angepasst." : "Tierdaten aktualisiert.",
      };
  }
}

function getAnimalActivityEntries(animalId, limit = 12) {
  return db.prepare(`
    SELECT audit_logs.*, animals.name AS current_animal_name
    FROM audit_logs
    LEFT JOIN animals
      ON audit_logs.entity_type = 'animal'
     AND CAST(audit_logs.entity_id AS INTEGER) = animals.id
    WHERE audit_logs.entity_type = 'animal'
      AND audit_logs.entity_id = ?
      AND audit_logs.action IN (
        'animal.create', 'animal.update', 'animal.status_change',
        'animal.note_create', 'animal.note_update', 'animal.note_delete',
        'animal.document_create', 'animal.document_update', 'animal.document_delete',
        'animal.image_create', 'animal.image_update', 'animal.image_delete',
        'animal.profile_image_update', 'animal.profile_image_delete'
      )
    ORDER BY audit_logs.id DESC
    LIMIT ?
  `).all(String(animalId), limit).map(formatAnimalActivityEntry);
}

function getAdminViewData(pageTitle, adminPath) {
  const settings = getSettingsObject(db);
  const lastSuccessfulEmailCheck = getLastSuccessfulNotificationCheck("email", ["test", "smtp_connection_check"]);
  const lastSuccessfulTelegramCheck = getLastSuccessfulNotificationCheck("telegram", ["test"]);
  const lastSuccessfulNtfyCheck = getLastSuccessfulNotificationCheck("ntfy", ["test"]);
  return {
    pageTitle: `Admin · ${pageTitle}`,
    adminPageTitle: pageTitle,
    adminPath,
    settings,
    instanceTimezone: getInstanceTimeZone(),
    timeZoneOptions: listTimeZones(),
    federalStates: FEDERAL_STATES,
    communicationStatus: {
      emailReady: isEmailConfigured(settings),
      telegramReady: isTelegramConfigured(settings),
      ntfyReady: isNtfyConfigured(settings),
      emailLastSuccessfulCheckAt: lastSuccessfulEmailCheck?.created_at || "",
      telegramLastSuccessfulCheckAt: lastSuccessfulTelegramCheck?.created_at || "",
      ntfyLastSuccessfulCheckAt: lastSuccessfulNtfyCheck?.created_at || "",
    },
    defaultVeterinarianId: String(settings.default_veterinarian_id || ""),
    categories: db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all(),
    species: db.prepare(`
      SELECT species.*, veterinarians.name AS veterinarian_name
      FROM species
      LEFT JOIN veterinarians ON veterinarians.id = species.default_veterinarian_id
      ORDER BY species.name ASC
    `).all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    disposalFacilities: db.prepare("SELECT * FROM disposal_facilities ORDER BY federal_state ASC, name ASC").all(),
    vaccinationPresets: db.prepare("SELECT * FROM vaccination_presets ORDER BY species_name COLLATE NOCASE, name COLLATE NOCASE").all(),
    users: db.prepare(`
      SELECT
        id, name, email, role, must_change_password, created_at,
        last_login_at, last_seen_at, last_logout_at,
        CASE
          WHEN last_seen_at IS NOT NULL
            AND datetime(last_seen_at) >= datetime('now', '-5 minutes')
            AND (last_logout_at IS NULL OR datetime(last_seen_at) > datetime(last_logout_at))
          THEN 1 ELSE 0
        END AS is_online,
        can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
        can_manage_feedings, can_manage_notes, can_manage_reminders
      FROM users
      ORDER BY created_at ASC
    `).all(),
  };
}

function getAdminShellViewData(pageTitle, adminPath) {
  return {
    pageTitle: `Admin · ${pageTitle}`,
    adminPageTitle: pageTitle,
    adminPath,
  };
}

function getInstanceTimeZone() {
  return resolveInstanceTimeZone(getSettingsObject(db));
}

function backTo(req, fallback) {
  const referer = req.get("referer");
  if (!referer) {
    return fallback;
  }

  try {
    const url = new URL(referer);
    return url.pathname.startsWith("/admin") ? url.pathname : fallback;
  } catch {
    return fallback;
  }
}

function isDrawerRequest(req) {
  return String(req.get("X-Requested-With") || "").trim().toLowerCase() === "heartpet-drawer";
}

function buildDrawerRedirectPath(basePath, drawerPath) {
  const safeBasePath = safeLocalReturnPath(basePath, "/");
  const safeDrawerPath = safeLocalReturnPath(drawerPath, "");
  if (!safeDrawerPath) {
    return safeBasePath;
  }

  const url = new URL(safeBasePath, "http://heartpet.local");
  url.searchParams.set("drawer", safeDrawerPath);
  return `${url.pathname}${url.search}${url.hash}`;
}

function redirectDocumentDrawerRequest(req, res, fallbackPath, explicitDrawerPath = "") {
  const target = buildDrawerRedirectPath(fallbackPath, explicitDrawerPath || req.originalUrl);
  return res.redirect(target);
}

function redirectAfterPost(res, targetPath) {
  return res.redirect(303, targetPath);
}

function safeLocalReturnPath(value, fallback) {
  const candidate = String(value || "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallback;
  }

  try {
    const url = new URL(candidate, "http://heartpet.local");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

function safeRefererPath(req, fallback) {
  const referer = String(req.get("referer") || "").trim();
  if (!referer) return fallback;

  try {
    const url = new URL(referer, `${req.protocol}://${req.get("host")}`);
    if (url.host !== req.get("host")) return fallback;
    return safeLocalReturnPath(`${url.pathname}${url.search}${url.hash}`, fallback);
  } catch {
    return fallback;
  }
}

function getAnimalReturnTo(req, fallback) {
  const queryTarget = safeLocalReturnPath(req.query.return_to, "");
  if (queryTarget) {
    return queryTarget;
  }

  const referer = req.get("referer");
  if (!referer) {
    return fallback;
  }

  try {
    const url = new URL(referer);
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (target.startsWith("/animals") || target === "/") {
      return target;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

async function requestEmailChangeConfirmation({ userId, requestedByUserId, newEmail, displayName }) {
  const normalizedEmail = String(newEmail || "").trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Neue E-Mail-Adresse fehlt.");
  }

  const settings = getSettingsObject(db);
  if (!settings.smtp_host || !settings.smtp_from) {
    throw new Error("SMTP ist nicht vollständig konfiguriert.");
  }

  const existingConflict = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(normalizedEmail, userId);
  if (existingConflict) {
    throw new Error("Diese E-Mail-Adresse wird bereits verwendet.");
  }

  const pendingConflict = db.prepare(`
    SELECT id
    FROM email_change_requests
    WHERE new_email = ?
      AND user_id != ?
      AND confirmed_at IS NULL
      AND expires_at >= CURRENT_TIMESTAMP
  `).get(normalizedEmail, userId);
  if (pendingConflict) {
    throw new Error("Diese E-Mail-Adresse wartet bereits auf eine andere Bestätigung.");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = dayjs().add(24, "hour").format("YYYY-MM-DD HH:mm:ss");
  const appBaseUrl = resolveAppBaseUrl(settings);
  const confirmUrl = `${appBaseUrl}/email-change/confirm?token=${token}`;

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM email_change_requests WHERE user_id = ? AND confirmed_at IS NULL").run(userId);
    db.prepare(`
      INSERT INTO email_change_requests (user_id, requested_by_user_id, new_email, token_hash, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, requestedByUserId || null, normalizedEmail, tokenHash, expiresAt);
  });
  tx();

  try {
    await sendEmailChangeConfirmation(settings, {
      recipient: normalizedEmail,
      name: displayName || "Nutzer",
      confirmUrl,
    });
    createNotificationLog({
      userId: requestedByUserId || null,
      channel: "email",
      type: "email_change_confirmation",
      recipient: normalizedEmail,
      subject: "E-Mail-Änderung bestätigen",
      status: "sent",
      details: { user_id: userId },
    });
  } catch (error) {
    db.prepare("DELETE FROM email_change_requests WHERE token_hash = ?").run(tokenHash);
    createNotificationLog({
      userId: requestedByUserId || null,
      channel: "email",
      type: "email_change_confirmation",
      recipient: normalizedEmail,
      subject: "E-Mail-Änderung bestätigen",
      status: "error",
      error: error.message,
      details: { user_id: userId },
    });
    throw error;
  }
}

function resolveAppBaseUrl(settings) {
  return resolveConfiguredAppBaseUrl(settings, {
    fallbackUrl: getDefaultAppBaseUrl({ port, bindHost }),
  });
}

app.__test = {
  maybeSendDailyDigest: reminderScheduler.sendDailyDigest,
  createAuthenticatedFetchTarget,
  buildDigestAuthorization,
  normalizeConfiguredUrl,
  buildHomematicClimateUrl,
  buildHomematicCommandUrl,
  buildHomematicXmlApiUrl,
  normalizeHomematicXmlApiToken,
  parseHomematicStateChange,
  getHomematicDoorCommand,
  getHomematicDoorCommandSequence,
  parseWritableHomematicDatapoints,
  parseHomematicDatapoints,
  decodeHomematicXmlBuffer,
  getHomematicCommandResponseError,
  resolveRenewedHomematicSid,
  shouldReplaceHomematicSessionAfterRenewError,
  getHomematicLoginRetryDelay,
  findHomematicValue,
  parseHomematicTextValue,
  findHomematicXmlDatapoint,
  parseCoopCameras,
  buildCameraPlaceholderSvg,
  redactSensitiveText,
  getWeatherCodeMeta,
  isValidEmail,
  safeRefererPath,
  resolveStoredFilePath: (storedName) => resolveStoredFilePath(uploadsDir, storedName),
};

module.exports = app;
