const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const multer = require("multer");
const cron = require("node-cron");
const bcrypt = require("bcryptjs");
const dayjs = require("dayjs");

const { initDatabase, getSettingsObject, upsertSetting } = require("./db");
const {
  processDueReminders,
  sendDailyDigestEmail,
  sendDailyDigestTelegram,
  sendTestEmail,
  sendTestTelegram,
  sendUserInviteEmail,
  sendEmailChangeConfirmation,
  verifySmtpConnection,
  isEmailEnabled,
  isTelegramEnabled,
  isEmailConfigured,
  isTelegramConfigured,
  verifyReminderActionToken,
} = require("./reminders");
const { buildAnimalExportPayload, createAnimalPdf } = require("./exporters");

const SQLiteStore = SQLiteStoreFactory(session);
const app = express();
const db = initDatabase();

const projectRoot = path.join(__dirname, "..");

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const targetDir = path.join(projectRoot, "data", "uploads");
    fs.mkdirSync(targetDir, { recursive: true });
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({ storage: uploadStorage });
const importUpload = multer({ storage: multer.memoryStorage() });

app.set("view engine", "ejs");
app.set("views", path.join(projectRoot, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/static", express.static(path.join(projectRoot, "public")));
app.use("/media", express.static(path.join(projectRoot, "data", "uploads")));

app.use(
  session({
    secret: process.env.HEARTPET_SESSION_SECRET || "heartpet-session-secret",
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({
      db: "sessions.sqlite",
      dir: path.join(projectRoot, "data"),
    }),
  })
);

app.use((req, res, next) => {
  const flash = req.session.flash || null;
  delete req.session.flash;
  const currentUserRecord = req.session.user
    ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id)
    : null;

  if (currentUserRecord) {
    req.session.user = {
      id: currentUserRecord.id,
      name: currentUserRecord.name,
      email: currentUserRecord.email,
      role: currentUserRecord.role,
      mustChangePassword: Boolean(currentUserRecord.must_change_password),
    };
  }

  res.locals.flash = flash;
  res.locals.currentUser = req.session.user || null;
  res.locals.appSettings = getSettingsObject(db);
  res.locals.appLogoUrl = getAppLogoUrl(res.locals.appSettings);
  res.locals.currentPath = req.path;
  res.locals.currentQuery = req.query || {};
  res.locals.animalSpeciesMenu = listActiveSpecies();
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.getAnimalAge = getAnimalAge;
  res.locals.getAnimalInitial = getAnimalInitial;
  res.locals.getRoleLabel = getRoleLabel;
  res.locals.applyInfoPagePlaceholders = (content) => applyInfoPagePlaceholders(content, res.locals.appSettings);
  res.locals.permissions = buildPermissions(currentUserRecord || req.session.user);
  res.locals.editState = { type: "", id: null };
  res.locals.reminderBuckets = { overdue: [], open: [], done: [] };
  next();
});

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

app.get("/setup", (req, res) => {
  res.render("pages/setup", {
    pageTitle: "Ersteinrichtung",
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
  });
});

app.post("/setup", (req, res) => {
  if (isSetupComplete()) {
    return res.redirect(req.session.user ? "/" : "/login");
  }

  const adminName = String(req.body.admin_name || "").trim();
  const adminEmail = String(req.body.admin_email || "").trim().toLowerCase();
  const adminPassword = String(req.body.admin_password || "");
  const organizationName = String(req.body.organization_name || "").trim();
  const veterinarianName = String(req.body.veterinarian_name || "").trim();
  const animalName = String(req.body.animal_name || "").trim();
  const speciesName = String(req.body.species_name || "").trim();

  if (!adminName || !adminEmail || !adminPassword || !veterinarianName || !animalName || !speciesName) {
    setFlash(req, "error", "Bitte fülle alle Pflichtfelder der Ersteinrichtung aus.");
    return res.redirect("/setup");
  }

  if (adminPassword.length < 8) {
    setFlash(req, "error", "Das Admin-Passwort muss mindestens 8 Zeichen lang sein.");
    return res.redirect("/setup");
  }

  const duplicateUser = db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail);
  if (duplicateUser) {
    setFlash(req, "error", "Diese E-Mail-Adresse ist bereits vergeben.");
    return res.redirect("/setup");
  }

  const veterinarianPayload = normalizeVeterinarianPayload(req.body, "veterinarian_");
  const addressError = validateVeterinarianAddress(veterinarianPayload);
  if (addressError) {
    setFlash(req, "error", addressError);
    return res.redirect("/setup");
  }

  const setupTx = db.transaction(() => {
    const userResult = db.prepare(`
      INSERT INTO users (
        name, email, password_hash, role, must_change_password,
        can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
        can_manage_feedings, can_manage_notes, can_manage_reminders
      )
      VALUES (?, ?, ?, 'admin', 0, 1, 1, 1, 1, 1, 1, 1)
    `).run(adminName, adminEmail, bcrypt.hashSync(adminPassword, 10));

    const veterinarianResult = db.prepare(`
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
    );

    const species = ensureSpeciesExists(speciesName);
    const animalResult = db.prepare(`
      INSERT INTO animals (
        name, species_id, sex, birth_date, intake_date, source, microchip_number,
        status, color, breed, weight_kg, veterinarian_id, notes, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Aktiv', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      animalName,
      species.id,
      req.body.animal_sex || "",
      req.body.animal_birth_date || null,
      req.body.animal_intake_date || dayjs().format("YYYY-MM-DD"),
      req.body.animal_source || "",
      req.body.animal_microchip_number || "",
      req.body.animal_color || "",
      req.body.animal_breed || "",
      req.body.animal_weight_kg || null,
      veterinarianResult.lastInsertRowid,
      req.body.animal_notes || ""
    );

    if (organizationName) {
      upsertSetting(db, "organization_name", organizationName);
    }
    upsertSetting(db, "setup_complete", "true");

    return {
      userId: userResult.lastInsertRowid,
      animalId: animalResult.lastInsertRowid,
    };
  });

  const result = setupTx();
  req.session.user = {
    id: result.userId,
    name: adminName,
    email: adminEmail,
    role: "admin",
    mustChangePassword: false,
  };

  setFlash(req, "success", "Ersteinrichtung abgeschlossen.");
  res.redirect(`/animals/${result.animalId}`);
});

app.get("/login", (req, res) => {
  const returnTo = safeLocalReturnPath(req.query.return_to, "");
  if (req.session.user) {
    return res.redirect(returnTo || "/");
  }

  res.render("pages/login", { pageTitle: "Login", returnTo });
});

app.post("/login", (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to || req.query.return_to, "");
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    setFlash(req, "error", "Login fehlgeschlagen. Bitte prüfe E-Mail und Passwort.");
    return res.redirect("/login");
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: Boolean(user.must_change_password),
  };

  setFlash(req, "success", "Login erfolgreich.");
  res.redirect(returnTo || "/");
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/email-change/confirm", (req, res) => {
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

app.get("/reminders/:id/email-complete", (req, res) => {
  const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
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
  const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
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

app.get("/", (req, res) => {
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

  const recentAnimals = db.prepare(`
    SELECT animals.*, species.name AS species_name
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    WHERE animals.status = 'Aktiv'
    ORDER BY animals.created_at DESC
    LIMIT 6
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
    dayjs().add(3, "day").endOf("day").format("YYYY-MM-DDTHH:mm"),
    dayjs().format("YYYY-MM-DDTHH:mm"),
    dayjs().endOf("day").format("YYYY-MM-DDTHH:mm")
  );

  res.render("pages/dashboard", {
    pageTitle: "Dashboard",
    search: { q, searchable },
    searchResults,
    stats,
    recentAnimals,
    upcomingReminders,
    urgentReminders,
  });
});

app.get("/animals/historie", (req, res) => {
  renderAnimalsWorkspace(req, res, "history");
});

app.get("/animals/history", (req, res) => {
  res.redirect("/animals/historie");
});

app.get("/animals/ruhestaette", (req, res) => {
  renderAnimalsWorkspace(req, res, "resting");
});

app.get("/animals/ruhestatte", (req, res) => {
  res.redirect("/animals/ruhestaette");
});

app.get("/suche", (req, res) => {
  const q = String(req.query.q || "").trim();
  return res.redirect(q ? `/?q=${encodeURIComponent(q)}` : "/");
});

app.get("/animals", (req, res) => {
  renderAnimalsWorkspace(req, res, "active");
});

function renderAnimalsWorkspace(req, res, section = "active") {
  const sectionConfig = getAnimalSectionConfig(section);
  const search = (req.query.q || "").trim();
  const requestedStatus = (req.query.status || "").trim();
  const speciesId = (req.query.species_id || "").trim();
  const sort = (req.query.sort || "name_asc").trim();
  const selectedAnimalId = (req.query.animal_id || "").trim();
  const page = Math.max(Number.parseInt(req.query.page || "1", 10) || 1, 1);
  const pageSize = 25;
  const allowedStatuses = sectionConfig.allowedStatuses;
  const status = sectionConfig.allowStatusFilter && allowedStatuses.includes(requestedStatus)
    ? requestedStatus
    : sectionConfig.defaultStatus;

  let sql = `
    SELECT animals.*, species.name AS species_name, veterinarians.name AS veterinarian_name
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    LEFT JOIN veterinarians ON veterinarians.id = animals.veterinarian_id
    WHERE 1 = 1
  `;
  const params = [];

  if (search) {
    sql += ` AND (animals.name LIKE ? OR animals.source LIKE ? OR animals.breed LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (status) {
    sql += ` AND animals.status = ?`;
    params.push(status);
  } else if (allowedStatuses.length) {
    const placeholders = allowedStatuses.map(() => "?").join(", ");
    sql += ` AND animals.status IN (${placeholders})`;
    params.push(...allowedStatuses);
  }

  if (speciesId) {
    sql += ` AND animals.species_id = ?`;
    params.push(speciesId);
  }
  const allAnimals = db.prepare(sql).all(...params);
  const animalsWithNextTerm = attachNextTermData(allAnimals);
  const sortedAnimals = sortAnimals(animalsWithNextTerm, sort);
  const totalCount = sortedAnimals.length;
  const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const animals = sortedAnimals.slice(startIndex, startIndex + pageSize);
  const selectedAnimal = selectedAnimalId
    ? animals.find((item) => String(item.id) === String(selectedAnimalId)) || sortedAnimals.find((item) => String(item.id) === String(selectedAnimalId)) || null
    : animals[0] || null;

  res.render("pages/animals-index", {
    pageTitle: sectionConfig.pageTitle,
    animals,
    selectedAnimal,
    selectedAnimalView: selectedAnimal ? buildAnimalDetailViewData(selectedAnimal.id, req) : null,
    filters: { search, status, speciesId, sort },
    animalSection: sectionConfig,
    speciesOptions: listActiveSpecies(),
    pagination: {
      currentPage,
      totalPages,
      totalCount,
      pageSize,
    },
  });
}

app.get("/animals/suggest", renderSearchSuggestions);
app.get("/admin/suggest", renderSearchSuggestions);
app.get("/animals/systemlog", requireAdmin, (req, res) => {
  res.redirect("/admin/systemlog");
});
app.get("/admin/systemlog/systemlog", requireAdmin, (req, res) => {
  res.redirect("/admin/systemlog");
});

app.get("/animals/new", requireAnimalEditor, (req, res) => {
  res.render("pages/animal-form", {
    pageTitle: "Tier anlegen",
    animal: null,
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    returnTo: getAnimalReturnTo(req, "/animals"),
  });
});

app.post("/animals", requireAnimalEditor, (req, res) => {
  const payload = normalizeAnimalPayload(req.body);
  const returnTo = safeLocalReturnPath(req.body.return_to, "/animals");
  if (!payload.name || !payload.species_id) {
    setFlash(req, "error", "Name und Tierart sind Pflichtfelder.");
    return res.redirect(`/animals/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  const result = db.prepare(`
    INSERT INTO animals (
      name, species_id, sex, birth_date, intake_date, source, microchip_number,
      status, color, breed, weight_kg, veterinarian_id, notes, updated_at
    )
    VALUES (
      @name, @species_id, @sex, @birth_date, @intake_date, @source, @microchip_number,
      @status, @color, @breed, @weight_kg, @veterinarian_id, @notes, CURRENT_TIMESTAMP
    )
  `).run(payload);

  if (!isActiveAnimalStatus(payload.status)) {
    closeOpenRemindersForAnimal(result.lastInsertRowid);
  }

  setFlash(req, "success", "Tier wurde angelegt.");
  res.redirect(returnTo || `/animals/${result.lastInsertRowid}`);
});

app.get("/animals/:id", (req, res) => {
  const animalView = buildAnimalDetailViewData(req.params.id, req);
  if (!animalView) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  res.render("pages/animal-show", {
    pageTitle: animalView.animal.name,
    ...animalView,
  });
});

app.get("/animals/:id/workspace-panel", (req, res) => {
  const animalView = buildAnimalDetailViewData(req.params.id, req);
  if (!animalView) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  const selectedAnimal = attachNextTermData([animalView.animal])[0] || animalView.animal;
  res.render("pages/animal-workspace-detail", {
    selectedAnimal,
    selectedAnimalView: animalView,
  });
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
  });
}

app.get("/animals/:id/events/new", (req, res) => {
  const permissions = buildPermissions(getCurrentUserRecord(req));
  if (!permissions.canManageHealth && !permissions.canManageReminders) {
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

app.get("/animals/:id/edit", requireAnimalEditor, (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, getAnimalReturnTo(req, `/animals/${req.params.id}`));
  }

  res.render("pages/animal-form", {
    pageTitle: `${animal.name} bearbeiten`,
    animal,
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    returnTo: getAnimalReturnTo(req, `/animals/${req.params.id}`),
  });
});

app.get("/animals/:id/update", requireAnimalEditor, (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(req, res, getAnimalReturnTo(req, `/animals/${req.params.id}`), `/animals/${req.params.id}/edit`);
});

app.post("/animals/:id/update", requireAnimalEditor, (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  const payload = normalizeAnimalPayload(req.body);
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  if (!payload.name || !payload.species_id) {
    setFlash(req, "error", "Name und Tierart sind Pflichtfelder.");
    return res.redirect(`/animals/${req.params.id}/edit?return_to=${encodeURIComponent(returnTo)}`);
  }
  payload.id = req.params.id;

  db.prepare(`
    UPDATE animals
    SET name = @name,
        species_id = @species_id,
        sex = @sex,
        birth_date = @birth_date,
        intake_date = @intake_date,
        source = @source,
        microchip_number = @microchip_number,
        status = @status,
        color = @color,
        breed = @breed,
        weight_kg = @weight_kg,
        veterinarian_id = @veterinarian_id,
        notes = @notes,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run(payload);

  if (isActiveAnimalStatus(animal.status) && !isActiveAnimalStatus(payload.status)) {
    closeOpenRemindersForAnimal(req.params.id);
  }

  setFlash(req, "success", "Tierdaten wurden aktualisiert.");
  res.redirect(returnTo);
});

app.post("/animals/:id/events", (req, res) => {
  const user = req.session.user ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id) : null;
  const permissions = buildPermissions(user);
  const eventKind = String(req.body.event_kind || "").trim();
  const title = String(req.body.title || "").trim();
  const notes = appendVeterinarianNote(req.body.notes, req.body.handled_by_veterinarian, req.body.veterinarian_id);
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);

  if (!["medication", "vaccination", "appointment", "reminder"].includes(eventKind)) {
    setFlash(req, "error", "Bitte wähle einen gültigen Ereignistyp aus.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (!title) {
    setFlash(req, "error", "Bitte gib eine Bezeichnung für das Ereignis an.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (req.body.handled_by_veterinarian && !req.body.veterinarian_id) {
    setFlash(req, "error", "Bitte wähle einen Tierarzt aus.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (eventKind === "reminder" && !permissions.canManageReminders) {
    setFlash(req, "error", "Für freie Erinnerungen fehlen die erforderlichen Rechte.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (eventKind !== "reminder" && !permissions.canManageHealth) {
    setFlash(req, "error", "Für medizinische Ereignisse fehlen die erforderlichen Rechte.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  try {
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
        INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, reminder_enabled, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id,
        title,
        isFuture ? null : eventDate,
        isFuture ? eventDate : null,
        req.body.create_reminder ? 1 : 0,
        notes
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
    setFlash(req, "error", error.message || "Das Ereignis konnte nicht gespeichert werden.");
    return res.redirect(`/animals/${req.params.id}/events/new?return_to=${encodeURIComponent(returnTo)}`);
  }
});

app.post("/animals/:id/conditions", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)")
    .run(req.params.id, req.body.title, req.body.details || "");
  setFlash(req, "success", "Vorerkrankung gespeichert.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/conditions/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE animal_conditions
    SET title = ?, details = ?
    WHERE id = ? AND animal_id = ?
  `).run(req.body.title, req.body.details || "", req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Vorerkrankung aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/conditions/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/conditions/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/conditions/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare("DELETE FROM animal_conditions WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Vorerkrankung gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/medications", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  const result = db.prepare(`
    INSERT INTO animal_medications (animal_id, name, dosage, schedule, start_date, end_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.name,
    req.body.dosage || "",
    req.body.schedule || "",
    req.body.start_date || null,
    req.body.end_date || null,
    req.body.notes || ""
  );
  syncMedicationReminders(req.params.id, result.lastInsertRowid);
  setFlash(req, "success", "Medikation gespeichert.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/medications/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE animal_medications
    SET name = ?, dosage = ?, schedule = ?, start_date = ?, end_date = ?, notes = ?
    WHERE id = ? AND animal_id = ?
  `).run(
    req.body.name,
    req.body.dosage || "",
    req.body.schedule || "",
    req.body.start_date || null,
    req.body.end_date || null,
    req.body.notes || "",
    req.params.entryId,
    req.params.animalId
  );
  syncMedicationReminders(req.params.animalId, req.params.entryId);
  setFlash(req, "success", "Medikation aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/medications/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/medications/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/medications/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
  deleteGeneratedReminders("medication", req.params.entryId);
  db.prepare("DELETE FROM animal_medications WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Medikation gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/vaccinations", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  const result = db.prepare(`
    INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.name,
    req.body.vaccination_date || null,
    req.body.next_due_date || null,
    req.body.notes || ""
  );
  syncVaccinationReminders(req.params.id, result.lastInsertRowid);
  setFlash(req, "success", "Impfung gespeichert.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/vaccinations/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE animal_vaccinations
    SET name = ?, vaccination_date = ?, next_due_date = ?, notes = ?
    WHERE id = ? AND animal_id = ?
  `).run(
    req.body.name,
    req.body.vaccination_date || null,
    req.body.next_due_date || null,
    req.body.notes || "",
    req.params.entryId,
    req.params.animalId
  );
  syncVaccinationReminders(req.params.animalId, req.params.entryId);
  setFlash(req, "success", "Impfung aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/vaccinations/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/vaccinations/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/vaccinations/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
  deleteGeneratedReminders("vaccination", req.params.entryId);
  db.prepare("DELETE FROM animal_vaccinations WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Impfung gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/appointments", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  const result = db.prepare(`
    INSERT INTO animal_appointments (animal_id, title, appointment_at, location_mode, location_text, veterinarian_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.title,
    req.body.appointment_at,
    req.body.location_mode || "praxis",
    req.body.location_text || "",
    req.body.veterinarian_id || null,
    req.body.notes || ""
  );
  syncAppointmentReminders(req.params.id, result.lastInsertRowid);
  setFlash(req, "success", "Arzttermin gespeichert.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/appointments/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE animal_appointments
    SET title = ?, appointment_at = ?, location_mode = ?, location_text = ?, veterinarian_id = ?, notes = ?
    WHERE id = ? AND animal_id = ?
  `).run(
    req.body.title,
    req.body.appointment_at,
    req.body.location_mode || "praxis",
    req.body.location_text || "",
    req.body.veterinarian_id || null,
    req.body.notes || "",
    req.params.entryId,
    req.params.animalId
  );
  syncAppointmentReminders(req.params.animalId, req.params.entryId);
  setFlash(req, "success", "Arzttermin aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/appointments/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/appointments/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/appointments/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
  deleteGeneratedReminders("appointment", req.params.entryId);
  db.prepare("DELETE FROM animal_appointments WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Arzttermin gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
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
  setFlash(req, "success", "Protokolleintrag gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/reminders", requireAnimalPermission("canManageReminders"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  db.prepare(`
    INSERT INTO reminders (
      animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
      last_delivery_status, last_delivery_error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.title,
    req.body.reminder_type || "Allgemein",
    req.body.due_at,
    req.body.channel_email ? 1 : 0,
    req.body.channel_telegram ? 1 : 0,
    parsePositiveInteger(req.body.repeat_interval_days),
    req.body.notes || "",
    "pending",
    ""
  );
  setFlash(req, "success", "Erinnerung angelegt.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/reminders/:entryId/update", requireAnimalPermission("canManageReminders"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE reminders
    SET title = ?, reminder_type = ?, due_at = ?, channel_email = ?, channel_telegram = ?, repeat_interval_days = ?, notes = ?,
        last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
    WHERE id = ? AND animal_id = ?
  `).run(
    req.body.title,
    req.body.reminder_type || "Allgemein",
    req.body.due_at,
    req.body.channel_email ? 1 : 0,
    req.body.channel_telegram ? 1 : 0,
    parsePositiveInteger(req.body.repeat_interval_days),
    req.body.notes || "",
    req.params.entryId,
    req.params.animalId
  );
  setFlash(req, "success", "Erinnerung aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/reminders/:entryId/update", requireAnimalPermission("canManageReminders"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/reminders/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/reminders/:entryId/delete", requireAnimalPermission("canManageReminders"), (req, res) => {
  db.prepare("DELETE FROM reminders WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  createAuditLog(req, "reminder.delete", {
    reminder_id: req.params.entryId,
    animal_id: req.params.animalId,
  }, { entityType: "reminder", entityId: req.params.entryId });
  setFlash(req, "success", "Erinnerung gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/reminders/bulk", requireAnimalPermission("canManageReminders"), (req, res) => {
  const selected = Array.isArray(req.body.reminder_ids) ? req.body.reminder_ids : [req.body.reminder_ids];
  const ids = selected
    .map((value) => Number.parseInt(String(value || ""), 10))
    .filter((value) => Number.isFinite(value));
  const action = String(req.body.bulk_action || "").trim();

  if (!ids.length) {
    setFlash(req, "error", "Bitte mindestens eine Erinnerung auswählen.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  const placeholders = ids.map(() => "?").join(", ");
  const reminders = db.prepare(`
    SELECT *
    FROM reminders
    WHERE animal_id = ? AND id IN (${placeholders})
  `).all(req.params.id, ...ids);

  if (!reminders.length) {
    setFlash(req, "error", "Keine passenden Erinnerungen gefunden.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (action === "complete") {
    const update = db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?");
    reminders.forEach((item) => {
      applyCompletionSideEffects(item);
      update.run(item.id);
    });
    createAuditLog(req, "reminder.bulk_complete", { ids, animal_id: req.params.id }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", `${reminders.length} Erinnerung(en) als erledigt markiert.`);
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (action === "reopen") {
    db.prepare("UPDATE reminders SET completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = '' WHERE id IN (" + placeholders + ")")
      .run(...reminders.map((item) => item.id));
    createAuditLog(req, "reminder.bulk_reopen", { ids, animal_id: req.params.id }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", `${reminders.length} Erinnerung(en) wieder geöffnet.`);
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (action === "delete") {
    db.prepare("DELETE FROM reminders WHERE id IN (" + placeholders + ")").run(...reminders.map((item) => item.id));
    createAuditLog(req, "reminder.bulk_delete", { ids, animal_id: req.params.id }, { entityType: "animal", entityId: req.params.id });
    setFlash(req, "success", `${reminders.length} Erinnerung(en) gelöscht.`);
    return res.redirect(`/animals/${req.params.id}`);
  }

  setFlash(req, "error", "Ungültige Massenaktion.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/reminders/:id/complete", requireAnimalPermission("canManageReminders"), (req, res) => {
  const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
  if (!reminder) {
    return renderNotFound(req, res, "Erinnerung nicht gefunden.");
  }

  if (Number(reminder.repeat_interval_days || 0) > 0) {
    applyCompletionSideEffects(reminder);
    db.prepare(`
      UPDATE reminders
      SET due_at = ?, completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
      WHERE id = ?
    `).run(dayjs(reminder.due_at).add(Number(reminder.repeat_interval_days), "day").format("YYYY-MM-DDTHH:mm"), reminder.id);
    setFlash(req, "success", "Wiederkehrende Erinnerung abgeschlossen und neu terminiert.");
  } else {
    db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    applyCompletionSideEffects(reminder);
    setFlash(req, "success", "Erinnerung als erledigt markiert.");
  }
  createAuditLog(req, "reminder.complete", { reminder_id: reminder.id, animal_id: reminder.animal_id }, { entityType: "reminder", entityId: reminder.id });
  res.redirect(req.get("referer") || "/");
});

app.post("/reminders/:id/reopen", requireAnimalPermission("canManageReminders"), (req, res) => {
  db.prepare(`
    UPDATE reminders
    SET completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
    WHERE id = ?
  `).run(req.params.id);
  createAuditLog(req, "reminder.reopen", { reminder_id: req.params.id }, { entityType: "reminder", entityId: req.params.id });
  setFlash(req, "success", "Erinnerung wieder geöffnet.");
  res.redirect(req.get("referer") || "/");
});

app.post("/animals/:id/documents", requireAnimalPermission("canManageDocuments"), upload.single("document"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  if (!req.file) {
    setFlash(req, "error", "Bitte wähle eine Datei aus.");
    return res.redirect(`/animals/${req.params.id}/documents/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  db.prepare(`
    INSERT INTO documents (animal_id, category_id, title, original_name, stored_name, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.category_id || null,
    req.body.title || req.file.originalname,
    req.file.originalname,
    req.file.filename,
    req.file.mimetype,
    req.file.size
  );

  setFlash(req, "success", "Dokument hochgeladen.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/documents/:entryId/update", requireAnimalPermission("canManageDocuments"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.animalId}`);
  db.prepare(`
    UPDATE documents
    SET title = ?, category_id = ?
    WHERE id = ? AND animal_id = ?
  `).run(req.body.title, req.body.category_id || null, req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Dokument aktualisiert.");
  res.redirect(returnTo);
});

app.get("/animals/:animalId/documents/:entryId/update", requireAnimalPermission("canManageDocuments"), (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(
    req,
    res,
    getAnimalReturnTo(req, `/animals/${req.params.animalId}`),
    `/animals/${req.params.animalId}/documents/${req.params.entryId}/edit`
  );
});

app.post("/animals/:animalId/documents/:entryId/delete", requireAnimalPermission("canManageDocuments"), (req, res) => {
  const document = db.prepare("SELECT * FROM documents WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (document) {
    const fullPath = path.join(process.cwd(), "data", "uploads", document.stored_name);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }
  db.prepare("DELETE FROM documents WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Dokument gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/profile-image", requireAnimalPermission("canManageGallery"), upload.single("profile_image"), (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  if (!req.file) {
    setFlash(req, "error", "Bitte wähle ein Bild aus.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (!String(req.file.mimetype || "").startsWith("image/")) {
    fs.unlinkSync(req.file.path);
    setFlash(req, "error", "Es können nur Bilddateien als Profilbild gespeichert werden.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  db.prepare(`
    UPDATE animals
    SET profile_image_stored_name = ?,
        profile_image_original_name = ?,
        profile_image_mime_type = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.file.filename, req.file.originalname, req.file.mimetype, req.params.id);

  deleteUploadedFileIfUnreferenced(animal.profile_image_stored_name);

  setFlash(req, "success", "Profilbild gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:id/profile-image/delete", requireAnimalPermission("canManageGallery"), (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  db.prepare(`
    UPDATE animals
    SET profile_image_stored_name = NULL,
        profile_image_original_name = NULL,
        profile_image_mime_type = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);

  deleteUploadedFileIfUnreferenced(animal.profile_image_stored_name);

  setFlash(req, "success", "Profilbild entfernt.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:id/images", requireAnimalPermission("canManageGallery"), upload.single("image"), (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, `/animals/${req.params.id}`);
  if (!req.file) {
    setFlash(req, "error", "Bitte ein Bild auswählen.");
    return res.redirect(`/animals/${req.params.id}/images/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  if (!String(req.file.mimetype || "").startsWith("image/")) {
    fs.unlinkSync(req.file.path);
    setFlash(req, "error", "Es können nur Bilddateien hochgeladen werden.");
    return res.redirect(`/animals/${req.params.id}/images/new?return_to=${encodeURIComponent(returnTo)}`);
  }

  db.prepare(`
    INSERT INTO animal_images (animal_id, title, original_name, stored_name, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.title || "",
    req.file.originalname,
    req.file.filename,
    req.file.mimetype,
    req.file.size
  );

  setFlash(req, "success", "Bild zur Galerie hinzugefügt.");
  res.redirect(returnTo);
});

app.post("/animals/:animalId/images/:entryId/delete", requireAnimalPermission("canManageGallery"), (req, res) => {
  const image = db.prepare("SELECT * FROM animal_images WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!image) {
    return renderNotFound(req, res, "Bild nicht gefunden.");
  }

  const fullPath = path.join(process.cwd(), "data", "uploads", image.stored_name);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }

  db.prepare("DELETE FROM animal_images WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Galeriebild gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:animalId/images/:entryId/set-profile", requireAnimalPermission("canManageGallery"), (req, res) => {
  const image = db.prepare("SELECT * FROM animal_images WHERE id = ? AND animal_id = ?").get(req.params.entryId, req.params.animalId);
  if (!image) {
    return renderNotFound(req, res, "Bild nicht gefunden.");
  }

  db.prepare(`
    UPDATE animals
    SET profile_image_stored_name = ?, profile_image_original_name = ?, profile_image_mime_type = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(image.stored_name, image.original_name, image.mime_type || "", req.params.animalId);

  setFlash(req, "success", "Galeriebild als Profilbild gesetzt.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.get("/documents/:id/download", (req, res) => {
  const document = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (!document) {
    return renderNotFound(req, res, "Dokument nicht gefunden.");
  }

  const fullPath = path.join(process.cwd(), "data", "uploads", document.stored_name);
  if (!fs.existsSync(fullPath)) {
    return renderNotFound(req, res, "Datei wurde auf dem Server nicht gefunden.");
  }

  res.download(fullPath, document.original_name);
});

app.get("/animals/:id/export/json", (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  const payload = buildAnimalExportPayload(animal, getAnimalRelatedData(req.params.id), {
    uploadsDir: path.join(process.cwd(), "data", "uploads"),
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
      uploadsDir: path.join(process.cwd(), "data", "uploads"),
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

app.get("/admin/stammdaten", requireAdmin, (req, res) => {
  const viewData = getAdminViewData("Stammdaten", "/admin/stammdaten");
  viewData.masterEdit = {
    categoryId: Number(req.query.editCategory || 0) || null,
    speciesId: Number(req.query.editSpecies || 0) || null,
    veterinarianId: Number(req.query.editVeterinarian || 0) || null,
  };
  res.render("pages/admin-masterdata", viewData);
});

["/admin/masterdata", "/admin/master-data"].forEach((aliasPath) => {
  app.get(aliasPath, requireAdmin, (req, res) => {
    const suffix = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    res.redirect(`/admin/stammdaten${suffix}`);
  });
});

app.get("/admin/categories/new", requireAdmin, (req, res) => {
  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, "/admin/stammdaten");
  }
  res.render("pages/admin-masterdata-drawer", {
    pageTitle: "Neue Dokumentkategorie",
    entityType: "category",
    item: null,
    veterinarians: [],
    returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/stammdaten")),
  });
});

app.get("/admin/categories/:id/edit", requireAdmin, (req, res) => {
  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, "/admin/stammdaten");
  }
  const item = db.prepare("SELECT * FROM document_categories WHERE id = ?").get(req.params.id);
  if (!item) {
    return renderNotFound(req, res, "Dokumentkategorie nicht gefunden.");
  }
  res.render("pages/admin-masterdata-drawer", {
    pageTitle: "Dokumentkategorie bearbeiten",
    entityType: "category",
    item,
    veterinarians: [],
    returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/stammdaten")),
  });
});

app.get("/admin/veterinarians/new", requireAdmin, (req, res) => {
  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, "/admin/stammdaten");
  }
  res.render("pages/admin-masterdata-drawer", {
    pageTitle: "Neuer Tierarzt",
    entityType: "veterinarian",
    item: null,
    veterinarians: [],
    returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/stammdaten")),
  });
});

app.get("/admin/veterinarians/:id/edit", requireAdmin, (req, res) => {
  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, "/admin/stammdaten");
  }
  const item = db.prepare("SELECT * FROM veterinarians WHERE id = ?").get(req.params.id);
  if (!item) {
    return renderNotFound(req, res, "Tierarzt nicht gefunden.");
  }
  res.render("pages/admin-masterdata-drawer", {
    pageTitle: "Tierarzt bearbeiten",
    entityType: "veterinarian",
    item,
    veterinarians: [],
    returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/stammdaten")),
  });
});

app.get("/admin/species/new", requireAdmin, (req, res) => {
  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, "/admin/stammdaten");
  }
  res.render("pages/admin-masterdata-drawer", {
    pageTitle: "Neue Tierart",
    entityType: "species",
    item: null,
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/stammdaten")),
  });
});

app.get("/admin/species/:id/edit", requireAdmin, (req, res) => {
  if (!isDrawerRequest(req)) {
    return redirectDocumentDrawerRequest(req, res, "/admin/stammdaten");
  }
  const item = db.prepare("SELECT * FROM species WHERE id = ?").get(req.params.id);
  if (!item) {
    return renderNotFound(req, res, "Tierart nicht gefunden.");
  }
  res.render("pages/admin-masterdata-drawer", {
    pageTitle: "Tierart bearbeiten",
    entityType: "species",
    item,
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    returnTo: safeLocalReturnPath(req.query.return_to, backTo(req, "/admin/stammdaten")),
  });
});

app.get("/admin/categories/:id/update", requireAdmin, (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(req, res, "/admin/stammdaten", `/admin/categories/${req.params.id}/edit`);
});

app.get("/admin/species/:id/update", requireAdmin, (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(req, res, "/admin/stammdaten", `/admin/species/${req.params.id}/edit`);
});

app.get("/admin/veterinarians/:id/update", requireAdmin, (req, res) => {
  setFlash(req, "error", "Bitte Änderungen über das Formular speichern.");
  redirectDocumentDrawerRequest(req, res, "/admin/stammdaten", `/admin/veterinarians/${req.params.id}/edit`);
});

app.get("/admin/benutzer", requireAdmin, (req, res) => {
  const viewData = getAdminViewData("Benutzer", "/admin/benutzer");
  viewData.selfUser = db.prepare(`
    SELECT id, name, email, role, must_change_password
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

app.get("/admin/systemlog", requireAdmin, (req, res) => {
  const level = String(req.query.level || "all").trim();
  const whereLevel = level === "all" ? "" : "WHERE channel = ?";
  const notificationLogs = db.prepare(`
    SELECT *
    FROM notification_logs
    ${whereLevel}
    ORDER BY created_at DESC
    LIMIT 200
  `).all(...(level === "all" ? [] : [level]));

  const auditLogs = db.prepare(`
    SELECT *
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  res.render("pages/admin-systemlog", {
    ...getAdminViewData("Systemlog", "/admin/systemlog"),
    filters: { level },
    notificationLogs,
    auditLogs,
  });
});

["/systemlog", "/system-log", "/admin/system-log", "/admin/log"].forEach((aliasPath) => {
  app.get(aliasPath, requireAdmin, (req, res) => {
    res.redirect("/admin/systemlog");
  });
});

app.get(/^\/.+\/systemlog$/, requireAdmin, (req, res) => {
  res.redirect("/admin/systemlog");
});
app.get(/^\/.+\/system-log$/, requireAdmin, (req, res) => {
  res.redirect("/admin/systemlog");
});

app.post("/admin/settings", requireAdmin, upload.single("app_logo"), (req, res) => {
  const booleanKeys = new Set([
    "smtp_secure",
    "reminder_email_enabled",
    "reminder_telegram_enabled",
    "browser_notifications_enabled",
    "daily_digest_enabled",
    "daily_digest_only_when_open",
  ]);
  const fields = String(req.body._fields || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  fields.forEach((key) => {
    if (booleanKeys.has(key)) {
      upsertSetting(db, key, parseBooleanSettingValue(req.body[key]) ? "true" : "false");
      return;
    }

    upsertSetting(db, key, normalizeSettingsInputValue(key, req.body[key]));
  });

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

app.post("/admin/categories", requireAdmin, (req, res) => {
  const body = req.body || {};
  const returnTo = safeLocalReturnPath(body.return_to, backTo(req, "/admin/stammdaten"));
  try {
    db.prepare("INSERT INTO document_categories (name, is_required) VALUES (?, ?)")
      .run(String(body.name || "").trim(), body.is_required ? 1 : 0);
    setFlash(req, "success", "Dokumentkategorie angelegt.");
  } catch (error) {
    setFlash(req, "error", "Dokumentkategorie konnte nicht angelegt werden (Name ggf. bereits vorhanden).");
  }
  return redirectAfterPost(res, returnTo);
});

app.post("/admin/categories/:id/update", requireAdmin, (req, res) => {
  const body = req.body || {};
  const returnTo = safeLocalReturnPath(body.return_to, backTo(req, "/admin/stammdaten"));
  try {
    db.prepare(`
      UPDATE document_categories
      SET name = ?, is_required = ?
      WHERE id = ?
    `).run(String(body.name || "").trim(), body.is_required ? 1 : 0, req.params.id);
    setFlash(req, "success", "Dokumentkategorie aktualisiert.");
  } catch (error) {
    setFlash(req, "error", "Dokumentkategorie konnte nicht aktualisiert werden.");
  }
  return redirectAfterPost(res, returnTo);
});

app.post("/admin/categories/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM document_categories WHERE id = ?").run(req.params.id);
  setFlash(req, "success", "Dokumentkategorie entfernt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/species", requireAdmin, (req, res) => {
  const body = req.body || {};
  const returnTo = safeLocalReturnPath(body.return_to, backTo(req, "/admin/stammdaten"));
  try {
    db.prepare("INSERT INTO species (name, default_veterinarian_id, notes) VALUES (?, ?, ?)")
      .run(
        String(body.name || "").trim(),
        body.default_veterinarian_id || null,
        String(body.notes || "").trim()
      );
    setFlash(req, "success", "Tierart angelegt.");
  } catch (error) {
    setFlash(req, "error", "Tierart konnte nicht angelegt werden (Name ggf. bereits vorhanden).");
  }
  return redirectAfterPost(res, returnTo);
});

app.post("/admin/species/:id/update", requireAdmin, (req, res) => {
  const body = req.body || {};
  const returnTo = safeLocalReturnPath(body.return_to, backTo(req, "/admin/stammdaten"));
  try {
    db.prepare(`
      UPDATE species
      SET name = ?, default_veterinarian_id = ?, notes = ?
      WHERE id = ?
    `).run(
      String(body.name || "").trim(),
      body.default_veterinarian_id || null,
      String(body.notes || "").trim(),
      req.params.id
    );
    setFlash(req, "success", "Tierart aktualisiert.");
  } catch (error) {
    setFlash(req, "error", "Tierart konnte nicht aktualisiert werden.");
  }
  return redirectAfterPost(res, returnTo);
});

app.post("/admin/species/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM species WHERE id = ?").run(req.params.id);
  setFlash(req, "success", "Tierart entfernt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/veterinarians", requireAdmin, (req, res) => {
  const payload = normalizeVeterinarianPayload(req.body);
  const returnTo = safeLocalReturnPath(req.body.return_to, backTo(req, "/admin/stammdaten"));
  const addressError = validateVeterinarianAddress(payload);
  if (addressError) {
    setFlash(req, "error", addressError);
    return redirectAfterPost(res, returnTo);
  }

  try {
    db.prepare(`
      INSERT INTO veterinarians (name, street, postal_code, city, country, email, phone, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(req.body.name || "").trim(),
      payload.street,
      payload.postal_code,
      payload.city,
      payload.country,
      payload.email,
      payload.phone,
      payload.notes
    );
    setFlash(req, "success", "Tierarzt gespeichert.");
  } catch (error) {
    setFlash(req, "error", "Tierarzt konnte nicht gespeichert werden.");
  }
  return redirectAfterPost(res, returnTo);
});

app.post("/admin/veterinarians/:id/update", requireAdmin, (req, res) => {
  const payload = normalizeVeterinarianPayload(req.body);
  const returnTo = safeLocalReturnPath(req.body.return_to, backTo(req, "/admin/stammdaten"));
  const addressError = validateVeterinarianAddress(payload);
  if (addressError) {
    setFlash(req, "error", addressError);
    return redirectAfterPost(res, returnTo);
  }

  try {
    db.prepare(`
      UPDATE veterinarians
      SET name = ?, street = ?, postal_code = ?, city = ?, country = ?, email = ?, phone = ?, notes = ?
      WHERE id = ?
    `).run(
      String(req.body.name || "").trim(),
      payload.street,
      payload.postal_code,
      payload.city,
      payload.country,
      payload.email,
      payload.phone,
      payload.notes,
      req.params.id
    );
    setFlash(req, "success", "Tierarzt aktualisiert.");
  } catch (error) {
    setFlash(req, "error", "Tierarzt konnte nicht aktualisiert werden.");
  }
  return redirectAfterPost(res, returnTo);
});

app.post("/admin/veterinarians/:id/set-default", requireAdmin, (req, res) => {
  const vet = db.prepare("SELECT id FROM veterinarians WHERE id = ?").get(req.params.id);
  if (!vet) {
    setFlash(req, "error", "Tierarzt nicht gefunden.");
    return res.redirect(backTo(req, "/admin/stammdaten"));
  }
  upsertSetting(db, "default_veterinarian_id", String(vet.id));
  setFlash(req, "success", "Standardtierarzt gesetzt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/veterinarians/:id/delete", requireAdmin, (req, res) => {
  if (String(getSettingsObject(db).default_veterinarian_id || "") === String(req.params.id)) {
    upsertSetting(db, "default_veterinarian_id", "");
  }
  db.prepare("DELETE FROM veterinarians WHERE id = ?").run(req.params.id);
  setFlash(req, "success", "Tierarzt entfernt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/users", requireAdmin, async (req, res) => {
  const returnTo = safeLocalReturnPath(req.body.return_to, backTo(req, "/admin/benutzer"));
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = String(req.body.role || "viewer");

  if (!name || !email || !password) {
    setFlash(req, "error", "Name, E-Mail und Startpasswort sind Pflichtfelder.");
    return redirectAfterPost(res, returnTo);
  }

  const duplicate = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (duplicate) {
    setFlash(req, "error", "Diese E-Mail-Adresse wird bereits verwendet.");
    return redirectAfterPost(res, returnTo);
  }

  const passwordHash = bcrypt.hashSync(password, 10);
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

  if (req.body.send_invite_email) {
    try {
      await sendUserInviteEmail(getSettingsObject(db), {
        userId: userResult.lastInsertRowid,
        name,
        email,
        roleLabel: getRoleLabel(role),
        temporaryPassword: password,
      });
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "email",
        type: "invite",
        recipient: email,
        subject: "Benutzer-Einladung",
        status: "sent",
        details: { target_user_id: userResult.lastInsertRowid },
      });
      setFlash(req, "success", `Benutzer angelegt und Einladungs-Mail an ${email} versendet.`);
      return redirectAfterPost(res, returnTo);
    } catch (error) {
      console.error("[HeartPet] Einladungs-Mail fehlgeschlagen:", error.message);
      createNotificationLog({
        userId: req.session.user?.id,
        channel: "email",
        type: "invite",
        recipient: email,
        subject: "Benutzer-Einladung",
        status: "error",
        error: error.message,
        details: { target_user_id: userResult.lastInsertRowid },
      });
      setFlash(req, "error", `Benutzer angelegt, Einladungs-Mail an ${email} fehlgeschlagen: ${error.message}`);
      return redirectAfterPost(res, returnTo);
    }
  }

  setFlash(req, "success", "Benutzer angelegt.");
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

app.post("/admin/password", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  if (String(req.body.new_password || "") !== String(req.body.new_password_confirm || "")) {
    setFlash(req, "error", "Die neuen Passwörter stimmen nicht überein.");
    return res.redirect("/admin/benutzer");
  }

  const currentUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
  if (!currentUser || !bcrypt.compareSync(req.body.current_password, currentUser.password_hash)) {
    setFlash(req, "error", "Aktuelles Passwort ist nicht korrekt.");
    return res.redirect("/admin/benutzer");
  }

  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .run(bcrypt.hashSync(req.body.new_password, 10), currentUser.id);

  req.session.user.mustChangePassword = false;
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
        name, species_id, sex, birth_date, intake_date, source, microchip_number, status,
        color, breed, weight_kg, veterinarian_id, notes, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const result = insertAnimal.run(
      animalData.name || "Importiertes Tier",
      species?.id || null,
      animalData.sex || "",
      animalData.birth_date || null,
      animalData.intake_date || null,
      animalData.source || "",
      animalData.microchip_number || "",
      animalData.status || "Aktiv",
      animalData.color || "",
      animalData.breed || "",
      animalData.weight_kg || null,
      null,
      animalData.notes || ""
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

app.get("/impressum", (req, res) => {
  renderInfoPage(res, "Impressum", getSettingsObject(db).imprint_text);
});

app.get("/datenschutz", (req, res) => {
  renderInfoPage(res, "Datenschutzerklärung", getSettingsObject(db).privacy_text);
});

app.get("/kontakt", (req, res) => {
  renderInfoPage(res, "Kontakt", getSettingsObject(db).contact_text);
});

app.get("/cookies", (req, res) => {
  renderInfoPage(res, "Cookie-Hinweise", getSettingsObject(db).cookies_text);
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

async function maybeSendDailyDigest() {
  const settings = getSettingsObject(db);
  if (settings.daily_digest_enabled !== "true") {
    return;
  }

  const timeRaw = String(settings.daily_digest_time || "07:30").trim();
  const [hourRaw, minuteRaw] = timeRaw.split(":");
  const hour = Math.max(0, Math.min(23, Number.parseInt(hourRaw || "7", 10) || 7));
  const minute = Math.max(0, Math.min(59, Number.parseInt(minuteRaw || "30", 10) || 30));
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
    WHERE completed_at IS NULL
      AND due_at < ?
      AND animals.status = 'Aktiv'
  `).get(now.format("YYYY-MM-DDTHH:mm")).count;
  const todayCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE completed_at IS NULL
      AND due_at >= ?
      AND due_at <= ?
      AND animals.status = 'Aktiv'
  `).get(`${today}T00:00`, `${today}T23:59`).count;
  const nextDaysCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reminders
    INNER JOIN animals ON animals.id = reminders.animal_id
    WHERE completed_at IS NULL
      AND due_at > ?
      AND due_at <= ?
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
      AND reminders.due_at <= ?
      AND animals.status = 'Aktiv'
    ORDER BY reminders.due_at ASC
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

  app.listen(port, "0.0.0.0", () => {
    console.log(`HeartPet läuft auf http://127.0.0.1:${port}`);
    console.log("Wenn dies eine neue Installation ist, starte mit /setup.");
  });
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
    return res.redirect(req.get("referer") || "/");
  }
  next();
}

function requireAnimalPermission(permissionKey) {
  return (req, res, next) => {
    const user = getCurrentUserRecord(req);
    if (!buildPermissions(user)[permissionKey]) {
      setFlash(req, "error", "Für diese Aktion fehlen die erforderlichen Rechte.");
      return res.redirect(req.get("referer") || "/");
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

function findAnimal(id) {
  return db.prepare(`
    SELECT
      animals.*,
      species.name AS species_name,
      veterinarians.id AS veterinarian_id_resolved,
      veterinarians.name AS veterinarian_name,
      veterinarians.street AS veterinarian_street,
      veterinarians.postal_code AS veterinarian_postal_code,
      veterinarians.city AS veterinarian_city,
      veterinarians.country AS veterinarian_country,
      veterinarians.email AS veterinarian_email,
      veterinarians.phone AS veterinarian_phone,
      species_vet.id AS species_veterinarian_id,
      species_vet.name AS species_veterinarian_name,
      species_vet.street AS species_veterinarian_street,
      species_vet.postal_code AS species_veterinarian_postal_code,
      species_vet.city AS species_veterinarian_city,
      species_vet.country AS species_veterinarian_country,
      species_vet.email AS species_veterinarian_email,
      species_vet.phone AS species_veterinarian_phone
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    LEFT JOIN veterinarians ON veterinarians.id = animals.veterinarian_id
    LEFT JOIN veterinarians AS species_vet ON species_vet.id = species.default_veterinarian_id
    WHERE animals.id = ?
  `).get(id);
}

function getAnimalRelatedData(animalId) {
  return {
    conditions: db.prepare("SELECT * FROM animal_conditions WHERE animal_id = ? ORDER BY created_at DESC").all(animalId),
    medications: db.prepare("SELECT * FROM animal_medications WHERE animal_id = ? ORDER BY created_at DESC").all(animalId),
    vaccinations: db.prepare("SELECT * FROM animal_vaccinations WHERE animal_id = ? ORDER BY next_due_date ASC").all(animalId),
    appointments: db.prepare(`
      SELECT animal_appointments.*, veterinarians.name AS veterinarian_name
      FROM animal_appointments
      LEFT JOIN veterinarians ON veterinarians.id = animal_appointments.veterinarian_id
      WHERE animal_appointments.animal_id = ?
      ORDER BY animal_appointments.appointment_at ASC
    `).all(animalId),
    feedings: db.prepare("SELECT * FROM animal_feedings WHERE animal_id = ? ORDER BY time_of_day ASC").all(animalId),
    notes: db.prepare("SELECT * FROM animal_notes WHERE animal_id = ? ORDER BY created_at DESC").all(animalId),
    reminders: db.prepare("SELECT * FROM reminders WHERE animal_id = ? ORDER BY due_at ASC").all(animalId),
    images: db.prepare("SELECT * FROM animal_images WHERE animal_id = ? ORDER BY created_at DESC").all(animalId),
    documents: db.prepare(`
      SELECT documents.*, document_categories.name AS category_name
      FROM documents
      LEFT JOIN document_categories ON document_categories.id = documents.category_id
      WHERE documents.animal_id = ?
      ORDER BY documents.uploaded_at DESC
    `).all(animalId),
  };
}

function buildAnimalDetailViewData(animalId, req) {
  const animal = findAnimal(animalId);
  if (!animal) {
    return null;
  }

  const related = getAnimalRelatedData(animalId);
  const categories = db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all();
  const documentFilter = {
    categoryId: req.query.documentCategory || "",
    fileType: req.query.documentType || "",
  };
  const editState = {
    type: req.query.editType || "",
    id: req.query.editId ? Number(req.query.editId) : null,
  };

  return {
    animal,
    related: {
      ...related,
      documents: filterDocuments(related.documents, documentFilter),
    },
    reminderBuckets: splitReminders(related.reminders),
    sourceReminderMap: buildReminderSourceMap(related.reminders),
    manualReminders: (related.reminders || []).filter((item) => !item.source_kind),
    editState,
    categories,
    documentFilter,
    missingRequiredCategories: getMissingRequiredCategories(categories, related.documents),
    timeline: buildAnimalTimeline(related),
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
  };
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
      if (reminder.completed_at) {
        acc.done.push(reminder);
      } else if (dayjs(reminder.due_at).isBefore(now)) {
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
    status: body.status || "Aktiv",
    color: body.color || "",
    breed: body.breed || "",
    weight_kg: body.weight_kg || null,
    veterinarian_id: selectedVeterinarianId || resolveDefaultVeterinarianId(speciesId),
    notes: body.notes || "",
  };
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

function normalizeVeterinarianPayload(source, prefix = "") {
  const get = (field) => String(source?.[`${prefix}${field}`] || "").trim();
  return {
    street: get("street"),
    postal_code: get("postal_code"),
    city: get("city"),
    country: get("country"),
    email: get("email"),
    phone: get("phone"),
    notes: get("notes"),
  };
}

function validateVeterinarianAddress(payload) {
  if (payload.street && payload.street.length < 3) {
    return "Straße/Hausnummer ist zu kurz.";
  }
  if (payload.street && !/^[A-Za-zÄÖÜäöüß0-9 .,\-\/]{3,120}$/.test(payload.street)) {
    return "Straße/Hausnummer enthält ungültige Zeichen.";
  }
  if (payload.postal_code && !/^[A-Za-z0-9 -]{3,12}$/.test(payload.postal_code)) {
    return "PLZ ist ungültig.";
  }
  if (payload.city && !/^[A-Za-zÄÖÜäöüß0-9 .'\-]{2,80}$/.test(payload.city)) {
    return "Ort ist ungültig.";
  }
  if (payload.country && !/^[A-Za-zÄÖÜäöüß .'\-]{2,80}$/.test(payload.country)) {
    return "Land ist ungültig.";
  }
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return "E-Mail ist ungültig.";
  }
  if (payload.phone && !/^[+0-9()\/.\-\s]{6,30}$/.test(payload.phone)) {
    return "Telefon ist ungültig.";
  }
  return "";
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  return dayjs(value).format("DD.MM.YYYY");
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return dayjs(value).format("DD.MM.YYYY HH:mm");
}

function getAnimalAge(dateString) {
  if (!dateString) {
    return "-";
  }
  const years = dayjs().diff(dayjs(dateString), "year");
  return `${years} Jahre`;
}

function getAnimalInitial(name) {
  if (!name) {
    return "?";
  }
  return String(name).trim().charAt(0).toUpperCase();
}

function getMissingRequiredCategories(categories, documents) {
  const presentCategoryIds = new Set(documents.map((item) => Number(item.category_id)).filter(Boolean));
  return categories.filter((category) => category.is_required && !presentCategoryIds.has(Number(category.id)));
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
      pageTitle: "Historie",
      workspaceTitle: "Historie",
      workspaceIntro: "Hier findest du vermittelte oder verkaufte Tiere als Bestandsverlauf.",
      totalLabel: "historische Tiere",
      allowedStatuses: ["Vermittelt", "Verkauft"],
      defaultStatus: "",
      allowStatusFilter: true,
    },
    resting: {
      key: "resting",
      pageTitle: "Ruhestätte",
      workspaceTitle: "Ruhestätte",
      workspaceIntro: "Hier bleiben verstorbene Tiere würdevoll dokumentiert und getrennt vom aktiven Bestand.",
      totalLabel: "Tiere in der Ruhestätte",
      allowedStatuses: ["Verstorben"],
      defaultStatus: "Verstorben",
      allowStatusFilter: false,
    },
  };

  return sectionMap[section] || sectionMap.active;
}

function isActiveAnimalStatus(status) {
  return String(status || "").trim() === "Aktiv";
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

function parseReminderBaseDate(value, defaultTime = "09:00") {
  if (!value) {
    return null;
  }

  if (String(value).includes("T")) {
    return dayjs(value);
  }

  return dayjs(`${value}T${defaultTime}`);
}

function getNotificationChannelDefaults() {
  const settings = getSettingsObject(db);
  return {
    channelEmail: settings.reminder_email_enabled === "true" ? 1 : 0,
    channelTelegram: settings.reminder_telegram_enabled === "true" ? 1 : 0,
  };
}

function buildGeneratedReminderRows({ animalId, sourceKind, sourceId, title, reminderType, baseDate, notes, leadDays, repeatCount }) {
  if (!baseDate || !baseDate.isValid()) {
    return [];
  }

  const channels = getNotificationChannelDefaults();
  const requestedCount = Math.max(parsePositiveInteger(repeatCount), 0);
  if (requestedCount === 0) {
    return [];
  }

  const lead = parsePositiveInteger(leadDays);
  const effectiveCount = lead === 0 ? 1 : Math.min(requestedCount, lead + 1);
  return Array.from({ length: effectiveCount }, (_, index) => {
    const offsetDays = lead - index;
    return {
      animal_id: animalId,
      title,
      reminder_type: reminderType,
      due_at: baseDate.subtract(offsetDays, "day").format("YYYY-MM-DDTHH:mm"),
      channel_email: channels.channelEmail,
      channel_telegram: channels.channelTelegram,
      repeat_interval_days: 0,
      notes: notes || "",
      source_kind: sourceKind,
      source_id: sourceId,
      source_index: index,
    };
  });
}

function replaceGeneratedReminders(sourceKind, sourceId, rows) {
  const tx = db.transaction(() => {
    const existingRows = db.prepare(`
      SELECT *
      FROM reminders
      WHERE source_kind = ? AND source_id = ?
      ORDER BY source_index ASC, id ASC
    `).all(sourceKind, sourceId);

    const existingByIndex = new Map(
      existingRows.map((item) => [Number(item.source_index || 0), item])
    );

    const keepIds = new Set();
    const updateReminder = db.prepare(`
      UPDATE reminders
      SET animal_id = ?, title = ?, reminder_type = ?, due_at = ?, channel_email = ?, channel_telegram = ?,
          repeat_interval_days = ?, notes = ?, completed_at = ?, last_notified_at = ?, last_delivery_status = ?,
          last_delivery_error = ?, source_kind = ?, source_id = ?, source_index = ?
      WHERE id = ?
    `);
    const insertReminder = db.prepare(`
      INSERT INTO reminders (
        animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
        last_delivery_status, last_delivery_error, source_kind, source_id, source_index
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?)
    `);
    rows.forEach((row) => {
      const sourceIndex = Number(row.source_index || 0);
      const existing = existingByIndex.get(sourceIndex);
      const preserveState = existing
        && String(existing.due_at || "") === String(row.due_at || "")
        && String(existing.title || "") === String(row.title || "")
        && String(existing.reminder_type || "") === String(row.reminder_type || "");

      if (existing) {
        updateReminder.run(
          row.animal_id,
          row.title,
          row.reminder_type,
          row.due_at,
          row.channel_email,
          row.channel_telegram,
          row.repeat_interval_days,
          row.notes,
          preserveState ? existing.completed_at || null : null,
          preserveState ? existing.last_notified_at || null : null,
          preserveState ? (existing.last_delivery_status || "pending") : "pending",
          preserveState ? (existing.last_delivery_error || "") : "",
          row.source_kind,
          row.source_id,
          sourceIndex,
          existing.id
        );
        keepIds.add(existing.id);
        return;
      }

      const result = insertReminder.run(
        row.animal_id,
        row.title,
        row.reminder_type,
        row.due_at,
        row.channel_email,
        row.channel_telegram,
        row.repeat_interval_days,
        row.notes,
        row.source_kind,
        row.source_id,
        sourceIndex
      );
      keepIds.add(result.lastInsertRowid);
    });

    const staleIds = existingRows
      .map((item) => item.id)
      .filter((id) => !keepIds.has(id));
    if (staleIds.length) {
      const placeholders = staleIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM reminders WHERE id IN (${placeholders})`).run(...staleIds);
    }
  });

  tx();
}

function deleteGeneratedReminders(sourceKind, sourceId) {
  db.prepare("DELETE FROM reminders WHERE source_kind = ? AND source_id = ?").run(sourceKind, sourceId);
}

function resolveReminderChannels(mode) {
  switch (String(mode || "none")) {
    case "defaults": {
      const defaults = getNotificationChannelDefaults();
      return {
        channelEmail: defaults.channelEmail,
        channelTelegram: defaults.channelTelegram,
      };
    }
    case "email":
      return { channelEmail: 1, channelTelegram: 0 };
    case "telegram":
      return { channelEmail: 0, channelTelegram: 1 };
    case "both":
      return { channelEmail: 1, channelTelegram: 1 };
    case "browser":
    default:
      return { channelEmail: 0, channelTelegram: 0 };
  }
}

function appendVeterinarianNote(noteValue, handledByVeterinarian, veterinarianId) {
  const notes = String(noteValue || "").trim();
  if (!handledByVeterinarian) {
    return notes;
  }

  const veterinarian = veterinarianId
    ? db.prepare("SELECT name FROM veterinarians WHERE id = ?").get(veterinarianId)
    : null;
  const prefix = veterinarian?.name
    ? `Durchgeführt durch Tierarzt: ${veterinarian.name}`
    : "Durchgeführt durch Tierarzt";

  if (!notes) {
    return prefix;
  }

  return `${prefix}\n${notes}`;
}

function createSupplementalEventReminders({ animalId, eventKind, title, notes, baseDate, channelMode, daysBefore, onEvent }) {
  if (!baseDate || !baseDate.isValid() || String(channelMode || "none") === "none") {
    return;
  }

  if (baseDate.isBefore(dayjs())) {
    return;
  }

  const reminderTypeMap = {
    medication: "Medikament",
    vaccination: "Impfung",
    appointment: "Arzttermin",
  };
  const reminderType = reminderTypeMap[eventKind] || "Ereignis";
  const channels = resolveReminderChannels(channelMode);
  const days = parsePositiveInteger(daysBefore);
  const dueMoments = [];

  if (days > 0) {
    dueMoments.push(baseDate.subtract(days, "day"));
  }
  if (String(onEvent || "") === "1" || !dueMoments.length) {
    dueMoments.push(baseDate);
  }

  const seen = new Set();
  const insert = db.prepare(`
    INSERT INTO reminders (
      animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
      last_delivery_status, last_delivery_error
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', '')
  `);

  dueMoments.forEach((moment) => {
    const dueAt = moment.format("YYYY-MM-DDTHH:mm");
    if (seen.has(dueAt)) {
      return;
    }
    seen.add(dueAt);
    insert.run(
      animalId,
      `${reminderType}: ${title}`,
      reminderType,
      dueAt,
      channels.channelEmail,
      channels.channelTelegram,
      notes || ""
    );
  });
}

function applyCompletionSideEffects(reminder) {
  if (!reminder || reminder.source_kind !== "vaccination" || !reminder.source_id) {
    return;
  }

  db.prepare(`
    UPDATE animal_vaccinations
    SET vaccination_date = ?
    WHERE id = ?
      AND vaccination_date IS NULL
  `).run(dayjs().format("YYYY-MM-DD"), reminder.source_id);
}

function syncMedicationReminders(animalId, medicationId) {
  const item = db.prepare("SELECT * FROM animal_medications WHERE id = ? AND animal_id = ?").get(medicationId, animalId);
  if (!item) {
    deleteGeneratedReminders("medication", medicationId);
    return;
  }

  if (!Number(item.reminder_enabled || 0)) {
    deleteGeneratedReminders("medication", medicationId);
    return;
  }

  const settings = getSettingsObject(db);
  const rows = buildGeneratedReminderRows({
    animalId,
    sourceKind: "medication",
    sourceId: item.id,
    title: `Medikamentengabe: ${item.name}`,
    reminderType: "Medikament",
    baseDate: parseReminderBaseDate(item.start_date, "08:00"),
    notes: [item.dosage ? `Dosis: ${item.dosage}` : "", item.schedule ? `Plan: ${item.schedule}` : "", item.notes || ""]
      .filter(Boolean)
      .join(" | "),
    leadDays: settings.medication_reminder_lead_days,
    repeatCount: settings.medication_reminder_repeat_count,
  });
  replaceGeneratedReminders("medication", item.id, rows);
}

function syncVaccinationReminders(animalId, vaccinationId) {
  const item = db.prepare("SELECT * FROM animal_vaccinations WHERE id = ? AND animal_id = ?").get(vaccinationId, animalId);
  if (!item) {
    deleteGeneratedReminders("vaccination", vaccinationId);
    return;
  }

  if (!Number(item.reminder_enabled || 0)) {
    deleteGeneratedReminders("vaccination", vaccinationId);
    return;
  }

  const settings = getSettingsObject(db);
  const rows = buildGeneratedReminderRows({
    animalId,
    sourceKind: "vaccination",
    sourceId: item.id,
    title: `Impftermin: ${item.name}`,
    reminderType: "Impfung",
    baseDate: parseReminderBaseDate(item.next_due_date, "09:00"),
    notes: item.notes || "",
    leadDays: settings.vaccination_reminder_lead_days,
    repeatCount: settings.vaccination_reminder_repeat_count,
  });
  replaceGeneratedReminders("vaccination", item.id, rows);
}

function syncAppointmentReminders(animalId, appointmentId) {
  const item = db.prepare(`
    SELECT animal_appointments.*, veterinarians.name AS veterinarian_name
    FROM animal_appointments
    LEFT JOIN veterinarians ON veterinarians.id = animal_appointments.veterinarian_id
    WHERE animal_appointments.id = ? AND animal_appointments.animal_id = ?
  `).get(appointmentId, animalId);
  if (!item) {
    deleteGeneratedReminders("appointment", appointmentId);
    return;
  }

  if (!Number(item.reminder_enabled || 0)) {
    deleteGeneratedReminders("appointment", appointmentId);
    return;
  }

  const settings = getSettingsObject(db);
  const locationLabel = item.location_mode === "vor_ort" ? "Tierarzt kommt vor Ort" : "Tier wird zur Praxis gebracht";
  const rows = buildGeneratedReminderRows({
    animalId,
    sourceKind: "appointment",
    sourceId: item.id,
    title: `Arzttermin: ${item.title}`,
    reminderType: "Arzttermin",
    baseDate: parseReminderBaseDate(item.appointment_at, "09:00"),
    notes: [locationLabel, item.location_text ? `Ort: ${item.location_text}` : "", item.veterinarian_name ? `Tierarzt: ${item.veterinarian_name}` : "", item.notes || ""]
      .filter(Boolean)
      .join(" | "),
    leadDays: settings.appointment_reminder_lead_days,
    repeatCount: settings.appointment_reminder_repeat_count,
  });
  replaceGeneratedReminders("appointment", item.id, rows);
}

function resyncAllGeneratedReminders() {
  db.prepare("SELECT id, animal_id FROM animal_medications").all().forEach((item) => syncMedicationReminders(item.animal_id, item.id));
  db.prepare("SELECT id, animal_id FROM animal_vaccinations").all().forEach((item) => syncVaccinationReminders(item.animal_id, item.id));
  db.prepare("SELECT id, animal_id FROM animal_appointments").all().forEach((item) => syncAppointmentReminders(item.animal_id, item.id));
}

function getRoleLabel(role) {
  const labels = {
    admin: "Administrator",
    user: "Benutzer",
    viewer: "Nur Lesen",
  };
  return labels[role] || role;
}

function buildPermissions(user) {
  const role = user?.role || "viewer";
  if (role === "admin") {
    return {
      isAdmin: true,
      canManageAdmin: true,
      canEditAnimals: true,
      canManageDocuments: true,
      canManageGallery: true,
      canManageHealth: true,
      canManageFeedings: true,
      canManageNotes: true,
      canManageReminders: true,
    };
  }

  if (role === "viewer") {
    return {
      isAdmin: false,
      canManageAdmin: false,
      canEditAnimals: false,
      canManageDocuments: false,
      canManageGallery: false,
      canManageHealth: false,
      canManageFeedings: false,
      canManageNotes: false,
      canManageReminders: false,
    };
  }

  return {
    isAdmin: false,
    canManageAdmin: false,
    canEditAnimals: Boolean(user?.can_edit_animals),
    canManageDocuments: Boolean(user?.can_manage_documents),
    canManageGallery: Boolean(user?.can_manage_gallery),
    canManageHealth: Boolean(user?.can_manage_health),
    canManageFeedings: Boolean(user?.can_manage_feedings),
    canManageNotes: Boolean(user?.can_manage_notes),
    canManageReminders: Boolean(user?.can_manage_reminders),
  };
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
  const legalResponsibleName = String(settings?.legal_responsible_name || "").trim();
  const legalContentResponsibleName = String(settings?.legal_content_responsible_name || "").trim();
  const responsibleName = legalResponsibleName || organizationName;
  const contentResponsibleName = legalContentResponsibleName || responsibleName;
  const legalEmail = normalizeSettingsInputValue("legal_contact_email", settings?.legal_contact_email);
  const legalStreet = normalizeSettingsInputValue("legal_contact_street", settings?.legal_contact_street);
  const legalPostalCity = normalizeSettingsInputValue("legal_contact_postal_city", settings?.legal_contact_postal_city);
  const legalCountry = normalizeSettingsInputValue("legal_contact_country", settings?.legal_contact_country);
  const legalPhone = normalizeSettingsInputValue("legal_contact_phone", settings?.legal_contact_phone);
  const legalAddress = [legalStreet, legalPostalCity, legalCountry].filter(Boolean).join("\n");

  let result = String(content || "");

  if (responsibleName) {
    result = result
      .replace(/\[Name der verantwortlichen Person oder Organisation\]/g, responsibleName)
      .replace(/\[Name \/ Organisation\]/g, responsibleName)
      .replace(/Name \/ Organisation:\s*\[Bitte eintragen\]/g, `Name / Organisation: ${responsibleName}`);
  }

  if (contentResponsibleName) {
    result = result.replace(/\[Name der verantwortlichen Person\]/g, contentResponsibleName);
  }

  if (legalEmail) {
    result = result
      .replace(/\[recht@beispiel\.de\]/g, legalEmail)
      .replace(/\[kontakt@beispiel\.de\]/g, legalEmail);
  }

  if (legalStreet) {
    result = result.replace(/\[Straße und Hausnummer\]/g, legalStreet);
  }

  if (legalPostalCity) {
    result = result.replace(/\[PLZ Ort\]/g, legalPostalCity);
  }

  if (legalCountry) {
    result = result.replace(/\[Land\]/g, legalCountry);
  }

  if (legalPhone) {
    result = result
      .replace(/\[Telefonnummer optional\]/g, legalPhone)
      .replace(/\[optional\]/g, legalPhone);
  }

  if (legalAddress) {
    result = result
      .replace(/\[Anschrift\]/g, legalAddress)
      .replace(/\[Anschrift, falls abweichend\]/g, legalAddress);
  }

  return result;
}

function normalizeSettingsInputValue(key, value) {
  const normalizedValue = String(value || "").trim();
  const placeholderValues = {
    legal_contact_street: "[Straße und Hausnummer]",
    legal_contact_postal_city: "[PLZ Ort]",
    legal_contact_country: "[Land]",
    legal_contact_phone: "[Telefonnummer optional]",
    legal_contact_email: "[recht@beispiel.de]",
  };

  if (placeholderValues[key] && normalizedValue === placeholderValues[key]) {
    return "";
  }

  return normalizedValue;
}

function parseBooleanSettingValue(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function getAppLogoUrl(settings) {
  const storedName = String(settings?.app_logo_stored_name || "").trim();
  return storedName ? `/media/${storedName}` : "/static/images/logo-heartpet.png";
}

function getAppLogoFilePath(settings) {
  const storedName = String(settings?.app_logo_stored_name || "").trim();
  if (!storedName) {
    return path.join(__dirname, "..", "public", "images", "logo-heartpet.png");
  }
  return path.join(process.cwd(), "data", "uploads", storedName);
}

function safeDeleteUploadedFile(storedName, ignoreName = "") {
  const fileName = String(storedName || "").trim();
  if (!fileName || fileName === String(ignoreName || "").trim()) {
    return;
  }

  const fullPath = path.join(process.cwd(), "data", "uploads", fileName);
  if (fs.existsSync(fullPath)) {
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

  const uploadsDir = path.join(process.cwd(), "data", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const originalName = embeddedFile.original_name || embeddedFile.stored_name || "datei";
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const fullPath = path.join(uploadsDir, storedName);
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
    db.prepare("SELECT COUNT(*) AS count FROM documents WHERE stored_name = ?").get(storedName).count;

  if (referenceCount > 0) {
    return;
  }

  const fullPath = path.join(process.cwd(), "data", "uploads", storedName);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
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
    JSON.stringify(details || {})
  );
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

function buildAnimalTimeline(related) {
  const entries = [];

  (related.vaccinations || []).forEach((item) => {
    if (item.vaccination_date) {
      entries.push({
        at: `${item.vaccination_date}T09:00`,
        title: `Impfung durchgeführt: ${item.name}`,
        type: "Impfung",
        details: item.notes || "",
      });
    }
    if (item.next_due_date) {
      entries.push({
        at: `${item.next_due_date}T09:00`,
        title: `Impfung fällig: ${item.name}`,
        type: "Impfung",
        details: item.notes || "",
      });
    }
  });

  (related.medications || []).forEach((item) => {
    if (item.start_date) {
      entries.push({
        at: `${item.start_date}T08:00`,
        title: `Medikation gestartet: ${item.name}`,
        type: "Medikament",
        details: [item.dosage ? `Dosis: ${item.dosage}` : "", item.notes || ""].filter(Boolean).join(" | "),
      });
    }
    if (item.end_date) {
      entries.push({
        at: `${item.end_date}T18:00`,
        title: `Medikation Ende: ${item.name}`,
        type: "Medikament",
        details: item.notes || "",
      });
    }
  });

  (related.appointments || []).forEach((item) => {
    entries.push({
      at: item.appointment_at,
      title: `Arzttermin: ${item.title}`,
      type: "Arzttermin",
      details: [item.veterinarian_name ? `Tierarzt: ${item.veterinarian_name}` : "", item.location_text ? `Ort: ${item.location_text}` : "", item.notes || ""]
        .filter(Boolean)
        .join(" | "),
    });
  });

  (related.reminders || []).forEach((item) => {
    entries.push({
      at: item.due_at,
      title: `${item.completed_at ? "Erledigt" : "Erinnerung"}: ${item.title}`,
      type: item.reminder_type || "Erinnerung",
      details: item.notes || "",
    });
  });

  (related.notes || []).forEach((item) => {
    entries.push({
      at: item.created_at,
      title: `Protokoll: ${item.title}`,
      type: "Protokoll",
      details: item.content || "",
    });
  });

  return entries
    .filter((item) => item.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 120);
}

function getAdminViewData(pageTitle, adminPath) {
  const settings = getSettingsObject(db);
  const lastSuccessfulEmailCheck = getLastSuccessfulNotificationCheck("email", ["test", "smtp_connection_check"]);
  const lastSuccessfulTelegramCheck = getLastSuccessfulNotificationCheck("telegram", ["test"]);
  return {
    pageTitle: `Admin · ${pageTitle}`,
    adminPageTitle: pageTitle,
    adminPath,
    settings,
    instanceTimezone: getInstanceTimeZone(),
    communicationStatus: {
      emailReady: isEmailConfigured(settings),
      telegramReady: isTelegramConfigured(settings),
      emailLastSuccessfulCheckAt: lastSuccessfulEmailCheck?.created_at || "",
      telegramLastSuccessfulCheckAt: lastSuccessfulTelegramCheck?.created_at || "",
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
    users: db.prepare(`
      SELECT
        id, name, email, role, must_change_password, created_at,
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

module.exports = app;
