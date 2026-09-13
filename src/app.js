const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const cron = require("node-cron");
const bcrypt = require("bcryptjs");
const dayjs = require("dayjs");

const { initDatabase, getSettingsObject, upsertSetting } = require("./db");
const { createSessionMiddleware } = require("./http-session");
const { createImportUploadMiddleware, createStoredUploadName, createUploadMiddleware } = require("./uploads");
const {
  buildPermissions,
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
const { buildCoreOperationalChecks, summarizeOperationalChecks } = require("./operational-health");
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
const { createAnimalWorkspaceService } = require("./services/animal-workspace");
const { createAnimalsRouter } = require("./routes/animals");
const { createAnimalRecordsRouter } = require("./routes/animal-records");
const { createAnimalMediaRouter } = require("./routes/animal-media");
const { createAnimalHealthRouter } = require("./routes/animal-health");
const { createAnimalRemindersRouter } = require("./routes/animal-reminders");
const { createAuthRouter } = require("./routes/auth");
const { createCoopRouter } = require("./routes/coop");
const { createWeatherService, getWeatherCodeMeta } = require("./services/weather");
const { createCameraService } = require("./services/camera");
const { createAnimalReminderService } = require("./services/animal-reminders");
const { createMasterdataRouter } = require("./routes/masterdata");
const { createSystemlogRouter } = require("./routes/systemlog");
const { createErrorHandler } = require("./middleware/error-handler");

const app = express();
app.set("trust proxy", process.env.HEARTPET_TRUST_PROXY || "loopback");
const db = initDatabase();
const animalRepository = createAnimalRepository(db);
const systemlogRepository = createSystemlogRepository(db);
const projectRoot = path.join(__dirname, "..");
const revisionPath = path.join(projectRoot, "REVISION");
const runtimeRevision = readAppRevision();
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
const runtimeMetrics = { startedAt: Date.now(), requests: 0, errors: 0, totalDurationMs: 0, slowestDurationMs: 0, recent: [] };
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
const { readOutdoorWeather } = createWeatherService({
  cache: weatherCache,
  fetchWithTimeout,
  describeFetchError,
  getTimeZone: getInstanceTimeZone,
});
const {
  appendVeterinarianNote,
  applyCompletionSideEffects,
  createSupplementalEventReminders,
  deleteGeneratedReminders,
  resyncAllGeneratedReminders,
  syncAppointmentReminders,
  syncMedicationReminders,
  syncVaccinationReminders,
} = createAnimalReminderService({ db, getSettingsObject, parsePositiveInteger });
const animalWorkspace = createAnimalWorkspaceService({
  db,
  animalRepository,
  attachAnimalWorkspaceMeta,
  attachNextTermData,
  buildAnimalTimeline,
  buildMicrochipLinks,
  buildReminderSourceMap,
  filterDocuments,
  getAnimalActivityEntries,
  getAnimalSectionConfig,
  getMissingRequiredCategories,
  isAnimalProfileIncomplete,
  listActiveSpecies,
  sortAnimals,
  splitReminders,
  summarizeReminderState,
});

app.set("view engine", "ejs");
app.set("views", path.join(projectRoot, "views"));

app.disable("x-powered-by");
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    if (req.path.startsWith("/static/")) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    runtimeMetrics.requests += 1;
    runtimeMetrics.totalDurationMs += durationMs;
    runtimeMetrics.slowestDurationMs = Math.max(runtimeMetrics.slowestDurationMs, durationMs);
    if (res.statusCode >= 500) runtimeMetrics.errors += 1;
    runtimeMetrics.recent.push({ method: req.method, path: req.path, status: res.statusCode, durationMs, at: new Date().toISOString() });
    if (runtimeMetrics.recent.length > 50) runtimeMetrics.recent.shift();
  });
  next();
});
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
  const logoUrl = getAppLogoUrl(getSettingsObject(db)) || "/static/images/logo-heartpet.png";
  return res.redirect(302, logoUrl);
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
    revision: runtimeRevision,
    availableRevision,
    restartRequired,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use(createSessionMiddleware(dataDir));

app.use((req, res, next) => {
  const flash = req.session.flash || null;
  delete req.session.flash;
  let currentUserRecord = req.session.user
    ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id)
    : null;

  if (currentUserRecord && Number(req.session.user.sessionVersion || 0) !== Number(currentUserRecord.session_version || 0)) {
    delete req.session.user;
    currentUserRecord = null;
  }

  if (currentUserRecord) {
    const lastPresenceWrite = Number(userPresenceWrites.get(currentUserRecord.id) || 0);
    if (Date.now() - lastPresenceWrite >= 60_000) {
      db.prepare("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(currentUserRecord.id);
      userPresenceWrites.set(currentUserRecord.id, Date.now());
    }
    req.session.user = {
      id: currentUserRecord.id,
      name: currentUserRecord.name,
      email: currentUserRecord.email,
      role: currentUserRecord.role,
      mustChangePassword: Boolean(currentUserRecord.must_change_password),
      sessionVersion: Number(currentUserRecord.session_version || 0),
    };
  }

  res.locals.flash = flash;
  res.locals.currentUser = req.session.user || null;
  res.locals.appSettings = getSettingsObject(db);
  res.locals.appBaseUrl = resolveAppBaseUrl(res.locals.appSettings);
  res.locals.appLogoUrl = getAppLogoUrl(res.locals.appSettings);
  res.locals.currentPath = req.path;
  res.locals.currentQuery = req.query || {};
  res.locals.appRevision = runtimeRevision;
  res.locals.runtimeFeatures = { memorialNoteEditor: true, vaccinationPresets: true };
  res.locals.fieldConstraints = htmlConstraints;
  res.locals.seoMeta = buildSeoMeta(req, res.locals.appSettings);
  res.locals.animalSpeciesMenu = listActiveSpecies();
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.getAnimalAge = getAnimalAge;
  res.locals.getAnimalInitial = getAnimalInitial;
  res.locals.getAnimalSpeciesIcon = getAnimalSpeciesIcon;
  res.locals.getRoleLabel = getRoleLabel;
  res.locals.getAnimalLifecycle = getAnimalLifecycle;
  res.locals.getReminderStatusMeta = getReminderStatusMeta;
  res.locals.applyInfoPagePlaceholders = (content) => applyInfoPagePlaceholders(content, res.locals.appSettings);
  res.locals.permissions = buildPermissions(currentUserRecord || req.session.user);
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

  if (!setupComplete && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (setupComplete && req.path.startsWith("/setup")) {
    return res.redirect(req.session.user ? "/" : "/login");
  }

  next();
});

app.use(createAuthRouter({
  db, isSetupComplete, setFlash, validateNewPassword, normalizeVeterinarianPayload,
  validateVeterinarian, passwordHashRounds: PASSWORD_HASH_ROUNDS, ensureSpeciesExists,
  upsertSetting, regenerateSession, safeLocalReturnPath, loginAttempts, userPresenceWrites,
  requireAuth, passwordResetAttempts, getSettingsObject, resolveAppBaseUrl,
  sendPasswordResetEmail, createNotificationLog, createAuditLog,
}));

app.get("/reminders/:id/email-complete", (req, res) => {
  const reminder = db.prepare(`
    SELECT reminders.*, animals.status AS animal_status
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.id = ?
  `).get(req.params.id);
  const settings = getSettingsObject(db);
  const appBaseUrl = resolveAppBaseUrl(settings);
  const dashboardUrl = `${appBaseUrl}/`;

  if (!reminder) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Erinnerung nicht gefunden",
      success: false,
      title: "Erinnerung nicht gefunden",
      message: "Diese Erinnerungs-Mail gehört nicht mehr zu einer vorhandenen Erinnerung oder wurde bereits gelöscht.",
      nextUrl: dashboardUrl,
      nextLabel: "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  if (!verifyReminderActionToken(reminder, "complete", req.query.token)) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Link ungültig",
      success: false,
      title: "Link ungültig",
      message: "Der Bestätigungslink ist ungültig oder wurde verändert. Bitte öffne die Tierakte und markiere die Erinnerung dort.",
      nextUrl: dashboardUrl,
      nextLabel: "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  if (reminder.animal_id && !isActiveAnimalStatus(reminder.animal_status)) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Tier nicht mehr aktiv",
      success: false,
      title: "Tier nicht mehr aktiv",
      message: "Diese Erinnerung gehört zu einem Tier, das nicht mehr im aktiven Bestand ist. Es werden dafür keine Erinnerungen mehr versendet.",
      nextUrl: dashboardUrl,
      nextLabel: "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  if (reminder.completed_at) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Bereits erledigt",
      success: true,
      title: "Erinnerung bereits erledigt",
      message: "Diese Erinnerung war bereits als erledigt markiert. Du musst nichts weiter tun.",
      nextUrl: dashboardUrl,
      nextLabel: "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  applyCompletionSideEffects(reminder);

  let successMessage = "Die Erinnerung wurde als erledigt markiert.";
  if (Number(reminder.repeat_interval_days || 0) > 0) {
    db.prepare(`
      UPDATE reminders
      SET due_at = ?, completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
      WHERE id = ?
    `).run(dayjs(reminder.due_at).add(Number(reminder.repeat_interval_days), "day").format("YYYY-MM-DDTHH:mm"), reminder.id);
    successMessage = "Die wiederkehrende Erinnerung wurde bestätigt und neu terminiert.";
  } else {
    db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(reminder.id);
  }

  createAuditLog(req, "reminder.email_complete", { reminder_id: reminder.id, animal_id: reminder.animal_id }, { entityType: "reminder", entityId: reminder.id });

  return res.render("pages/reminder-email-result", {
    pageTitle: "Erinnerung bestätigt",
    success: true,
    title: "Erinnerung bestätigt",
    message: successMessage,
    nextUrl: reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : dashboardUrl,
    nextLabel: reminder.animal_id ? "Zur Tierakte" : "Zum Dashboard",
    assetBaseUrl: appBaseUrl,
  });
});

app.get("/reminders/:id/email-snooze", (req, res) => {
  const reminder = db.prepare(`
    SELECT reminders.*, animals.status AS animal_status
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.id = ?
  `).get(req.params.id);
  const settings = getSettingsObject(db);
  const appBaseUrl = resolveAppBaseUrl(settings);
  const dashboardUrl = `${appBaseUrl}/`;
  const allowedMinutes = new Set(["60", "360", "1440", "4320"]);
  const value = String(req.query.value || "").trim();

  if (!reminder) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Erinnerung nicht gefunden",
      success: false,
      title: "Erinnerung nicht gefunden",
      message: "Diese Erinnerungs-Mail gehört nicht mehr zu einer vorhandenen Erinnerung oder wurde bereits gelöscht.",
      nextUrl: dashboardUrl,
      nextLabel: "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  if (!allowedMinutes.has(value)) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Link ungültig",
      success: false,
      title: "Link ungültig",
      message: "Die gewünschte Zurückstellung ist ungültig. Bitte öffne die Erinnerung direkt in HeartPet.",
      nextUrl: reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : dashboardUrl,
      nextLabel: reminder.animal_id ? "Zur Tierakte" : "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  if (!verifyReminderActionToken(reminder, "snooze", req.query.token, value)) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Link ungültig",
      success: false,
      title: "Link ungültig",
      message: "Der Zurückstellen-Link ist ungültig oder wurde verändert. Bitte öffne die Erinnerung direkt in HeartPet.",
      nextUrl: reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : dashboardUrl,
      nextLabel: reminder.animal_id ? "Zur Tierakte" : "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  if (reminder.animal_id && !isActiveAnimalStatus(reminder.animal_status)) {
    return res.render("pages/reminder-email-result", {
      pageTitle: "Tier nicht mehr aktiv",
      success: false,
      title: "Tier nicht mehr aktiv",
      message: "Diese Erinnerung gehört zu einem Tier, das nicht mehr im aktiven Bestand ist. Zurückstellen ist deshalb nicht mehr möglich.",
      nextUrl: dashboardUrl,
      nextLabel: "Zum Dashboard",
      assetBaseUrl: appBaseUrl,
    });
  }

  const minutes = Number(value);
  const nextDueAt = dayjs().add(minutes, "minute");
  db.prepare(`
    UPDATE reminders
    SET due_at = ?, completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
    WHERE id = ?
  `).run(nextDueAt.format("YYYY-MM-DDTHH:mm"), reminder.id);

  createAuditLog(req, "reminder.email_snooze", {
    reminder_id: reminder.id,
    animal_id: reminder.animal_id,
    minutes,
  }, { entityType: "reminder", entityId: reminder.id });

  return res.render("pages/reminder-email-result", {
    pageTitle: "Erinnerung zurückgestellt",
    success: true,
    title: "Erinnerung zurückgestellt",
    message: `Die Erinnerung wurde bis ${nextDueAt.format("DD.MM.YYYY HH:mm")} zurückgestellt.`,
    nextUrl: reminder.animal_id ? `${appBaseUrl}/animals/${reminder.animal_id}` : dashboardUrl,
    nextLabel: reminder.animal_id ? "Zur Tierakte" : "Zum Dashboard",
    assetBaseUrl: appBaseUrl,
  });
});

app.use(requireAuth);
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

app.get("/", async (req, res) => {
  const q = String(req.query.q || "").trim();
  const searchable = q.length >= 2;
  const searchResults = searchable ? buildGlobalSearchResults(q) : [];

  const stats = {
    animalCount: db.prepare("SELECT COUNT(DISTINCT id) AS count FROM animals WHERE status = 'Aktiv'").get().count,
    documentCount: db.prepare("SELECT COUNT(*) AS count FROM documents").get().count,
    openReminderCount: db.prepare(`
      SELECT COUNT(*) AS count
      FROM reminders
      INNER JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL
        AND animals.status = 'Aktiv'
    `).get().count,
    dueReminderCount: db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM reminders
        INNER JOIN animals ON animals.id = reminders.animal_id
        WHERE reminders.completed_at IS NULL
          AND REPLACE(reminders.due_at, ' ', 'T') <= ?
          AND animals.status = 'Aktiv'
      `)
      .get(dayjs().format("YYYY-MM-DDTHH:mm")).count,
  };

  const speciesCounts = db.prepare(`
    SELECT
      COALESCE(species.name, 'Ohne Tierart') AS name,
      species.id AS species_id,
      COUNT(animals.id) AS count
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    WHERE animals.status = 'Aktiv'
    GROUP BY species.id, species.name
    ORDER BY species.name COLLATE NOCASE ASC
  `).all();

  const upcomingReminders = db.prepare(`
    SELECT reminders.*, animals.name AS animal_name
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND animals.status = 'Aktiv'
      AND REPLACE(reminders.due_at, ' ', 'T') > ?
    ORDER BY REPLACE(reminders.due_at, ' ', 'T') ASC
    LIMIT 10
  `).all(dayjs().endOf("day").format("YYYY-MM-DDTHH:mm"));

  const urgentReminders = db.prepare(`
    SELECT reminders.*, animals.name AS animal_name,
      CASE
        WHEN REPLACE(reminders.due_at, ' ', 'T') < ? THEN 'overdue'
        WHEN REPLACE(reminders.due_at, ' ', 'T') <= ? THEN 'today'
        ELSE 'upcoming'
      END AS urgency
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND animals.status = 'Aktiv'
      AND REPLACE(reminders.due_at, ' ', 'T') <= ?
    ORDER BY
      CASE
        WHEN REPLACE(reminders.due_at, ' ', 'T') < ? THEN 0
        WHEN REPLACE(reminders.due_at, ' ', 'T') <= ? THEN 1
        ELSE 2
      END,
      REPLACE(reminders.due_at, ' ', 'T') ASC
    LIMIT 12
  `).all(
    dayjs().format("YYYY-MM-DDTHH:mm"),
    dayjs().endOf("day").format("YYYY-MM-DDTHH:mm"),
    dayjs().endOf("day").format("YYYY-MM-DDTHH:mm"),
    dayjs().format("YYYY-MM-DDTHH:mm"),
    dayjs().endOf("day").format("YYYY-MM-DDTHH:mm")
  );

  const attentionAnimals = attachAnimalWorkspaceMeta(attachNextTermData(db.prepare(`
    SELECT
      animals.*,
      species.name AS species_name,
      COALESCE(veterinarians.name, species_vet.name) AS veterinarian_name
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    LEFT JOIN veterinarians ON veterinarians.id = animals.veterinarian_id
    LEFT JOIN veterinarians AS species_vet ON species_vet.id = species.default_veterinarian_id
    WHERE animals.status = 'Aktiv'
    ORDER BY datetime(animals.updated_at) DESC, animals.id DESC
    LIMIT 10
  `).all()))
    .filter((animal) =>
      animal.overdueReminderCount > 0 ||
      animal.openReminderCount > 0 ||
      !animal.veterinarian_name ||
      animal.isProfileIncomplete
    )
    .sort((left, right) => {
      if (left.overdueReminderCount !== right.overdueReminderCount) {
        return right.overdueReminderCount - left.overdueReminderCount;
      }
      if (left.openReminderCount !== right.openReminderCount) {
        return right.openReminderCount - left.openReminderCount;
      }
      return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
    })
    .map((animal) => ({
      ...animal,
      dashboardAttentionReasons: buildDashboardAttentionReasons(animal, { includeReminders: false }),
    }))
    .filter((animal) => animal.dashboardAttentionReasons.length > 0)
    .slice(0, 6);

  const coopSettings = getSettingsObject(db);
  const weather = await readOutdoorWeather(coopSettings);
  const coopCameras = parseCoopCameras(coopSettings.coop_camera_streams);
  const doorSensorId = String(coopSettings.homematic_door_sensor_datapoint_id || "").trim();
  const doorSensorConfigured = /^\d+$/.test(doorSensorId);
  const doorLevelId = String(coopSettings.homematic_door_level_datapoint_id || "").trim();
  const doorLevelConfigured = /^\d+$/.test(doorLevelId);
  const [climate, doorSensorValue, doorLevelValue] = await Promise.all([
    readHomematicClimateFromCcu(coopSettings),
    doorSensorConfigured ? readHomematicXmlApiDatapoint(coopSettings, doorSensorId) : Promise.resolve(null),
    doorLevelConfigured ? readHomematicXmlApiDatapoint(coopSettings, doorLevelId) : Promise.resolve(null),
  ]);
  const { temperature, humidity } = climate;
  const climateConfigured = Boolean(getHomematicClimateDatapointIds(coopSettings));
  const sensorTrueMeansOpen = coopSettings.homematic_door_sensor_true_state !== "closed";
  const doorIsOpen = doorSensorValue === null ? null : (Boolean(doorSensorValue) === sensorTrueMeansOpen);
  const rawDoorLevel = Number(doorLevelValue);
  const doorOpenPercent = doorLevelValue === null || !Number.isFinite(rawDoorLevel)
    ? null
    : Math.round(Math.max(0, Math.min(100, rawDoorLevel > 1 ? rawDoorLevel : rawDoorLevel * 100)));
  const coopRetrievedAt = new Date().toISOString();

  res.render("pages/dashboard", {
    pageTitle: "Dashboard",
    search: { q, searchable },
    searchResults,
    stats,
    speciesCounts,
    upcomingReminders,
    urgentReminders,
    attentionAnimals,
    weather,
    coop: {
      cameras: coopCameras,
      temperature,
      humidity,
      climateError: climate?.error || "",
      retrievedAt: coopRetrievedAt,
      temperatureConfigured: climateConfigured,
      humidityConfigured: climateConfigured,
      doorConfigured: Boolean(getHomematicDoorCommand(coopSettings, true)),
      doorCloseConfigured: Boolean(getHomematicDoorCommand(coopSettings, false)),
      doorSensorConfigured,
      doorIsOpen,
      doorLevelConfigured,
      doorOpenPercent,
    },
  });
});

app.use(createCoopRouter({
  db, getSettingsObject, getHomematicDoorCommand, executeHomematicDoorDirection, createAuditLog,
  parseHomematicStateChange, setFlash, parseCoopCameras, streamRtspCamera, fetchCameraStream,
  redactSensitiveText, cameraFrameCache, readCameraFrameCache, captureCameraFrame, writeCameraFrameCache,
  describeFetchError, buildCameraPlaceholderSvg, checkRtspCamera, requireAdmin, readHomematicClimateFromCcu,
  getHomematicClimateDatapointIds, buildHomematicXmlApiUrl, fetchWithTimeout, decodeHomematicXmlBuffer,
  parseHomematicDatapoints,
}));

app.get("/suche", (req, res) => {
  const q = String(req.query.q || "").trim();
  return res.redirect(q ? `/?q=${encodeURIComponent(q)}` : "/");
});

app.get("/admin/suggest", renderSearchSuggestions);
app.use("/animals", createAnimalsRouter({
  animalWorkspace,
  renderNotFound,
  renderSearchSuggestions,
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
  syncMedicationReminders,
  syncVaccinationReminders,
  syncAppointmentReminders,
  createAuditLog,
  redirectDocumentDrawerRequest,
  renderNotFound,
  deleteGeneratedReminders,
  deleteUploadedFileIfUnreferenced,
}));
app.get("/admin/systemlog/systemlog", requireAdmin, (req, res) => {
  res.redirect("/admin/systemlog");
});


function renderAnimalEntryDrawer(req, res, { entryType, mode = "create", item = null }) {
  const animal = findAnimal(req.params.id || req.params.animalId);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, getAnimalReturnTo(req, `/animals/${animal.id}`));
  }

  const titleMap = {
    event: "Ereignis erstellen",
    condition: mode === "edit" ? "Vorerkrankung bearbeiten" : "Vorerkrankung anlegen",
    feeding: mode === "edit" ? "Fütterung bearbeiten" : "Fütterung anlegen",
    note: mode === "edit" ? "Protokoll bearbeiten" : "Protokoll anlegen",
    medication: "Medikament bearbeiten",
    vaccination: "Impfung bearbeiten",
    appointment: "Arzttermin bearbeiten",
    reminder: "Erinnerung bearbeiten",
    document: mode === "edit" ? "Dokument bearbeiten" : "Dokument hochladen",
    image: "Foto hochladen",
  };

  res.render("pages/animal-entry-drawer", {
    pageTitle: titleMap[entryType] || "Eintrag bearbeiten",
    animal,
    entryType,
    mode,
    item,
    permissions: buildPermissions(getCurrentUserRecord(req)),
    categories: db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    returnTo: safeLocalReturnPath(req.query.return_to, `/animals/${animal.id}`),
    initialEventKind: String(req.query.kind || "").trim(),
    vaccinationSuggestions: getVaccinationSuggestionsForSpecies(
      animal.species_name,
      db.prepare("SELECT species_name, name FROM vaccination_presets ORDER BY species_name, name").all(),
    ),
  });
}

app.get("/animals/:id/events/new", (req, res) => {
  const permissions = buildPermissions(getCurrentUserRecord(req));
  if (!permissions.canManageHealth && !permissions.canManageReminders && !permissions.canManageFeedings && !permissions.canManageNotes) {
    setFlash(req, "error", "Für neue Ereignisse fehlen die erforderlichen Rechte.");
    return res.redirect(safeLocalReturnPath(req.query.return_to, `/animals/${req.params.id}`));
  }

  return renderAnimalEntryDrawer(req, res, { entryType: "event" });
});

app.get("/animals/:id/conditions/new", requireAnimalPermission("canManageHealth"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "condition" }));
app.get("/animals/:animalId/conditions/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
  const item = db.prepare("SELECT * FROM animal_conditions WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Vorerkrankung nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "condition", mode: "edit", item });
});

app.get("/animals/:id/feedings/new", requireAnimalPermission("canManageFeedings"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "feeding" }));
app.get("/animals/:animalId/feedings/:entryId/edit", requireAnimalPermission("canManageFeedings"), (req, res) => {
  const item = db.prepare("SELECT * FROM animal_feedings WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Fütterung nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "feeding", mode: "edit", item });
});

app.get("/animals/:id/notes/new", requireAnimalPermission("canManageNotes"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "note" }));
app.get("/animals/:animalId/notes/:entryId/edit", requireAnimalPermission("canManageNotes"), (req, res) => {
  const item = db.prepare("SELECT * FROM animal_notes WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Protokolleintrag nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "note", mode: "edit", item });
});

app.get("/animals/:animalId/medications/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
  const item = db.prepare("SELECT * FROM animal_medications WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Medikament nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "medication", mode: "edit", item });
});

app.get("/animals/:animalId/vaccinations/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
  const item = db.prepare("SELECT * FROM animal_vaccinations WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Impfung nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "vaccination", mode: "edit", item });
});

app.get("/animals/:animalId/appointments/:entryId/edit", requireAnimalPermission("canManageHealth"), (req, res) => {
  const item = db.prepare("SELECT * FROM animal_appointments WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Arzttermin nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "appointment", mode: "edit", item });
});

app.get("/animals/:animalId/reminders/:entryId/edit", requireAnimalPermission("canManageReminders"), (req, res) => {
  const item = db.prepare("SELECT * FROM reminders WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Erinnerung nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "reminder", mode: "edit", item });
});

app.get("/animals/:id/documents/new", requireAnimalPermission("canManageDocuments"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "document" }));
app.get("/animals/:animalId/documents/:entryId/edit", requireAnimalPermission("canManageDocuments"), (req, res) => {
  const item = db.prepare("SELECT * FROM documents WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!item) {
    return renderNotFound(req, res, "Dokument nicht gefunden.");
  }
  return renderAnimalEntryDrawer(req, res, { entryType: "document", mode: "edit", item });
});

app.get("/animals/:id/images/new", requireAnimalPermission("canManageGallery"), (req, res) => renderAnimalEntryDrawer(req, res, { entryType: "image" }));


app.post("/animals/:id/events", upload.single("vaccination_certificate"), (req, res) => {
  const user = req.session.user ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id) : null;
  const permissions = buildPermissions(user);
  const eventKind = String(req.body.event_kind || "").trim();
  const title = String(req.body.title || "").trim();
  const notes = appendVeterinarianNote(req.body.notes, req.body.handled_by_veterinarian, req.body.veterinarian_id);
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  const certificateError = getVaccinationCertificateError(req.file);
  if (certificateError) {
    discardUploadedFile(req.file);
    setFlash(req, "error", certificateError);
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (!["medication", "vaccination", "appointment", "reminder", "feeding", "note"].includes(eventKind)) {
    discardUploadedFile(req.file);
    setFlash(req, "error", "Bitte wähle einen gültigen Ereignistyp aus.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (!title) {
    discardUploadedFile(req.file);
    setFlash(req, "error", "Bitte gib eine Bezeichnung für das Ereignis an.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (req.body.handled_by_veterinarian && !req.body.veterinarian_id) {
    discardUploadedFile(req.file);
    setFlash(req, "error", "Bitte wähle einen Tierarzt aus.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (eventKind === "reminder" && !permissions.canManageReminders) {
    discardUploadedFile(req.file);
    setFlash(req, "error", "Für freie Erinnerungen fehlen die erforderlichen Rechte.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (eventKind === "feeding" && !permissions.canManageFeedings) {
    discardUploadedFile(req.file);
    setFlash(req, "error", "Für Fütterungseinträge fehlen die erforderlichen Rechte.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (eventKind === "note" && !permissions.canManageNotes) {
    discardUploadedFile(req.file);
    setFlash(req, "error", "Für Notizen fehlen die erforderlichen Rechte.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (["medication", "vaccination", "appointment"].includes(eventKind) && !permissions.canManageHealth) {
    discardUploadedFile(req.file);
    setFlash(req, "error", "Für medizinische Ereignisse fehlen die erforderlichen Rechte.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  try {
    if (eventKind !== "vaccination") {
      discardUploadedFile(req.file);
      req.file = null;
    }
    if (eventKind === "feeding") {
      db.prepare("INSERT INTO animal_feedings (animal_id, label, time_of_day, food, amount, notes) VALUES (?, ?, ?, ?, ?, ?)")
        .run(req.params.id, title, String(req.body.event_time || "").trim(), "", "", notes);
      setFlash(req, "success", "Fütterung gespeichert.");
      return res.redirect(returnTo);
    }

    if (eventKind === "note") {
      db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
        .run(req.params.id, title, notes || title);
      setFlash(req, "success", "Notiz gespeichert.");
      return res.redirect(returnTo);
    }

    if (eventKind === "medication") {
      const startDate = String(req.body.event_date || "").trim();
      if (!startDate) {
        throw new Error("Bitte gib ein Datum für das Medikament an.");
      }

      const result = db.prepare(`
        INSERT INTO animal_medications (animal_id, name, dosage, schedule, start_date, end_date, reminder_enabled, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        title,
        "",
        "",
        startDate,
        null,
        req.body.create_reminder ? 1 : 0,
        notes
      );
      syncMedicationReminders(req.params.id, result.lastInsertRowid);
      setFlash(req, "success", "Medikament gespeichert.");
      return res.redirect(returnTo);
    }

    if (eventKind === "vaccination") {
      const eventDate = String(req.body.event_date || "").trim();
      if (!eventDate) {
        throw new Error("Bitte gib ein Datum für die Impfung an.");
      }
      const isFuture = dayjs(eventDate).isAfter(dayjs(), "day");

      const result = db.prepare(`
        INSERT INTO animal_vaccinations (
          animal_id, name, vaccination_date, next_due_date, reminder_enabled, notes,
          certificate_original_name, certificate_stored_name, certificate_mime_type, certificate_file_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        title,
        isFuture ? null : eventDate,
        isFuture ? eventDate : null,
        req.body.create_reminder ? 1 : 0,
        notes,
        req.file?.originalname || null,
        req.file?.filename || null,
        req.file?.mimetype || null,
        req.file?.size || null
      );
      syncVaccinationReminders(req.params.id, result.lastInsertRowid);
      setFlash(req, "success", "Impfung gespeichert.");
      return res.redirect(returnTo);
    }

    if (eventKind === "appointment") {
      const appointmentAt = combineDateAndTime(req.body.event_date, req.body.event_time, "09:00");
      if (!appointmentAt) {
        throw new Error("Bitte gib Datum und Uhrzeit für den Arzttermin an.");
      }

      const result = db.prepare(`
        INSERT INTO animal_appointments (animal_id, title, appointment_at, location_mode, location_text, veterinarian_id, reminder_enabled, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        title,
        appointmentAt,
        req.body.handled_by_veterinarian ? "praxis" : "praxis",
        "",
        req.body.handled_by_veterinarian ? (req.body.veterinarian_id || null) : null,
        req.body.create_reminder ? 1 : 0,
        notes
      );
      syncAppointmentReminders(req.params.id, result.lastInsertRowid);
      setFlash(req, "success", "Arzttermin gespeichert.");
      return res.redirect(returnTo);
    }

    const dueAt = combineDateAndTime(req.body.event_date, req.body.event_time, "09:00");
    if (!dueAt) {
      throw new Error("Bitte gib Datum und Uhrzeit für die freie Erinnerung an.");
    }

    const reminderChannels = getNotificationChannelDefaults();
    db.prepare(`
      INSERT INTO reminders (
        animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
        last_delivery_status, last_delivery_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      title,
      "Allgemein",
      dueAt,
      reminderChannels.channelEmail,
      reminderChannels.channelTelegram,
      0,
      notes,
      "pending",
      ""
    );
    setFlash(req, "success", "Freie Erinnerung gespeichert.");
    return res.redirect(returnTo);
  } catch (error) {
    discardUploadedFile(req.file);
    setFlash(req, "error", error.message || "Das Ereignis konnte nicht gespeichert werden.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }
});


app.post("/animals/:id/feedings", requireAnimalPermission("canManageFeedings"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  db.prepare(`
    INSERT INTO animal_feedings (animal_id, label, time_of_day, food, amount, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.label,
    req.body.time_of_day || "",
    req.body.food || "",
    req.body.amount || "",
    req.body.notes || ""
  );
  setFlash(req, "success", "Fütterungsplan gespeichert.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/feedings/:entryId/update", requireAnimalPermission("canManageFeedings"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE animal_feedings
    SET label = ?, time_of_day = ?, food = ?, amount = ?, notes = ?
    WHERE id = ? AND animal_id = ?
  `).run(
    req.body.label,
    req.body.time_of_day || "",
    req.body.food || "",
    req.body.amount || "",
    req.body.notes || "",
    req.params.entryId,
    req.params.animalId
  );
  setFlash(req, "success", "Fütterungsplan aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/feedings/:entryId/update", requireAnimalPermission("canManageFeedings"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/feedings/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/feedings/:entryId/delete", requireAnimalPermission("canManageFeedings"), (req, res) => {
  db.prepare("DELETE FROM animal_feedings WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Fütterungsplan gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/notes", requireAnimalPermission("canManageNotes"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
    .run(req.params.id, req.body.title, req.body.content);
  createAuditLog(req, "animal.note_create", {
    animal_id: req.params.id,
    title: String(req.body.title || "").trim(),
  }, { entityType: "animal", entityId: req.params.id });
  setFlash(req, "success", "Protokolleintrag gespeichert.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/notes/:entryId/update", requireAnimalPermission("canManageNotes"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE animal_notes
    SET title = ?, content = ?
    WHERE id = ? AND animal_id = ?
  `).run(req.body.title, req.body.content, req.params.entryId, req.params.animalId);
  createAuditLog(req, "animal.note_update", {
    animal_id: req.params.animalId,
    title: String(req.body.title || "").trim(),
  }, { entityType: "animal", entityId: req.params.animalId });
  setFlash(req, "success", "Protokolleintrag aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/notes/:entryId/update", requireAnimalPermission("canManageNotes"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/notes/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/notes/:entryId/delete", requireAnimalPermission("canManageNotes"), (req, res) => {
  db.prepare("DELETE FROM animal_notes WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  createAuditLog(req, "animal.note_delete", {
    animal_id: req.params.animalId,
    note_id: req.params.entryId,
  }, { entityType: "animal", entityId: req.params.animalId });
  setFlash(req, "success", "Protokolleintrag gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.use(createAnimalRemindersRouter({
  db, requireAnimalPermission, safeLocalReturnPath, parsePositiveInteger, setFlash,
  createAuditLog, applyCompletionSideEffects, findAnimal, isActiveAnimalStatus,
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
}));

app.get("/documents/:id/download", (req, res) => {
  const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (!document) {
    return renderNotFound(req, res, "Dokument nicht gefunden.");
  }

  const fullPath = resolveStoredFilePath(uploadsDir, document.stored_name);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return renderNotFound(req, res, "Datei wurde auf dem Server nicht gefunden.");
  }

  res.download(fullPath, document.original_name);
});

app.get("/vaccinations/:id/certificate", (req, res) => {
  const vaccination = db.prepare(`
    SELECT certificate_original_name, certificate_stored_name
    FROM animal_vaccinations
    WHERE id = ?
  `).get(req.params.id);
  if (!vaccination?.certificate_stored_name) {
    return renderNotFound(req, res, "Impfnachweis nicht gefunden.");
  }
  const fullPath = resolveStoredFilePath(uploadsDir, vaccination.certificate_stored_name);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return renderNotFound(req, res, "Datei wurde auf dem Server nicht gefunden.");
  }
  return res.download(fullPath, vaccination.certificate_original_name || "impfnachweis");
});

app.get("/animals/:id/export/json", (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  const payload = buildAnimalExportPayload(animal, getAnimalRelatedData(req.params.id), {
    uploadsDir,
    embedFiles: true,
  });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="heartpet-tier-${animal.id}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

app.get("/animals/:id/export/pdf", async (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  try {
    await createAnimalPdf(res, animal, getAnimalRelatedData(req.params.id), {
      domain: getSettingsObject(db).app_domain || "HeartPet",
      uploadsDir,
    });
  } catch (error) {
    console.error("[HeartPet] PDF-Export fehlgeschlagen:", error.message);
    if (!res.headersSent) {
      setFlash(req, "error", "Der PDF-Export konnte nicht erstellt werden.");
      return res.redirect(`/animals/${req.params.id}`);
    }
  }
});

app.get("/admin", requireAdmin, (req, res) => {
  res.redirect("/admin/allgemein");
});

app.get("/admin/allgemein", requireAdmin, (req, res) => {
  res.render("pages/admin-general", getAdminViewData("Allgemein", "/admin/allgemein"));
});

app.get("/admin/stall", requireAdmin, (req, res) => {
  res.render("pages/admin-general", getAdminViewData("Stall", "/admin/stall"));
});

app.post("/admin/coop/camera-preview", requireAdmin, async (req, res) => {
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
  app.get(aliasPath, requireAdmin, (req, res) => {
    const suffix = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    res.redirect(`/admin/allgemein${suffix}`);
  });
});

app.get("/admin/kommunikation", requireAdmin, (req, res) => {
  res.redirect("/admin/benachrichtigungen");
});

app.get("/admin/benachrichtigungen", requireAdmin, (req, res) => {
  res.render("pages/admin-communication", getAdminViewData("Benachrichtigungen", "/admin/benachrichtigungen"));
});

["/benachrichtigungen", "/admin/notifications", "/notifications"].forEach((aliasPath) => {
  app.get(aliasPath, requireAdmin, (req, res) => {
    res.redirect("/admin/benachrichtigungen");
  });
});
app.get(/^\/.+\/benachrichtigungen$/, requireAdmin, (req, res) => {
  res.redirect("/admin/benachrichtigungen");
});

app.use("/admin", createMasterdataRouter({
  backTo,
  createAuditLog,
  db,
  FIELD_SCHEMAS,
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
}));

app.get("/admin/benutzer", requireAdmin, (req, res) => {
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
  app.get(aliasPath, requireAdmin, (req, res) => {
    const suffix = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    res.redirect(`/admin/benutzer${suffix}`);
  });
});

app.get("/admin/users/new", requireAdmin, (req, res) => {
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

app.get("/admin/benutzer/neu", requireAdmin, (req, res) => {
  const query = new URLSearchParams();
  const returnTo = safeLocalReturnPath(req.query.return_to, "");
  if (returnTo) {
    query.set("return_to", returnTo);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  res.redirect(`/admin/users/new${suffix}`);
});

app.get("/admin/users/:id/edit", requireAdmin, (req, res) => {
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

app.get("/admin/users/:id/update", requireAdmin, (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(req, res, "/admin/benutzer", `/admin/users/${req.params.id}/edit`);
});

app.get("/admin/users/:id/save", requireAdmin, (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(req, res, "/admin/benutzer", `/admin/users/${req.params.id}/edit`);
});

app.get("/admin/import", requireAdmin, (req, res) => {
  res.render("pages/admin-import", getAdminViewData("Import", "/admin/import"));
});

app.get("/admin/imports", requireAdmin, (req, res) => {
  const suffix = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(`/admin/import${suffix}`);
});

app.use("/admin", createSystemlogRouter({
  buildOperationalHealthChecks,
  captureCameraFrame,
  createAuditLog,
  formatAuditLogEntry,
  getAdminViewData,
  getHomematicClimateDatapointIds,
  getInstanceTimeZone,
  getRuntimeMetricsSnapshot,
  getSettings: () => getSettingsObject(db),
  isEmailConfigured,
  isNtfyConfigured,
  isTelegramConfigured,
  parseCoopCameras,
  readAppRevision,
  readHomematicClimateFromCcu,
  redactSensitiveText,
  repository: systemlogRepository,
  requireAdmin,
  runtimeRevision,
  setFlash,
  summarizeOperationalChecks,
}));

["/systemlog", "/system-log"].forEach((aliasPath) => {
  app.get(aliasPath, requireAdmin, (req, res) => res.redirect("/admin/systemlog"));
});

app.get(/^\/.+\/(?:systemlog|system-log)$/, requireAdmin, (req, res) => res.redirect("/admin/systemlog"));

app.post("/admin/settings", requireAdmin, upload.single("app_logo"), async (req, res) => {
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
  const invalidDoorDatapoint = ["homematic_door_open_datapoint_id", "homematic_door_close_datapoint_id", "homematic_door_command_datapoint_id"].find((key) =>
    fields.includes(key) && String(req.body[key] || "").trim() && !/^\d+$/.test(String(req.body[key]).trim())
  );
  const invalidDoorValue = ["homematic_door_open_value", "homematic_door_close_value"].find((key) =>
    fields.includes(key) && !/^-?\d+(?:[.,]\d+)?$/.test(String(req.body[key] || "").trim())
  );
  if (invalidUrlField || invalidCamera || invalidDoorDatapoint || invalidDoorValue) {
    setFlash(req, "error", invalidCamera
      ? `Ungültige Kamera-URL in der Zeile „${invalidCamera.source}“.`
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

    upsertSetting(db, key, normalizeSettingsInputValue(key, req.body[key]));
  });

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

app.post("/admin/test-email", requireAdmin, async (req, res) => {
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
  app.post(path, requireAdmin, handleSmtpConnectionTest);
});

app.get("/admin/test-smtp-connection", requireAdmin, (req, res) => {
  setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
  res.redirect("/admin/benachrichtigungen");
});
app.get("/test-smtp-connection", requireAdmin, (req, res) => {
  setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
  res.redirect("/admin/benachrichtigungen");
});
app.get("/admin/benachrichtigungen/test-smtp-connection", requireAdmin, (req, res) => {
  setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
  res.redirect("/admin/benachrichtigungen");
});
app.all(/^\/.*test-smtp-connection.*$/, requireAdmin, async (req, res) => {
  if (req.method === "POST") {
    return handleSmtpConnectionTest(req, res);
  }
  setFlash(req, "error", "SMTP-Test bitte über den Button im Bereich Benachrichtigungen starten.");
  return res.redirect("/admin/benachrichtigungen");
});

app.post("/admin/test-telegram", requireAdmin, async (req, res) => {
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

app.post("/admin/test-ntfy", requireAdmin, async (req, res) => {
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

app.post("/admin/users", requireAdmin, async (req, res) => {
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

app.post("/admin/users/:id/resend-invite", requireAdmin, async (req, res) => {
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

app.post("/admin/users/:id/permissions", requireAdmin, (req, res) => {
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

app.post("/admin/users/:id/update", requireAdmin, async (req, res) => {
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

app.post("/admin/users/:id/save", requireAdmin, async (req, res) => {
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

app.post("/admin/users/:id/delete", requireAdmin, (req, res) => {
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

app.post("/admin/profile", requireAdmin, async (req, res) => {
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

app.post("/admin/password", async (req, res) => {
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

app.post("/admin/import", requireAdmin, importUpload.single("import_file"), (req, res) => {
  if (!req.file) {
    setFlash(req, "error", "Bitte eine HeartPet JSON-Datei auswählen.");
    return res.redirect("/admin/import");
  }

  try {
    const payload = JSON.parse(req.file.buffer.toString("utf8"));
    const animalData = payload.animal || {};
    const related = payload.related || {};
    const species = ensureSpeciesExists(animalData.species_name || "Unbekannt");

    const insertAnimal = db.prepare(`
      INSERT INTO animals (
        name, species_id, sex, birth_date, intake_date, source, microchip_number, microchip_manufacturer, microchip_registry, status,
        color, breed, weight_kg, veterinarian_id, notes,
        status_changed_at, status_context_name, status_context_date, memorial_note, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const result = insertAnimal.run(
      animalData.name || "Importiertes Tier",
      species?.id || null,
      animalData.sex || "",
      animalData.birth_date || null,
      animalData.intake_date || null,
      animalData.source || "",
      animalData.microchip_number || "",
      animalData.microchip_manufacturer || "",
      normalizeMicrochipRegistry(animalData.microchip_registry),
      normalizeAnimalStatus(animalData.status),
      animalData.color || "",
      animalData.breed || "",
      animalData.weight_kg || null,
      null,
      animalData.notes || "",
      animalData.status_changed_at || null,
      animalData.status_context_name || "",
      animalData.status_context_date || "",
      animalData.memorial_note || ""
    );

    const animalId = result.lastInsertRowid;
    const tx = db.transaction(() => {
      const importedMedicationIds = [];
      const importedVaccinationIds = [];
      const importedAppointmentIds = [];
      (related.conditions || []).forEach((item) => {
        db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)")
          .run(animalId, item.title, item.details || "");
      });
      (related.medications || []).forEach((item) => {
        const inserted = db.prepare(`
          INSERT INTO animal_medications (animal_id, name, dosage, schedule, start_date, end_date, reminder_enabled, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          animalId,
          item.name,
          item.dosage || "",
          item.schedule || "",
          item.start_date || null,
          item.end_date || null,
          item.reminder_enabled ? 1 : 0,
          item.notes || ""
        );
        importedMedicationIds.push(inserted.lastInsertRowid);
      });
      (related.vaccinations || []).forEach((item) => {
        const inserted = db.prepare(`
          INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, reminder_enabled, notes)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          animalId,
          item.name,
          item.vaccination_date || null,
          item.next_due_date || null,
          item.reminder_enabled ? 1 : 0,
          item.notes || ""
        );
        importedVaccinationIds.push(inserted.lastInsertRowid);
      });
      (related.appointments || []).forEach((item) => {
        const inserted = db.prepare(`
          INSERT INTO animal_appointments (animal_id, title, appointment_at, location_mode, location_text, veterinarian_id, reminder_enabled, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          animalId,
          item.title,
          item.appointment_at,
          item.location_mode || "praxis",
          item.location_text || "",
          null,
          item.reminder_enabled ? 1 : 0,
          item.notes || ""
        );
        importedAppointmentIds.push(inserted.lastInsertRowid);
      });
      (related.feedings || []).forEach((item) => {
        db.prepare(`
          INSERT INTO animal_feedings (animal_id, label, time_of_day, food, amount, notes)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(animalId, item.label, item.time_of_day || "", item.food || "", item.amount || "", item.notes || "");
      });
      (related.notes || []).forEach((item) => {
        db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
          .run(animalId, item.title, item.content || "");
      });
      (related.documents || []).forEach((item) => {
        const storedFile = restoreEmbeddedFile(item.embedded_file);
        if (!storedFile) {
          return;
        }

        db.prepare(`
          INSERT INTO documents (animal_id, category_id, title, original_name, stored_name, mime_type, file_size)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          animalId,
          resolveImportedCategoryId(item.category_name || item.category_id),
          item.title || storedFile.original_name,
          storedFile.original_name,
          storedFile.stored_name,
          storedFile.mime_type || "",
          storedFile.file_size || 0
        );
      });
      (related.images || []).forEach((item) => {
        const storedFile = restoreEmbeddedFile(item.embedded_file);
        if (!storedFile) {
          return;
        }

        db.prepare(`
          INSERT INTO animal_images (animal_id, title, original_name, stored_name, mime_type, file_size)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          animalId,
          item.title || "",
          storedFile.original_name,
          storedFile.stored_name,
          storedFile.mime_type || "",
          storedFile.file_size || 0
        );
      });
      (related.reminders || []).filter((item) => !item.source_kind).forEach((item) => {
        db.prepare(`
          INSERT INTO reminders (
            animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
            completed_at, last_notified_at, last_delivery_status, last_delivery_error, source_kind, source_id, source_index
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          animalId,
          item.title,
          item.reminder_type || "Allgemein",
          item.due_at,
          item.channel_email || 0,
          item.channel_telegram || 0,
          item.repeat_interval_days || 0,
          item.notes || "",
          item.completed_at || null,
          item.last_notified_at || null,
          item.last_delivery_status || "pending",
          item.last_delivery_error || "",
          null,
          null,
          item.source_index || 0
        );
      });

      importedMedicationIds.forEach((id) => syncMedicationReminders(animalId, id));
      importedVaccinationIds.forEach((id) => syncVaccinationReminders(animalId, id));
      importedAppointmentIds.forEach((id) => syncAppointmentReminders(animalId, id));

      if (!isActiveAnimalStatus(animalData.status)) {
        closeOpenRemindersForAnimal(animalId);
      }
    });

    tx();
    setFlash(req, "success", "HeartPet Export erfolgreich importiert.");
  } catch (error) {
    setFlash(req, "error", `Import fehlgeschlagen: ${error.message}`);
  }

  res.redirect("/admin/import");
});

app.get("/hilfe", (req, res) => {
  res.render("pages/help", { pageTitle: "Hilfe" });
});

app.get("/kontakt", (req, res) => {
  renderInfoPage(res, "Kontakt", getSettingsObject(db).contact_text);
});

app.get("/api/species/search", (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) {
    return res.json({ results: [] });
  }

  const lowered = query.toLowerCase();
  const rows = db.prepare("SELECT name FROM species ORDER BY name ASC").all();
  const ranked = rows
    .map((item) => item.name)
    .filter((name) => name.toLowerCase().includes(lowered))
    .sort((left, right) => {
      const leftLower = left.toLowerCase();
      const rightLower = right.toLowerCase();
      const leftStarts = leftLower.startsWith(lowered) ? 0 : 1;
      const rightStarts = rightLower.startsWith(lowered) ? 0 : 1;
      if (leftStarts !== rightStarts) {
        return leftStarts - rightStarts;
      }
      return left.localeCompare(right, "de");
    })
    .slice(0, 12);

  res.json({ results: ranked });
});

function renderSearchSuggestions(req, res) {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    return res.json({ results: [] });
  }

  const suggestions = buildGlobalSearchResults(q)
    .slice(0, 12)
    .map((item) => ({
      kind: item.kind,
      title: item.title,
      subtitle: item.subtitle,
      href: item.href,
      when: item.when || "",
    }));

  res.json({ results: suggestions });
}

["/api/search/suggest", "/api/suggest", "/search/suggest", "/suggest"].forEach((suggestPath) => {
  app.get(suggestPath, renderSearchSuggestions);
});

app.get(/^\/.+\/suggest$/, renderSearchSuggestions);

app.get("/api/reminders/pending", (req, res) => {
  const now = dayjs().format("YYYY-MM-DDTHH:mm");
  const count = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND REPLACE(reminders.due_at, ' ', 'T') <= ?
      AND animals.status = 'Aktiv'
  `).get(now).count;

  const rows = db.prepare(`
    SELECT reminders.id, reminders.title, reminders.due_at, reminders.animal_id, animals.name AS animal_name
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND REPLACE(reminders.due_at, ' ', 'T') <= ?
      AND animals.status = 'Aktiv'
    ORDER BY REPLACE(reminders.due_at, ' ', 'T') ASC
    LIMIT 5
  `).all(now);

  res.json({ count, reminders: rows });
});

app.use((req, res) => {
  renderNotFound(req, res, "Seite nicht gefunden.");
});

app.use(createErrorHandler({ redactSensitiveText, sanitizeLogText, setFlash }));

async function maybeSendDailyDigest() {
  const settings = getSettingsObject(db);
  if (settings.daily_digest_enabled !== "true") {
    return;
  }

  const timeRaw = String(settings.daily_digest_time || "07:30").trim();
  const [hourRaw, minuteRaw] = timeRaw.split(":");
  const parsedHour = Number.parseInt(hourRaw, 10);
  const parsedMinute = Number.parseInt(minuteRaw, 10);
  const hour = Math.max(0, Math.min(23, Number.isFinite(parsedHour) ? parsedHour : 7));
  const minute = Math.max(0, Math.min(59, Number.isFinite(parsedMinute) ? parsedMinute : 30));
  const now = dayjs();
  const today = now.format("YYYY-MM-DD");
  const sendAt = dayjs(`${today}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  const lastDigestDate = String(settings.last_daily_digest_date || "").trim();

  if (lastDigestDate === today || now.isBefore(sendAt)) {
    return;
  }

  const overdueCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND REPLACE(reminders.due_at, ' ', 'T') < ?
      AND animals.status = 'Aktiv'
  `).get(now.format("YYYY-MM-DDTHH:mm")).count;
  const todayCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND REPLACE(reminders.due_at, ' ', 'T') >= ?
      AND REPLACE(reminders.due_at, ' ', 'T') <= ?
      AND animals.status = 'Aktiv'
  `).get(`${today}T00:00`, `${today}T23:59`).count;
  const nextDaysCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND REPLACE(reminders.due_at, ' ', 'T') > ?
      AND REPLACE(reminders.due_at, ' ', 'T') <= ?
      AND animals.status = 'Aktiv'
  `).get(`${today}T23:59`, now.add(3, "day").format("YYYY-MM-DDTHH:mm")).count;

  if (settings.daily_digest_only_when_open === "true" && overdueCount + todayCount + nextDaysCount === 0) {
    upsertSetting(db, "last_daily_digest_date", today);
    createNotificationLog({
      userId: null,
      channel: "system",
      type: "daily_digest",
      recipient: "",
      subject: "Tageszusammenfassung",
      status: "skipped",
      details: { reason: "no_open_reminders" },
    });
    return;
  }

  const rows = db.prepare(`
    SELECT reminders.*, animals.name AS animal_name
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND REPLACE(reminders.due_at, ' ', 'T') <= ?
      AND animals.status = 'Aktiv'
    ORDER BY REPLACE(reminders.due_at, ' ', 'T') ASC
    LIMIT 20
  `).all(now.add(3, "day").format("YYYY-MM-DDTHH:mm"))
    .map((item) => ({
      ...item,
      dueLabel: formatDateTime(item.due_at),
    }));

  const payload = {
    generatedAt: formatDateTime(now.format("YYYY-MM-DDTHH:mm")),
    counts: {
      overdue: overdueCount,
      today: todayCount,
      nextDays: nextDaysCount,
    },
    rows,
  };

  const deliveries = [];
  try {
    if (isEmailEnabled(settings)) {
      await sendDailyDigestEmail(settings, payload);
      deliveries.push({
        channel: "email",
        status: "sent",
        recipient: settings.notification_email_to || settings.smtp_user || "",
      });
    }
    if (isTelegramEnabled(settings)) {
      await sendDailyDigestTelegram(settings, payload);
      deliveries.push({
        channel: "telegram",
        status: "sent",
        recipient: settings.telegram_chat_id || "",
      });
    }
    if (isNtfyEnabled(settings)) {
      await sendDailyDigestNtfy(settings, payload);
      deliveries.push({
        channel: "ntfy",
        status: "sent",
        recipient: settings.ntfy_topic || "",
      });
    }

    if (!deliveries.length) {
      deliveries.push({ channel: "system", status: "skipped", recipient: "" });
    }
  } catch (error) {
    deliveries.push({
      channel: "system",
      status: "error",
      recipient: "",
      error: error.message,
    });
  }

  deliveries.forEach((entry) => {
    createNotificationLog({
      userId: null,
      channel: entry.channel,
      type: "daily_digest",
      recipient: entry.recipient,
      subject: "Tageszusammenfassung",
      status: entry.status,
      error: entry.error || "",
      details: payload.counts,
    });
  });
  upsertSetting(db, "last_daily_digest_date", today);
}

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  cron.schedule("*/10 * * * *", async () => {
    try {
      await processDueReminders(db, getSettingsObject(db), {
        onNotification: (entry) => {
          createNotificationLog({
            userId: null,
            channel: entry.channel,
            type: entry.type,
            recipient: entry.recipient || "",
            subject: entry.subject || "",
            status: entry.status,
            error: entry.error || "",
            details: {
              reminder_id: entry.reminder?.id || null,
              animal_id: entry.reminder?.animal_id || null,
            },
          });
        },
      });
      await maybeSendDailyDigest();
    } catch (error) {
      console.error("[HeartPet] Fehler im Erinnerungsdienst:", error.message);
    }
  });

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`HeartPet läuft auf http://127.0.0.1:${port}`);
    console.log("Wenn dies eine neue Installation ist, starte mit /setup.");
  });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[HeartPet] ${signal}: Beende Dienst und CCU-Sitzung.`);
    const forceExit = setTimeout(() => process.exit(1), 10000);
    forceExit.unref();
    await homematicSessionService.reset(getSettingsObject(db));
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    const target = safeLocalReturnPath(`${req.path}${req.url.includes("?") ? req.url.slice(req.path.length) : ""}`, "");
    return res.redirect(target ? `/login?return_to=${encodeURIComponent(target)}` : "/login");
  }
  next();
}

function isSetupComplete() {
  return getSettingsObject(db).setup_complete === "true";
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
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
  req.session.flash = { type, message };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function findAnimal(id) {
  return animalRepository.findById(id);
}

function getAnimalRelatedData(animalId) {
  return animalRepository.getRelated(animalId);
}

function buildGlobalSearchResults(rawQuery) {
  const q = String(rawQuery || "").trim();
  if (q.length < 2) {
    return [];
  }

  const query = `%${q}%`;
  const results = [];

  const animals = db.prepare(`
    SELECT animals.id, animals.name, animals.status, species.name AS species_name
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    WHERE animals.name LIKE ? OR animals.breed LIKE ? OR animals.source LIKE ? OR species.name LIKE ?
    ORDER BY animals.name COLLATE NOCASE ASC
    LIMIT 20
  `).all(query, query, query, query);

  animals.forEach((item) => {
    results.push({
      kind: "Tier",
      title: item.name,
      subtitle: `${item.species_name || "-"} | ${item.status || "-"}`,
      href: `/animals/${item.id}`,
      when: "",
    });
  });

  const documents = db.prepare(`
    SELECT documents.id, documents.title, documents.uploaded_at, animals.id AS animal_id, animals.name AS animal_name, document_categories.name AS category_name
    FROM documents
    LEFT JOIN animals ON animals.id = documents.animal_id
    LEFT JOIN document_categories ON document_categories.id = documents.category_id
    WHERE documents.title LIKE ? OR documents.original_name LIKE ? OR document_categories.name LIKE ?
    ORDER BY documents.uploaded_at DESC
    LIMIT 20
  `).all(query, query, query);

  documents.forEach((item) => {
    results.push({
      kind: "Dokument",
      title: item.title,
      subtitle: `${item.animal_name || "Ohne Tier"} | ${item.category_name || "Ohne Kategorie"}`,
      href: item.animal_id ? `/animals/${item.animal_id}` : "/animals",
      when: formatDateTime(item.uploaded_at),
    });
  });

  const events = db.prepare(`
    SELECT reminders.id, reminders.title, reminders.reminder_type AS kind, reminders.due_at AS at, reminders.completed_at, animals.id AS animal_id, animals.name AS animal_name
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.title LIKE ? OR reminders.reminder_type LIKE ? OR reminders.notes LIKE ?
    ORDER BY reminders.due_at DESC
    LIMIT 30
  `).all(query, query, query);

  events.forEach((item) => {
    results.push({
      kind: item.completed_at ? "Ereignis (erledigt)" : "Ereignis",
      title: item.title,
      subtitle: `${item.animal_name || "Ohne Tier"} | ${item.kind || "Erinnerung"}`,
      href: item.animal_id ? `/animals/${item.animal_id}` : "/",
      when: formatDateTime(item.at),
    });
  });

  return results.slice(0, 60);
}

function splitReminders(reminders) {
  const now = dayjs();
  return reminders.reduce(
    (acc, reminder) => {
      const dueAt = String(reminder.due_at || "").replace(" ", "T");
      if (reminder.completed_at) {
        acc.done.push(reminder);
      } else if (dueAt && dayjs(dueAt).isBefore(now)) {
        acc.overdue.push(reminder);
      } else {
        acc.open.push(reminder);
      }
      return acc;
    },
    { overdue: [], open: [], done: [] }
  );
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

function buildMicrochipLinks(animal) {
  if (!String(animal?.microchip_number || "").trim()) {
    return { checks: [], nextSteps: [] };
  }

  const checks = [
    { label: "Bei TASSO prüfen", url: "https://www.tasso.net/Tierregister/Transponderabfrage" },
    { label: "Bei FINDEFIX prüfen", url: "https://www.findefix.com/haustier-vermisst-gefunden/mikrochip-nummer-pruefen/" },
  ];
  const tassoMissing = { label: "Bei TASSO vermisst melden", url: "https://www.tasso.net/Tierregister/Tier-vermisst/Tier-vermisst-melden?fa=1", urgent: true };
  const findefixMissing = { label: "Bei FINDEFIX vermisst melden", url: "https://www.findefix.com/haustier-vermisst-gefunden/haustier-vermisst-melden-suchplakat/", urgent: true };
  const registry = normalizeMicrochipRegistry(animal.microchip_registry);

  if (registry === "Nicht registriert") {
    return {
      checks,
      nextSteps: [
        { label: "Bei TASSO registrieren", url: "https://www.tasso.net/Tierregister/Tier-registrieren" },
        { label: "Bei FINDEFIX registrieren", url: "https://www.findefix.com/haustier-online-registrieren/" },
      ],
    };
  }

  const nextSteps = [];
  if (registry === "TASSO" || registry === "TASSO und FINDEFIX") nextSteps.push(tassoMissing);
  if (registry === "FINDEFIX" || registry === "TASSO und FINDEFIX") nextSteps.push(findefixMissing);
  return { checks, nextSteps };
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

function getMissingRequiredCategories(categories, documents) {
  const presentCategoryIds = new Set(documents.map((item) => Number(item.category_id)).filter(Boolean));
  return categories.filter((category) => category.is_required && !presentCategoryIds.has(Number(category.id)));
}

function buildAnimalDocumentHealthMap(animalIds) {
  const normalizedIds = (animalIds || []).map((id) => Number(id)).filter(Boolean);
  if (!normalizedIds.length) {
    return new Map();
  }

  const requiredCategories = db.prepare("SELECT id, name FROM document_categories WHERE is_required = 1 ORDER BY name ASC").all();
  const map = new Map(normalizedIds.map((id) => [id, {
    missingRequiredCategories: [],
    missingRequiredDocumentCount: 0,
  }]));

  if (!requiredCategories.length) {
    return map;
  }

  const placeholders = normalizedIds.map(() => "?").join(", ");
  const documents = db.prepare(`
    SELECT animal_id, category_id
    FROM documents
    WHERE animal_id IN (${placeholders})
  `).all(...normalizedIds);

  const presentByAnimal = new Map(normalizedIds.map((id) => [id, new Set()]));
  documents.forEach((item) => {
    const animalId = Number(item.animal_id);
    if (presentByAnimal.has(animalId) && item.category_id) {
      presentByAnimal.get(animalId).add(Number(item.category_id));
    }
  });

  normalizedIds.forEach((animalId) => {
    const present = presentByAnimal.get(animalId) || new Set();
    const missing = requiredCategories.filter((category) => !present.has(Number(category.id)));
    map.set(animalId, {
      missingRequiredCategories: missing.map((item) => item.name),
      missingRequiredDocumentCount: missing.length,
    });
  });

  return map;
}

function filterDocuments(documents, filters) {
  return documents.filter((item) => {
    if (filters.categoryId && String(item.category_id || "") !== String(filters.categoryId)) {
      return false;
    }

    if (filters.fileType === "images" && !String(item.mime_type || "").startsWith("image/")) {
      return false;
    }

    if (filters.fileType === "files" && String(item.mime_type || "").startsWith("image/")) {
      return false;
    }

    return true;
  });
}

function isAnimalProfileIncomplete(animal) {
  return !animal.birth_date || !animal.intake_date;
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

function listActiveSpecies() {
  return db.prepare(`
    SELECT species.id, species.name, COUNT(animals.id) AS animal_count
    FROM species
    INNER JOIN animals ON animals.species_id = species.id
    WHERE animals.status = 'Aktiv'
    GROUP BY species.id, species.name
    ORDER BY species.name COLLATE NOCASE ASC
  `).all();
}

function getAnimalSectionConfig(section) {
  const sectionMap = {
    active: {
      key: "active",
      basePath: "/animals",
      pageTitle: "Meine Tiere",
      workspaceTitle: "Meine Tiere",
      workspaceIntro: "Hier findest du alle Tiere aus deinem aktuellen Bestand.",
      totalLabel: "Tiere",
      allowedStatuses: ["Aktiv"],
      defaultStatus: "Aktiv",
      allowStatusFilter: false,
    },
    history: {
      key: "history",
      basePath: "/animals/historie",
      pageTitle: "Historie",
      workspaceTitle: "Historie",
      workspaceIntro: "Hier findest du vermittelte, verkaufte und verstorbene Tiere als Bestandsverlauf.",
      totalLabel: "historische Tiere",
      allowedStatuses: ["Vermittelt", "Verkauft", "Verstorben"],
      defaultStatus: "",
      allowStatusFilter: true,
    },
  };

  return sectionMap[section] || sectionMap.active;
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

function attachNextTermData(animals) {
  if (!animals.length) {
    return [];
  }

  const lookup = buildNextTermLookup(animals.map((animal) => animal.id));
  return animals.map((animal) => ({
    ...animal,
    next_term: lookup.get(animal.id) || null,
  }));
}

function attachAnimalWorkspaceMeta(animals) {
  if (!animals.length) {
    return [];
  }

  const animalIds = animals.map((animal) => Number(animal.id)).filter(Boolean);
  const documentHealthMap = buildAnimalDocumentHealthMap(animalIds);
  const placeholders = animalIds.map(() => "?").join(", ");
  const reminderStats = db.prepare(`
    SELECT
      animal_id,
      SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN completed_at IS NULL AND REPLACE(due_at, ' ', 'T') < ? THEN 1 ELSE 0 END) AS overdue_count
    FROM reminders
    WHERE animal_id IN (${placeholders})
    GROUP BY animal_id
  `).all(dayjs().format("YYYY-MM-DDTHH:mm"), ...animalIds);
  const reminderMap = new Map(reminderStats.map((row) => [Number(row.animal_id), row]));

  return animals.map((animal) => {
    const lifecycle = getAnimalLifecycle(animal.status);
    const reminderRow = reminderMap.get(Number(animal.id));
    const documentHealth = documentHealthMap.get(Number(animal.id)) || {
      missingRequiredCategories: [],
      missingRequiredDocumentCount: 0,
    };
    return {
      ...animal,
      lifecycle,
      openReminderCount: Number(reminderRow?.open_count || 0),
      overdueReminderCount: Number(reminderRow?.overdue_count || 0),
      missingRequiredCategories: documentHealth.missingRequiredCategories,
      missingRequiredDocumentCount: documentHealth.missingRequiredDocumentCount,
      isProfileIncomplete: isAnimalProfileIncomplete(animal),
      statusSummary: buildAnimalTransitionSummary(animal.status, {
        status_context_name: animal.status_context_name || "",
        status_context_date: animal.status_context_date || "",
        memorial_note: animal.memorial_note || "",
      }),
    };
  });
}

function buildDashboardAttentionReasons(animal, { includeReminders = true } = {}) {
  const reasons = [];
  if (includeReminders && Number(animal.overdueReminderCount || 0) > 0) {
    reasons.push(`${animal.overdueReminderCount} überfällig`);
  }
  const openOnlyCount = Math.max(Number(animal.openReminderCount || 0) - Number(animal.overdueReminderCount || 0), 0);
  if (includeReminders && openOnlyCount > 0) {
    reasons.push(`${openOnlyCount} offen`);
  }
  if (!animal.veterinarian_name) {
    reasons.push("Tierarzt fehlt");
  }
  if (!animal.birth_date) {
    reasons.push("Geburtsdatum fehlt");
  }
  if (!animal.intake_date) {
    reasons.push("Aufnahmedatum fehlt");
  }
  return reasons;
}

function buildNextTermLookup(animalIds) {
  const now = dayjs();
  const today = now.format("YYYY-MM-DD");
  const placeholders = animalIds.map(() => "?").join(", ");
  const map = new Map(animalIds.map((id) => [Number(id), []]));

  const pushEvent = (animalId, event) => {
    if (!map.has(Number(animalId))) {
      map.set(Number(animalId), []);
    }
    map.get(Number(animalId)).push(event);
  };

  db.prepare(`
    SELECT id, animal_id, title, appointment_at
    FROM animal_appointments
    WHERE animal_id IN (${placeholders}) AND appointment_at >= ?
  `).all(...animalIds, now.format("YYYY-MM-DDTHH:mm")).forEach((item) => {
    pushEvent(item.animal_id, {
      type: "Arzttermin",
      label: item.title || "Arzttermin",
      at: item.appointment_at,
      sortAt: item.appointment_at,
    });
  });

  db.prepare(`
    SELECT id, animal_id, name, next_due_date
    FROM animal_vaccinations
    WHERE animal_id IN (${placeholders}) AND next_due_date IS NOT NULL AND next_due_date >= ?
  `).all(...animalIds, today).forEach((item) => {
    pushEvent(item.animal_id, {
      type: "Impfung",
      label: item.name || "Impfung",
      at: item.next_due_date,
      sortAt: `${item.next_due_date}T09:00`,
    });
  });

  db.prepare(`
    SELECT id, animal_id, name, start_date, end_date
    FROM animal_medications
    WHERE animal_id IN (${placeholders})
  `).all(...animalIds).forEach((item) => {
    const candidates = [item.start_date, item.end_date].filter((value) => value && value >= today).sort();
    if (!candidates.length) {
      return;
    }
    pushEvent(item.animal_id, {
      type: "Medikament",
      label: item.name || "Medikament",
      at: candidates[0],
      sortAt: `${candidates[0]}T08:00`,
    });
  });

  db.prepare(`
    SELECT id, animal_id, label, time_of_day
    FROM animal_feedings
    WHERE animal_id IN (${placeholders}) AND time_of_day IS NOT NULL AND time_of_day != ''
  `).all(...animalIds).forEach((item) => {
    const todayCandidate = dayjs(`${today}T${item.time_of_day}`);
    const sortAt = todayCandidate.isAfter(now) ? todayCandidate : todayCandidate.add(1, "day");
    pushEvent(item.animal_id, {
      type: "Fütterung",
      label: item.label || "Fütterung",
      at: sortAt.format("YYYY-MM-DDTHH:mm"),
      sortAt: sortAt.format("YYYY-MM-DDTHH:mm"),
    });
  });

  db.prepare(`
    SELECT id, animal_id, title, due_at, reminder_type
    FROM reminders
    WHERE animal_id IN (${placeholders})
      AND completed_at IS NULL
      AND due_at >= ?
      AND source_kind IS NULL
  `).all(...animalIds, now.format("YYYY-MM-DDTHH:mm")).forEach((item) => {
    pushEvent(item.animal_id, {
      type: item.reminder_type || "Erinnerung",
      label: item.title || "Erinnerung",
      at: item.due_at,
      sortAt: item.due_at,
    });
  });

  const nextMap = new Map();
  map.forEach((events, animalId) => {
    const nextEvent = events
      .sort((a, b) => String(a.sortAt).localeCompare(String(b.sortAt)))
      .find(Boolean);
    if (nextEvent) {
      nextMap.set(animalId, {
        ...nextEvent,
        displayLabel: formatUpcomingEvent(nextEvent.at),
      });
    }
  });
  return nextMap;
}

function sortAnimals(animals, sort) {
  const collator = new Intl.Collator("de", { sensitivity: "base" });
  const sorted = [...animals];
  sorted.sort((left, right) => {
    switch (sort) {
      case "name_desc":
        return collator.compare(right.name || "", left.name || "");
      case "intake_desc":
        return compareDates(right.intake_date, left.intake_date) || collator.compare(left.name || "", right.name || "");
      case "intake_asc":
        return compareDates(left.intake_date, right.intake_date) || collator.compare(left.name || "", right.name || "");
      case "created_desc":
        return compareDates(right.created_at, left.created_at) || collator.compare(left.name || "", right.name || "");
      case "status_asc":
        return collator.compare(left.status || "", right.status || "") || collator.compare(left.name || "", right.name || "");
      case "next_term_asc":
        return compareDates(left.next_term?.sortAt, right.next_term?.sortAt, true) || collator.compare(left.name || "", right.name || "");
      case "name_asc":
      default:
        return collator.compare(left.name || "", right.name || "");
    }
  });
  return sorted;
}

function compareDates(a, b, nullsLast = false) {
  if (!a && !b) {
    return 0;
  }
  if (!a) {
    return nullsLast ? 1 : -1;
  }
  if (!b) {
    return nullsLast ? -1 : 1;
  }
  return String(a).localeCompare(String(b));
}

function formatUpcomingEvent(value) {
  if (!value) {
    return "-";
  }
  return String(value).includes("T") ? formatDateTime(value) : formatDate(value);
}

function buildReminderSourceMap(reminders) {
  return (reminders || []).reduce((acc, item) => {
    const key = item.source_kind && item.source_id ? `${item.source_kind}:${item.source_id}` : "manual";
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(item);
    return acc;
  }, {});
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

function renderInfoPage(res, title, content) {
  const settings = getSettingsObject(db);
  res.render("pages/info-page", {
    pageTitle: title,
    content: applyInfoPagePlaceholders(content || "", settings),
  });
}

function applyInfoPagePlaceholders(content, settings) {
  const organizationName = String(settings?.organization_name || settings?.app_name || "").trim();
  let result = String(content || "");
  if (organizationName) {
    result = result
      .replace(/\[Name \/ Organisation\]/g, organizationName)
      .replace(/Name \/ Organisation:\s*\[Bitte eintragen\]/g, `Name / Organisation: ${organizationName}`);
  }
  return result;
}

function normalizeSettingsInputValue(key, value) {
  return String(value || "").trim();
}

function parseBooleanSettingValue(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRtspUrl(value) {
  try {
    return new URL(String(value || "").trim()).protocol === "rtsp:";
  } catch {
    return false;
  }
}

function isCameraUrl(value) {
  return isHttpUrl(value) || isRtspUrl(value);
}

function normalizeConfiguredUrl(value) {
  const input = String(value || "").trim().replace(/\\([_?&=])/g, "$1");
  if (isHttpUrl(input)) return input;
  const match = input.match(/https?:\/\/[^\s\])]+/i);
  return match && isHttpUrl(match[0]) ? match[0] : input;
}

function buildHomematicClimateUrl(value, token) {
  const normalizedUrl = normalizeConfiguredUrl(value);
  if (!isHttpUrl(normalizedUrl)) return normalizedUrl;
  const url = new URL(normalizedUrl);
  const normalizedToken = String(token || "").trim();
  if (normalizedToken && !url.searchParams.has("sid")) {
    url.searchParams.set("sid", normalizedToken);
  }
  // XML-API's Tcl CGI splits list parameters before URL decoding them.
  return url.toString().replace(/%2C/gi, ",");
}

function buildHomematicCommandUrl(value, token) {
  const normalizedUrl = normalizeConfiguredUrl(value);
  if (!isHttpUrl(normalizedUrl)) return normalizedUrl;
  const url = new URL(normalizedUrl);
  const normalizedToken = String(token || "").trim();
  const currentSid = String(url.searchParams.get("sid") || "").trim();
  const sidIsPlaceholder = !currentSid || /^(?:@.*@|\[.*\]|.*DEINE.*)$/i.test(currentSid);
  if (normalizedToken && sidIsPlaceholder) url.searchParams.set("sid", normalizedToken);

  if (/\/statechange\.cgi$/i.test(url.pathname) && !url.searchParams.has("new_value") && url.searchParams.has("value")) {
    url.searchParams.set("new_value", url.searchParams.get("value"));
    url.searchParams.delete("value");
  }
  return url.toString();
}

function parseHomematicStateChange(value) {
  const normalizedUrl = normalizeConfiguredUrl(value);
  if (!isHttpUrl(normalizedUrl)) return null;
  const url = new URL(normalizedUrl);
  const iseId = String(url.searchParams.get("ise_id") || "").trim();
  const newValue = String(url.searchParams.get("new_value") || url.searchParams.get("value") || "").trim();
  if (!/^\d+$/.test(iseId) || !/^-?\d+(?:\.\d+)?$/.test(newValue)) return null;
  return { iseId, newValue };
}

function getHomematicDoorCommand(settings, open) {
  const directionalKey = open ? "homematic_door_open_datapoint_id" : "homematic_door_close_datapoint_id";
  const datapointId = String(settings?.[directionalKey] || settings?.homematic_door_command_datapoint_id || "").trim();
  const configuredValue = String((open ? settings?.homematic_door_open_value : settings?.homematic_door_close_value) || "").trim();
  const defaultValue = open ? "0.0" : "1.0";
  const value = configuredValue || defaultValue;
  if (/^\d+$/.test(datapointId) && /^-?\d+(?:[.,]\d+)?$/.test(value)) {
    const config = getHomematicXmlApiConfig(settings);
    if (!config) return "";
    const url = new URL(config.url.origin);
    url.pathname = `${config.basePath}statechange.cgi`;
    url.searchParams.set("ise_id", datapointId);
    url.searchParams.set("new_value", value.replace(",", "."));
    return url.toString();
  }
  return normalizeConfiguredUrl(open ? settings?.homematic_door_open_url : settings?.homematic_door_close_url);
}

function getHomematicDoorCommandSequence(settings, open) {
  const targetCommand = getHomematicDoorCommand(settings, open);
  const oppositeCommand = getHomematicDoorCommand(settings, !open);
  const targetState = parseHomematicStateChange(targetCommand);
  const oppositeState = parseHomematicStateChange(oppositeCommand);
  if (!targetState || !oppositeState || targetState.iseId === oppositeState.iseId) return [targetCommand].filter(Boolean);

  const usesDirectionalLevels = Number(targetState.newValue) === 1 && Number(oppositeState.newValue) === 1;
  if (!usesDirectionalLevels) return [targetCommand].filter(Boolean);

  const resetUrl = new URL(oppositeCommand);
  resetUrl.searchParams.set("new_value", "0.0");
  return [resetUrl.toString(), targetCommand];
}

async function executeHomematicDoorDirection(settings, open) {
  const commands = getHomematicDoorCommandSequence(settings, open);
  if (!commands.length) throw new Error("Für diese Richtung ist kein gültiger Homematic-Befehl hinterlegt.");
  if (commands.length > 1) {
    const resetState = parseHomematicStateChange(commands[0]);
    console.info(`[HeartPet][CCU][door-direction] Setze Gegenkanal ${resetState?.iseId || "unbekannt"} vor dem ${open ? "Öffnen" : "Schließen"} zurück.`);
    await executeHomematicCommand(settings, commands[0]);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return executeHomematicCommand(settings, commands.at(-1), { expectedDoorOpen: open });
}

function parseWritableHomematicDatapoints(xml) {
  return parseHomematicDatapoints(xml).filter((datapoint) => datapoint.writable);
}

function parseHomematicDatapoints(xml) {
  const readAttributes = (tag) => Object.fromEntries(Array.from(String(tag).matchAll(/([\w:-]+)=["']([^"']*)["']/g), (match) => [match[1], match[2]]));
  const results = [];
  for (const deviceMatch of String(xml || "").matchAll(/<device\b([^>]*)>([\s\S]*?)<\/device>/gi)) {
    const device = readAttributes(deviceMatch[1]);
    for (const channelMatch of deviceMatch[2].matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi)) {
      const channel = readAttributes(channelMatch[1]);
      for (const datapointMatch of channelMatch[2].matchAll(/<datapoint\b([^>]*)\/?\s*>/gi)) {
        const datapoint = readAttributes(datapointMatch[1]);
        const operations = Number.parseInt(datapoint.operations || "0", 10);
        if (!/^\d+$/.test(datapoint.ise_id || "")) continue;
        results.push({
          id: datapoint.ise_id,
          device: device.name || "Unbenanntes Gerät",
          channel: channel.name || "Unbenannter Kanal",
          name: datapoint.name || datapoint.type || "Datenpunkt",
          type: datapoint.type || "",
          value: datapoint.value || "",
          writable: (operations & 2) === 2,
        });
      }
    }
  }
  return results.sort((left, right) => `${left.device} ${left.channel} ${left.type}`.localeCompare(`${right.device} ${right.channel} ${right.type}`, "de"));
}

function decodeHomematicXmlBuffer(buffer, contentType = "") {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const declaration = new TextDecoder("ascii").decode(bytes.slice(0, 180));
  const declaredEncoding = `${contentType} ${declaration}`.match(/charset\s*=\s*["']?([^\s;"']+)|encoding\s*=\s*["']([^"']+)/i);
  const encoding = String(declaredEncoding?.[1] || declaredEncoding?.[2] || "utf-8").toLowerCase();
  const decoderEncoding = /^(?:iso-8859-1|latin-?1)$/i.test(encoding) ? "windows-1252" : encoding;
  try {
    return new TextDecoder(decoderEncoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function getHomematicClimateDatapointIds(settings) {
  const temperatureId = String(settings?.homematic_temperature_datapoint_id || settings?.homematic_climate_channel_id || "").trim();
  const humidityId = String(settings?.homematic_humidity_datapoint_id || "").trim();
  if (!/^\d+$/.test(temperatureId) || !/^\d+$/.test(humidityId)) return null;
  return { temperatureId, humidityId };
}

function normalizeHomematicXmlApiToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalizedUrl = normalizeConfiguredUrl(raw);
  if (isHttpUrl(normalizedUrl)) return String(new URL(normalizedUrl).searchParams.get("sid") || "").trim();
  return raw.replace(/^[?&]?sid=/i, "").trim();
}

function getHomematicXmlApiConfig(settings) {
  const configured = normalizeConfiguredUrl(settings?.homematic_ccu_url);
  if (!isHttpUrl(configured)) return null;
  const url = new URL(configured);
  const configuredPath = url.pathname.match(/\/(?:addons|config)\/xmlapi\/?/i)?.[0];
  const basePath = (configuredPath || "/addons/xmlapi/").replace(/\/?$/, "/");
  const token = normalizeHomematicXmlApiToken(url.searchParams.get("sid") || settings?.homematic_xmlapi_token);
  return { url, basePath, token };
}

function buildHomematicXmlApiUrl(settings, endpoint, params = {}) {
  const config = getHomematicXmlApiConfig(settings);
  if (!config || !config.token) return "";
  const url = new URL(config.url.origin);
  url.pathname = `${config.basePath}${endpoint}`;
  url.searchParams.set("sid", config.token);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  // XML-API's Tcl CGI splits list parameters before URL decoding them.
  return url.toString().replace(/%2C/gi, ",");
}

function getHomematicApiUrl(settings) {
  const configured = normalizeConfiguredUrl(settings?.homematic_ccu_url);
  if (isHttpUrl(configured)) {
    const url = new URL(configured);
    if (!/\/api\/homematic\.cgi$/i.test(url.pathname)) url.pathname = "/api/homematic.cgi";
    return url.toString();
  }
  const source = normalizeConfiguredUrl(settings?.homematic_climate_url || settings?.homematic_door_open_url);
  if (!isHttpUrl(source)) return "";
  const url = new URL(source);
  url.pathname = "/api/homematic.cgi";
  url.search = "";
  return url.toString();
}

async function callHomematicJsonRpc(apiUrl, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.1", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`CCU antwortet mit HTTP ${response.status}.`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error.message || `CCU-Fehler ${payload.error.code || "unbekannt"}.`);
    return payload?.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function executeHomematicCommand(settings, configuredUrl, { expectedDoorOpen = null } = {}) {
  const stateChange = parseHomematicStateChange(configuredUrl);
  const commandId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const commandUrlFromXmlApi = stateChange ? buildHomematicXmlApiUrl(settings, "statechange.cgi", {
    ise_id: stateChange.iseId,
    new_value: stateChange.newValue,
  }) : "";
  if (commandUrlFromXmlApi) {
    const targetValue = Number(stateChange.newValue);
    console.info(`[HeartPet][CCU][door-command][${commandId}] Sende XML-API-Datenpunkt ${stateChange.iseId} mit Sollwert ${targetValue} über ${new URL(commandUrlFromXmlApi).origin}${new URL(commandUrlFromXmlApi).pathname}.`);
    const commandUrl = commandUrlFromXmlApi;
    const response = await fetchWithTimeout(commandUrl, 5000);
    if (!response.ok) throw new Error(`XML-API antwortet mit HTTP ${response.status}.`);
    const responseText = await response.text();
    console.info(`[HeartPet][CCU][door-command][${commandId}] CCU-Antwort: ${responseText.replace(/\s+/g, " ").trim().slice(0, 500)}`);
    const responseError = getHomematicCommandResponseError(responseText);
    if (responseError) throw new Error(responseError);
    const sensorResult = await waitForDoorSensor(settings, expectedDoorOpen, commandId);
    console.info(`[HeartPet][CCU][door-command][${commandId}] CCU-Befehl bestätigt.${sensorResult.sensorConfigured ? ` Türsensor: ${sensorResult.sensorConfirmed ? "Endlage bestätigt" : "Endlage nicht bestätigt"}.` : ""}`);
    return { accepted: true, operationStatus: sensorResult.sensorConfigured ? (sensorResult.sensorConfirmed ? "confirmed" : "timeout") : "accepted", commandId, targetValue, ...sensorResult };
  }
  const apiUrl = getHomematicApiUrl(settings);
  const hasCredentials = Boolean(String(settings?.homematic_ccu_username || "").trim());
  if (stateChange && apiUrl && hasCredentials) {
    const login = await loginHomematicCcu(settings);
    if (!login.ok) throw new Error(`CCU-Anmeldung fehlgeschlagen: ${login.error}`);
    const script = `dom.GetObject(${stateChange.iseId}).State(${stateChange.newValue});`;
    try {
      await callHomematicJsonRpc(apiUrl, "ReGa.runScript", { _session_id_: login.sid, script });
    } catch (error) {
      console.error(`[HeartPet][CCU][door-command] Datenpunkt ${stateChange.iseId}, Wert ${stateChange.newValue}: ${error.message}`);
      throw new Error(`CCU-Schaltbefehl fehlgeschlagen: ${error.message}`);
    }
    const sensorResult = await waitForDoorSensor(settings, expectedDoorOpen, commandId);
    return { accepted: true, operationStatus: sensorResult.sensorConfigured ? (sensorResult.sensorConfirmed ? "confirmed" : "timeout") : "accepted", commandId, targetValue: Number(stateChange.newValue), ...sensorResult };
  }

  const commandUrl = buildHomematicCommandUrl(configuredUrl, await resolveHomematicSid(settings));
  if (!isHttpUrl(commandUrl)) throw new Error("Ungültige Homematic-Befehls-URL.");
  const response = await fetchWithTimeout(commandUrl, 5000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const responseText = await response.text();
  console.info(`[HeartPet][CCU][door-command][${commandId}] Direkte CCU-Antwort: ${responseText.replace(/\s+/g, " ").trim().slice(0, 500)}`);
  const responseError = getHomematicCommandResponseError(responseText);
  if (responseError) throw new Error(responseError);
  const sensorResult = await waitForDoorSensor(settings, expectedDoorOpen, commandId);
  return { accepted: true, operationStatus: sensorResult.sensorConfigured ? (sensorResult.sensorConfirmed ? "confirmed" : "timeout") : "accepted", commandId, targetValue: stateChange ? Number(stateChange.newValue) : null, ...sensorResult };
}

async function waitForDoorSensor(settings, expectedDoorOpen, commandId = "status") {
  const sensorId = String(settings?.homematic_door_sensor_datapoint_id || "").trim();
  if (!/^\d+$/.test(sensorId) || typeof expectedDoorOpen !== "boolean") {
    return { changed: true, sensorConfigured: false, sensorConfirmed: false, sensorValue: null, expectedSensorValue: null, previousSensorValue: null, attempts: 0 };
  }

  const trueMeansOpen = settings?.homematic_door_sensor_true_state !== "closed";
  const expectedValue = expectedDoorOpen === trueMeansOpen ? 1 : 0;
  const previousValue = await readHomematicXmlApiDatapoint(settings, sensorId);
  console.info(`[HeartPet][CCU][door-command][${commandId}] Türsensor ${sensorId}: vorher ${previousValue}, erwartet ${expectedValue}.`);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    const sensorValue = await readHomematicXmlApiDatapoint(settings, sensorId);
    if (attempt === 0 || sensorValue === expectedValue || attempt === 11) {
      console.info(`[HeartPet][CCU][door-command][${commandId}] Türsensor ${sensorId}: Versuch ${attempt + 1}/12, Wert ${sensorValue}.`);
    }
    if (sensorValue === expectedValue) {
      return {
        changed: previousValue !== expectedValue,
        sensorConfigured: true,
        sensorConfirmed: true,
        sensorValue,
        expectedSensorValue: expectedValue,
        previousSensorValue: previousValue,
        attempts: attempt + 1,
      };
    }
  }
  const sensorValue = await readHomematicXmlApiDatapoint(settings, sensorId);
  return { changed: false, sensorConfigured: true, sensorConfirmed: false, sensorValue, expectedSensorValue: expectedValue, previousSensorValue: previousValue, attempts: 12 };
}

async function readHomematicXmlApiDatapoint(settings, datapointId) {
  const statusUrl = buildHomematicXmlApiUrl(settings, "state.cgi", { datapoint_id: datapointId });
  if (!statusUrl) return null;
  const response = await fetchWithTimeout(statusUrl, 7000);
  if (!response.ok) return null;
  const text = await response.text();
  if (/<not_authenticated\b/i.test(text)) return null;
  const tag = (text.match(new RegExp(`<datapoint\\b[^>]*\\bise_id=["']${datapointId}["'][^>]*>`, "i")) || [])[0] || "";
  const value = tag.match(/\bvalue=["'](true|false|-?\d+(?:[.,]\d+)?)["']/i)?.[1];
  if (value === undefined) return null;
  if (/^true$/i.test(value)) return 1;
  if (/^false$/i.test(value)) return 0;
  return Number(value.replace(",", "."));
}

async function readHomematicClimateFromCcu(settings) {
  const datapointIds = getHomematicClimateDatapointIds(settings);
  if (!datapointIds) return { temperature: null, humidity: null, loginOk: false, stage: "configuration", error: "Temperatur- und Luftfeuchte-Datenpunkt müssen hinterlegt sein." };
  const xmlApiConfig = getHomematicXmlApiConfig(settings);
  if (xmlApiConfig?.token) return readHomematicClimateFromXmlApi(settings, datapointIds);
  const login = await loginHomematicCcu(settings);
  if (!login.ok) return { temperature: null, humidity: null, loginOk: false, stage: "login", error: login.error };
  try {
    const script = `WriteLine("temperature=" # dom.GetObject(${datapointIds.temperatureId}).Value()); WriteLine("humidity=" # dom.GetObject(${datapointIds.humidityId}).Value());`;
    const result = await callHomematicJsonRpc(getHomematicApiUrl(settings), "ReGa.runScript", { _session_id_: login.sid, script });
    const text = typeof result === "string" ? result : JSON.stringify(result || "");
    const temperature = parseHomematicTextValue(text, ["actual_temperature", "temperature", "temperatur", "temp"]);
    const humidity = parseHomematicTextValue(text, ["humidity", "luftfeuchte", "feuchte", "hum"]);
    return {
      temperature,
      humidity,
      loginOk: true,
      stage: temperature === null && humidity === null ? "parse" : "success",
      error: temperature === null && humidity === null ? "CCU erreichbar, aber im Kanal wurden keine Klima-Werte gefunden." : "",
    };
  } catch (error) {
    console.error(`[HeartPet][CCU][climate-read] Datenpunkte ${datapointIds.temperatureId}/${datapointIds.humidityId}: ${error.message}`);
    return { temperature: null, humidity: null, loginOk: true, stage: "climate-read", error: error.message };
  }
}

async function readHomematicClimateFromXmlApi(settings, datapointIds) {
  const climateUrl = buildHomematicXmlApiUrl(settings, "state.cgi", {
    datapoint_id: `${datapointIds.temperatureId},${datapointIds.humidityId}`,
  });
  if (!climateUrl) return { temperature: null, humidity: null, loginOk: false, stage: "configuration", error: "XML-API-Adresse oder Token fehlt." };
  try {
    const response = await fetchWithTimeout(climateUrl, 7000);
    if (!response.ok) throw new Error(`XML-API antwortet mit HTTP ${response.status}.`);
    const text = await response.text();
    if (/<not_authenticated\b/i.test(text)) throw new Error("XML-API-Token ist ungültig oder fehlt.");
    const readValue = (id) => {
      const tag = (text.match(new RegExp(`<datapoint\\b[^>]*\\bise_id=["']${id}["'][^>]*>`, "i")) || [])[0] || "";
      const value = tag.match(/\bvalue=["'](-?\d+(?:[.,]\d+)?)["']/i)?.[1];
      return value === undefined ? null : Number(value.replace(",", "."));
    };
    const temperature = readValue(datapointIds.temperatureId);
    const humidity = readValue(datapointIds.humidityId);
    return {
      temperature,
      humidity,
      loginOk: true,
      stage: temperature === null && humidity === null ? "parse" : "success",
      error: temperature === null && humidity === null ? "XML-API erreichbar, aber die angegebenen Datenpunkte wurden nicht gefunden." : "",
    };
  } catch (error) {
    console.error(`[HeartPet][CCU][xml-api-climate] Datenpunkte ${datapointIds.temperatureId}/${datapointIds.humidityId}: ${error.message}`);
    return { temperature: null, humidity: null, loginOk: false, stage: "climate-read", error: error.message };
  }
}

async function resolveHomematicSid(settings) {
  const token = String(settings?.homematic_xmlapi_token || "").trim();
  if (token) return token;
  return (await loginHomematicCcu(settings)).sid;
}

function getHomematicCommandResponseError(text) {
  const responseText = String(text || "");
  if (/<not_authenticated\b/i.test(responseText)) return "XML-API-Token ist ungültig oder fehlt.";
  if (/<not_found\s*\/>/i.test(responseText)) return "Der Tür-Datenpunkt wurde auf der CCU nicht gefunden. Bitte die ise_id prüfen.";
  if (/<changed\b[^>]*\bsuccess=["']false["']/i.test(responseText)) return "Die CCU hat den Tür-Datenpunkt gefunden, den Schaltwert aber abgelehnt.";
  if (/\berror=["']true["']/i.test(responseText)) return "Datenpunkt wurde von der XML-API nicht gefunden.";
  if (/<result>\s*<\/result>/i.test(responseText)) return "Die CCU hat keine Bestätigung für den Türbefehl geliefert.";
  return "";
}



function getRuntimeMetricsSnapshot() {
  const requests = runtimeMetrics.requests;
  return {
    uptimeSeconds: Math.round((Date.now() - runtimeMetrics.startedAt) / 1000),
    requests,
    errors: runtimeMetrics.errors,
    averageDurationMs: requests ? Math.round(runtimeMetrics.totalDurationMs / requests) : 0,
    slowestDurationMs: Math.round(runtimeMetrics.slowestDurationMs),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    recent: runtimeMetrics.recent.slice(-10).reverse(),
  };
}

function buildOperationalHealthChecks(settings) {
  const cameras = parseCoopCameras(settings.coop_camera_streams);
  const cachedCameras = cameras.filter((camera, index) => {
    const cached = cameraFrameCache.get(index) || readCameraFrameCache(index, camera.snapshotUrl);
    return cached?.createdAt && Date.now() - cached.createdAt < 5 * 60 * 1000;
  }).length;
  const xmlApi = getHomematicXmlApiConfig(settings);
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


function findHomematicValue(value, preferredKeys) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const match = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }
  if (!value || typeof value !== "object") return null;

  const entries = Object.entries(value);
  for (const preferredKey of preferredKeys) {
    const match = entries.find(([key]) => key.toLowerCase().includes(preferredKey));
    if (match) {
      const result = findHomematicValue(match[1], preferredKeys);
      if (result !== null) return result;
    }
  }
  const genericValue = entries.find(([key]) => ["value", "val", "wert"].includes(key.toLowerCase()));
  if (genericValue) return findHomematicValue(genericValue[1], preferredKeys);

  for (const [, nestedValue] of entries.filter(([, item]) => item && typeof item === "object")) {
    const result = findHomematicValue(nestedValue, preferredKeys);
    if (result !== null) return result;
  }
  return null;
}

function parseHomematicTextValue(text, preferredKeys) {
  const normalized = String(text || "").replace(/,/g, ".");
  const datapointValue = findHomematicXmlDatapoint(normalized, preferredKeys);
  if (datapointValue !== null) return datapointValue;
  const escapedKeys = preferredKeys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const namedPattern = new RegExp(`(?:${escapedKeys.join("|")})[^-\\d]{0,40}(-?\\d+(?:\\.\\d+)?)`, "i");
  const namedMatch = normalized.match(namedPattern);
  if (namedMatch) return Number(namedMatch[1]);

  const valueAttribute = normalized.match(/\b(?:value|val|wert)\s*=\s*["'](-?\d+(?:\.\d+)?)["']/i);
  if (valueAttribute) return Number(valueAttribute[1]);

  const plainNumber = normalized.trim().match(/^-?\d+(?:\.\d+)?$/);
  return plainNumber ? Number(plainNumber[0]) : null;
}

function findHomematicXmlDatapoint(xml, preferredKeys) {
  const tags = String(xml || "").match(/<datapoint\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attributes = {};
    tag.replace(/([\w:-]+)\s*=\s*["']([^"']*)["']/g, (match, key, value) => {
      attributes[key.toLowerCase()] = value;
      return match;
    });
    const descriptor = [attributes.name, attributes.type, attributes.paramset_key]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!preferredKeys.some((key) => descriptor.includes(key))) continue;
    const parsed = Number(String(attributes.value || "").replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function readHomematicClimate(url) {
  const normalizedUrl = normalizeConfiguredUrl(url);
  if (!isHttpUrl(normalizedUrl)) return { temperature: null, humidity: null, error: "Ungültige XML-API-URL." };
  try {
    const response = await fetchWithTimeout(normalizedUrl);
    if (!response.ok) return { temperature: null, humidity: null, error: `XML-API antwortet mit HTTP ${response.status}.` };
    const text = await response.text();
    if (/<not_authenticated\b/i.test(text)) {
      return { temperature: null, humidity: null, error: "XML-API verlangt ein gültiges sid-Token." };
    }
    if (/\berror=["']true["']/i.test(text)) {
      return { temperature: null, humidity: null, error: "Geräte- oder Kanal-ID wurde von der XML-API nicht gefunden." };
    }
    const temperature = parseHomematicTextValue(text, ["actual_temperature", "temperature", "temperatur", "temp"]);
    const humidity = parseHomematicTextValue(text, ["humidity", "luftfeuchte", "feuchte", "hum"]);
    return {
      temperature,
      humidity,
      error: temperature === null && humidity === null
        ? "XML empfangen, aber keine Datenpunkte für Temperatur oder Luftfeuchte gefunden."
        : "",
    };
  } catch (error) {
    return { temperature: null, humidity: null, error: describeFetchError(error) };
  }
}

async function readHomematicValue(url, preferredKeys) {
  if (!isHttpUrl(url)) return null;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const text = await response.text();
    try {
      return findHomematicValue(JSON.parse(text), preferredKeys);
    } catch {
      return parseHomematicTextValue(text, preferredKeys);
    }
  } catch {
    return null;
  }
}

function getAppLogoUrl(settings) {
  const storedName = String(settings?.app_logo_stored_name || "").trim();
  return storedName ? "/app-logo" : "/static/images/logo-heartpet.png";
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
    return rawValue ? JSON.parse(rawValue) : {};
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
      return make("Gruppenimpfung eingetragen", details.name || `Impfung #${entityId}`, `${(details.animal_names || []).join(", ")} · ${details.vaccination_date || "-"}`);
    case "veterinarian.create":
      return make("Tierarzt angelegt", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, [details.city, details.email].filter(Boolean).join(" · ") || "Neuer Tierarzt hinterlegt");
    case "veterinarian.update":
      return make("Tierarzt bearbeitet", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, [details.city, details.email].filter(Boolean).join(" · ") || "Kontaktdaten aktualisiert");
    case "veterinarian.set_default":
      return make("Standardtierarzt gesetzt", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, "Wird als Fallback für neue Zuordnungen verwendet");
    case "veterinarian.delete":
      return make("Tierarzt gelöscht", details.name || `Tierarzt #${details.veterinarian_id || entityId}`, "Eintrag aus den Stammdaten entfernt");
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
        'animal.image_create', 'animal.image_delete',
        'animal.profile_image_update', 'animal.profile_image_delete'
      )
    ORDER BY audit_logs.id DESC
    LIMIT ?
  `).all(String(animalId), limit).map(formatAnimalActivityEntry);
}

function buildDashboardActivityFeed(limit = 8) {
  return db.prepare(`
    SELECT audit_logs.*, animals.name AS current_animal_name
    FROM audit_logs
    LEFT JOIN animals
      ON audit_logs.entity_type = 'animal'
     AND CAST(audit_logs.entity_id AS INTEGER) = animals.id
    WHERE audit_logs.entity_type = 'animal'
      AND audit_logs.action IN (
        'animal.create', 'animal.update', 'animal.status_change', 'animal.note_create',
        'animal.document_create', 'animal.image_create', 'animal.profile_image_update'
      )
    ORDER BY audit_logs.id DESC
    LIMIT ?
  `).all(limit).map((entry) => {
    const formatted = formatAnimalActivityEntry(entry);
    return {
      ...formatted,
      animalId: entry.entity_id ? Number(entry.entity_id) : null,
    };
  });
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

function getInstanceTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "UTC";
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
  const raw = String(settings.app_domain || "").trim();
  if (!raw) {
    return "http://127.0.0.1:3000";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, "");
  }
  return `https://${raw}`.replace(/\/+$/, "");
}

app.__test = {
  maybeSendDailyDigest,
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
