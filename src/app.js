const fs = require("fs");
const path = require("path");
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
  sendTestEmail,
  sendTestTelegram,
  isEmailEnabled,
  isTelegramEnabled,
} = require("./reminders");
const { buildAnimalExportPayload, createAnimalPdf } = require("./exporters");

const SQLiteStore = SQLiteStoreFactory(session);
const app = express();
const db = initDatabase();

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const targetDir = path.join(process.cwd(), "data", "uploads");
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
app.set("views", path.join(process.cwd(), "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/static", express.static(path.join(process.cwd(), "public")));
app.use("/media", express.static(path.join(process.cwd(), "data", "uploads")));

app.use(
  session({
    secret: process.env.HEARTPET_SESSION_SECRET || "heartpet-session-secret",
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({
      db: "sessions.sqlite",
      dir: path.join(process.cwd(), "data"),
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
  res.locals.currentPath = req.path;
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.getAnimalAge = getAnimalAge;
  res.locals.getAnimalInitial = getAnimalInitial;
  res.locals.getRoleLabel = getRoleLabel;
  res.locals.permissions = buildPermissions(currentUserRecord || req.session.user);
  res.locals.editState = { type: "", id: null };
  res.locals.reminderBuckets = { overdue: [], open: [], done: [] };
  next();
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }

  res.render("pages/login", { pageTitle: "Login" });
});

app.post("/login", (req, res) => {
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
  res.redirect("/");
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.use(requireAuth);

app.get("/", (req, res) => {
  const stats = {
    animalCount: db.prepare("SELECT COUNT(*) AS count FROM animals").get().count,
    documentCount: db.prepare("SELECT COUNT(*) AS count FROM documents").get().count,
    openReminderCount: db.prepare("SELECT COUNT(*) AS count FROM reminders WHERE completed_at IS NULL").get().count,
    dueReminderCount: db
      .prepare("SELECT COUNT(*) AS count FROM reminders WHERE completed_at IS NULL AND due_at <= ?")
      .get(dayjs().format("YYYY-MM-DDTHH:mm")).count,
  };

  const recentAnimals = db.prepare(`
    SELECT animals.*, species.name AS species_name
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    ORDER BY animals.created_at DESC
    LIMIT 6
  `).all();

  const upcomingReminders = db.prepare(`
    SELECT reminders.*, animals.name AS animal_name
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
    ORDER BY reminders.due_at ASC
    LIMIT 10
  `).all();

  res.render("pages/dashboard", {
    pageTitle: "Dashboard",
    stats,
    recentAnimals,
    upcomingReminders,
  });
});

app.get("/animals", (req, res) => {
  const search = (req.query.q || "").trim();
  const status = (req.query.status || "").trim();
  const speciesId = (req.query.species_id || "").trim();
  const sort = (req.query.sort || "name_asc").trim();
  const page = Math.max(Number.parseInt(req.query.page || "1", 10) || 1, 1);
  const pageSize = 25;

  let sqlBase = `
    FROM animals
    LEFT JOIN species ON species.id = animals.species_id
    LEFT JOIN veterinarians ON veterinarians.id = animals.veterinarian_id
    WHERE 1 = 1
  `;
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
    sqlBase += ` AND animals.status = ?`;
    params.push(status);
  }

  if (speciesId) {
    sql += ` AND animals.species_id = ?`;
    sqlBase += ` AND animals.species_id = ?`;
    params.push(speciesId);
  }

  const orderByMap = {
    name_asc: "animals.name COLLATE NOCASE ASC",
    name_desc: "animals.name COLLATE NOCASE DESC",
    intake_desc: "animals.intake_date DESC, animals.name COLLATE NOCASE ASC",
    intake_asc: "animals.intake_date ASC, animals.name COLLATE NOCASE ASC",
    created_desc: "animals.created_at DESC",
    status_asc: "animals.status COLLATE NOCASE ASC, animals.name COLLATE NOCASE ASC",
  };
  const orderBy = orderByMap[sort] || orderByMap.name_asc;
  sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

  const totalCount = db.prepare(`SELECT COUNT(*) AS count ${sqlBase}`).get(...params).count;
  const totalPages = Math.max(Math.ceil(totalCount / pageSize), 1);
  const currentPage = Math.min(page, totalPages);
  const animals = db.prepare(sql).all(...params, pageSize, (currentPage - 1) * pageSize);

  res.render("pages/animals-index", {
    pageTitle: "Tiere",
    animals,
    filters: { search, status, speciesId, sort },
    speciesOptions: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    pagination: {
      currentPage,
      totalPages,
      totalCount,
      pageSize,
    },
  });
});

app.get("/animals/new", requireAnimalEditor, (req, res) => {
  res.render("pages/animal-form", {
    pageTitle: "Tier anlegen",
    animal: null,
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
  });
});

app.post("/animals", requireAnimalEditor, (req, res) => {
  const payload = normalizeAnimalPayload(req.body);
  if (!payload.name || !payload.species_id) {
    setFlash(req, "error", "Name und Tierart sind Pflichtfelder.");
    return res.redirect("/animals/new");
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

  setFlash(req, "success", "Tier wurde angelegt.");
  res.redirect(`/animals/${result.lastInsertRowid}`);
});

app.get("/animals/:id", (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  const related = getAnimalRelatedData(req.params.id);
  const categories = db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all();
  const documentFilter = {
    categoryId: req.query.documentCategory || "",
    fileType: req.query.documentType || "",
  };
  const editState = {
    type: req.query.editType || "",
    id: req.query.editId ? Number(req.query.editId) : null,
  };

  res.render("pages/animal-show", {
    pageTitle: animal.name,
    animal,
    related: {
      ...related,
      documents: filterDocuments(related.documents, documentFilter),
    },
    reminderBuckets: splitReminders(related.reminders),
    editState,
    categories,
    documentFilter,
    missingRequiredCategories: getMissingRequiredCategories(categories, related.documents),
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
  });
});

app.get("/animals/:id/edit", requireAnimalEditor, (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  res.render("pages/animal-form", {
    pageTitle: `${animal.name} bearbeiten`,
    animal,
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
  });
});

app.post("/animals/:id/update", requireAnimalEditor, (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  const payload = normalizeAnimalPayload(req.body);
  if (!payload.name || !payload.species_id) {
    setFlash(req, "error", "Name und Tierart sind Pflichtfelder.");
    return res.redirect(`/animals/${req.params.id}/edit`);
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

  setFlash(req, "success", "Tierdaten wurden aktualisiert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:id/conditions", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)")
    .run(req.params.id, req.body.title, req.body.details || "");
  setFlash(req, "success", "Vorerkrankung gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:animalId/conditions/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare(`
    UPDATE animal_conditions
    SET title = ?, details = ?
    WHERE id = ? AND animal_id = ?
  `).run(req.body.title, req.body.details || "", req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Vorerkrankung aktualisiert.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:animalId/conditions/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare("DELETE FROM animal_conditions WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Vorerkrankung gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/medications", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare(`
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
  setFlash(req, "success", "Medikation gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:animalId/medications/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
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
  setFlash(req, "success", "Medikation aktualisiert.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:animalId/medications/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare("DELETE FROM animal_medications WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Medikation gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/vaccinations", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare(`
    INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.name,
    req.body.vaccination_date || null,
    req.body.next_due_date || null,
    req.body.notes || ""
  );
  setFlash(req, "success", "Impfung gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:animalId/vaccinations/:entryId/update", requireAnimalPermission("canManageHealth"), (req, res) => {
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
  setFlash(req, "success", "Impfung aktualisiert.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:animalId/vaccinations/:entryId/delete", requireAnimalPermission("canManageHealth"), (req, res) => {
  db.prepare("DELETE FROM animal_vaccinations WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Impfung gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/feedings", requireAnimalPermission("canManageFeedings"), (req, res) => {
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
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:animalId/feedings/:entryId/update", requireAnimalPermission("canManageFeedings"), (req, res) => {
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
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:animalId/feedings/:entryId/delete", requireAnimalPermission("canManageFeedings"), (req, res) => {
  db.prepare("DELETE FROM animal_feedings WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Fütterungsplan gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/notes", requireAnimalPermission("canManageNotes"), (req, res) => {
  db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
    .run(req.params.id, req.body.title, req.body.content);
  setFlash(req, "success", "Protokolleintrag gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:animalId/notes/:entryId/update", requireAnimalPermission("canManageNotes"), (req, res) => {
  db.prepare(`
    UPDATE animal_notes
    SET title = ?, content = ?
    WHERE id = ? AND animal_id = ?
  `).run(req.body.title, req.body.content, req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Protokolleintrag aktualisiert.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:animalId/notes/:entryId/delete", requireAnimalPermission("canManageNotes"), (req, res) => {
  db.prepare("DELETE FROM animal_notes WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Protokolleintrag gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:id/reminders", requireAnimalPermission("canManageReminders"), (req, res) => {
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
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:animalId/reminders/:entryId/update", requireAnimalPermission("canManageReminders"), (req, res) => {
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
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/animals/:animalId/reminders/:entryId/delete", requireAnimalPermission("canManageReminders"), (req, res) => {
  db.prepare("DELETE FROM reminders WHERE id = ? AND animal_id = ?").run(req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Erinnerung gelöscht.");
  res.redirect(`/animals/${req.params.animalId}`);
});

app.post("/reminders/:id/complete", requireAnimalPermission("canManageReminders"), (req, res) => {
  const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(req.params.id);
  if (!reminder) {
    return renderNotFound(req, res, "Erinnerung nicht gefunden.");
  }

  if (Number(reminder.repeat_interval_days || 0) > 0) {
    db.prepare(`
      UPDATE reminders
      SET due_at = ?, completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
      WHERE id = ?
    `).run(dayjs(reminder.due_at).add(Number(reminder.repeat_interval_days), "day").format("YYYY-MM-DDTHH:mm"), reminder.id);
    setFlash(req, "success", "Wiederkehrende Erinnerung abgeschlossen und neu terminiert.");
  } else {
    db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    setFlash(req, "success", "Erinnerung als erledigt markiert.");
  }
  res.redirect(req.get("referer") || "/");
});

app.post("/reminders/:id/reopen", requireAnimalPermission("canManageReminders"), (req, res) => {
  db.prepare(`
    UPDATE reminders
    SET completed_at = NULL, last_notified_at = NULL, last_delivery_status = 'pending', last_delivery_error = ''
    WHERE id = ?
  `).run(req.params.id);
  setFlash(req, "success", "Erinnerung wieder geöffnet.");
  res.redirect(req.get("referer") || "/");
});

app.post("/animals/:id/documents", requireAnimalPermission("canManageDocuments"), upload.single("document"), (req, res) => {
  if (!req.file) {
    setFlash(req, "error", "Bitte wähle eine Datei aus.");
    return res.redirect(`/animals/${req.params.id}`);
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
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:animalId/documents/:entryId/update", requireAnimalPermission("canManageDocuments"), (req, res) => {
  db.prepare(`
    UPDATE documents
    SET title = ?, category_id = ?
    WHERE id = ? AND animal_id = ?
  `).run(req.body.title, req.body.category_id || null, req.params.entryId, req.params.animalId);
  setFlash(req, "success", "Dokument aktualisiert.");
  res.redirect(`/animals/${req.params.animalId}`);
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

  db.prepare(`
    UPDATE animals
    SET profile_image_stored_name = ?,
        profile_image_original_name = ?,
        profile_image_mime_type = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.file.filename, req.file.originalname, req.file.mimetype, req.params.id);

  setFlash(req, "success", "Profilbild gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:id/images", requireAnimalPermission("canManageGallery"), upload.single("image"), (req, res) => {
  if (!req.file) {
    setFlash(req, "error", "Bitte ein Bild auswählen.");
    return res.redirect(`/animals/${req.params.id}`);
  }

  if (!String(req.file.mimetype || "").startsWith("image/")) {
    fs.unlinkSync(req.file.path);
    setFlash(req, "error", "Es können nur Bilddateien hochgeladen werden.");
    return res.redirect(`/animals/${req.params.id}`);
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
  res.redirect(`/animals/${req.params.id}`);
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

app.get("/animals/:id/export/pdf", (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  createAnimalPdf(res, animal, getAnimalRelatedData(req.params.id));
});

app.get("/admin", requireAdmin, (req, res) => {
  res.redirect("/admin/allgemein");
});

app.get("/admin/allgemein", requireAdmin, (req, res) => {
  res.render("pages/admin-general", getAdminViewData("Allgemein", "/admin/allgemein"));
});

app.get("/admin/kommunikation", requireAdmin, (req, res) => {
  res.render("pages/admin-communication", getAdminViewData("Kommunikation", "/admin/kommunikation"));
});

app.get("/admin/stammdaten", requireAdmin, (req, res) => {
  res.render("pages/admin-masterdata", getAdminViewData("Stammdaten", "/admin/stammdaten"));
});

app.get("/admin/benutzer", requireAdmin, (req, res) => {
  res.render("pages/admin-users", getAdminViewData("Benutzer", "/admin/benutzer"));
});

app.get("/admin/import", requireAdmin, (req, res) => {
  res.render("pages/admin-import", getAdminViewData("Import", "/admin/import"));
});

app.post("/admin/settings", requireAdmin, (req, res) => {
  const booleanKeys = new Set([
    "smtp_secure",
    "reminder_email_enabled",
    "reminder_telegram_enabled",
    "browser_notifications_enabled",
  ]);
  const fields = String(req.body._fields || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  fields.forEach((key) => {
    if (booleanKeys.has(key)) {
      upsertSetting(db, key, req.body[key] ? "true" : "false");
      return;
    }

    upsertSetting(db, key, req.body[key] || "");
  });

  setFlash(req, "success", "Einstellungen gespeichert.");
  res.redirect(backTo(req, "/admin/allgemein"));
});

app.post("/admin/test-email", requireAdmin, async (req, res) => {
  try {
    await sendTestEmail(getSettingsObject(db));
    setFlash(req, "success", "SMTP-Testmail wurde versendet.");
  } catch (error) {
    setFlash(req, "error", `SMTP-Test fehlgeschlagen: ${error.message}`);
  }

  res.redirect("/admin/kommunikation");
});

app.post("/admin/test-telegram", requireAdmin, async (req, res) => {
  try {
    await sendTestTelegram(getSettingsObject(db));
    setFlash(req, "success", "Telegram-Testnachricht wurde versendet.");
  } catch (error) {
    setFlash(req, "error", `Telegram-Test fehlgeschlagen: ${error.message}`);
  }

  res.redirect("/admin/kommunikation");
});

app.post("/admin/categories", requireAdmin, (req, res) => {
  db.prepare("INSERT INTO document_categories (name, is_required) VALUES (?, ?)")
    .run(req.body.name, req.body.is_required ? 1 : 0);
  setFlash(req, "success", "Dokumentkategorie angelegt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/categories/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM document_categories WHERE id = ?").run(req.params.id);
  setFlash(req, "success", "Dokumentkategorie entfernt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/species", requireAdmin, (req, res) => {
  db.prepare("INSERT INTO species (name, default_veterinarian_id, notes) VALUES (?, ?, ?)")
    .run(req.body.name, req.body.default_veterinarian_id || null, req.body.notes || "");
  setFlash(req, "success", "Tierart angelegt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/species/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM species WHERE id = ?").run(req.params.id);
  setFlash(req, "success", "Tierart entfernt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/veterinarians", requireAdmin, (req, res) => {
  db.prepare(`
    INSERT INTO veterinarians (name, email, phone, notes)
    VALUES (?, ?, ?, ?)
  `).run(req.body.name, req.body.email || "", req.body.phone || "", req.body.notes || "");
  setFlash(req, "success", "Tierarzt gespeichert.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/veterinarians/:id/delete", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM veterinarians WHERE id = ?").run(req.params.id);
  setFlash(req, "success", "Tierarzt entfernt.");
  res.redirect(backTo(req, "/admin/stammdaten"));
});

app.post("/admin/users", requireAdmin, (req, res) => {
  const passwordHash = bcrypt.hashSync(req.body.password, 10);
  const userPermissions = normalizeUserPermissions(req.body.role, req.body);
  db.prepare(`
    INSERT INTO users (
      name, email, password_hash, role, must_change_password,
      can_edit_animals, can_manage_documents, can_manage_gallery, can_manage_health,
      can_manage_feedings, can_manage_notes, can_manage_reminders
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.body.name,
    req.body.email,
    passwordHash,
    req.body.role || "viewer",
    1,
    userPermissions.can_edit_animals,
    userPermissions.can_manage_documents,
    userPermissions.can_manage_gallery,
    userPermissions.can_manage_health,
    userPermissions.can_manage_feedings,
    userPermissions.can_manage_notes,
    userPermissions.can_manage_reminders
  );

  setFlash(req, "success", "Benutzer angelegt.");
  res.redirect(backTo(req, "/admin/benutzer"));
});

app.post("/admin/users/:id/permissions", requireAdmin, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) {
    return renderNotFound(req, res, "Benutzer nicht gefunden.");
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

  setFlash(req, "success", "Benutzerrechte aktualisiert.");
  res.redirect("/admin/benutzer");
});

app.post("/admin/password", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  const currentUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
  if (!currentUser || !bcrypt.compareSync(req.body.current_password, currentUser.password_hash)) {
    setFlash(req, "error", "Aktuelles Passwort ist nicht korrekt.");
    return res.redirect("/admin/benutzer");
  }

  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .run(bcrypt.hashSync(req.body.new_password, 10), currentUser.id);

  req.session.user.mustChangePassword = false;
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
      (related.conditions || []).forEach((item) => {
        db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)")
          .run(animalId, item.title, item.details || "");
      });
      (related.medications || []).forEach((item) => {
        db.prepare(`
          INSERT INTO animal_medications (animal_id, name, dosage, schedule, start_date, end_date, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(animalId, item.name, item.dosage || "", item.schedule || "", item.start_date || null, item.end_date || null, item.notes || "");
      });
      (related.vaccinations || []).forEach((item) => {
        db.prepare(`
          INSERT INTO animal_vaccinations (animal_id, name, vaccination_date, next_due_date, notes)
          VALUES (?, ?, ?, ?, ?)
        `).run(animalId, item.name, item.vaccination_date || null, item.next_due_date || null, item.notes || "");
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
      (related.reminders || []).forEach((item) => {
        db.prepare(`
          INSERT INTO reminders (
            animal_id, title, reminder_type, due_at, channel_email, channel_telegram, repeat_interval_days, notes,
            completed_at, last_notified_at, last_delivery_status, last_delivery_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          item.last_delivery_error || ""
        );
      });
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

app.get("/api/reminders/pending", (req, res) => {
  const rows = db.prepare(`
    SELECT reminders.id, reminders.title, reminders.due_at, animals.name AS animal_name
    FROM reminders
    LEFT JOIN animals ON animals.id = reminders.animal_id
    WHERE reminders.completed_at IS NULL
      AND reminders.due_at <= ?
    ORDER BY reminders.due_at ASC
    LIMIT 5
  `).all(dayjs().format("YYYY-MM-DDTHH:mm"));

  res.json({ count: rows.length, reminders: rows });
});

app.use((req, res) => {
  renderNotFound(req, res, "Seite nicht gefunden.");
});

cron.schedule("*/10 * * * *", async () => {
  try {
    await processDueReminders(db, getSettingsObject(db));
  } catch (error) {
    console.error("[HeartPet] Fehler im Erinnerungsdienst:", error.message);
  }
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`HeartPet läuft auf http://127.0.0.1:${port}`);
    console.log("Standard-Login: admin@heartpet.local / admin123!");
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    setFlash(req, "error", "Dieser Bereich ist nur für Administratoren verfügbar.");
    return res.redirect("/");
  }
  next();
}

function requireAnimalEditor(req, res, next) {
  const user = req.session.user ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id) : null;
  if (!buildPermissions(user).canEditAnimals) {
    setFlash(req, "error", "Für diese Aktion fehlen die erforderlichen Rechte.");
    return res.redirect(req.get("referer") || "/");
  }
  next();
}

function requireAnimalPermission(permissionKey) {
  return (req, res, next) => {
    const user = req.session.user ? db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id) : null;
    if (!buildPermissions(user)[permissionKey]) {
      setFlash(req, "error", "Für diese Aktion fehlen die erforderlichen Rechte.");
      return res.redirect(req.get("referer") || "/");
    }
    next();
  };
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function findAnimal(id) {
  return db.prepare(`
    SELECT
      animals.*,
      species.name AS species_name,
      veterinarians.name AS veterinarian_name,
      species_vet.name AS species_veterinarian_name
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
  return {
    name: String(body.name || "").trim(),
    species_id: speciesName ? ensureSpeciesExists(speciesName).id : null,
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
    veterinarian_id: body.veterinarian_id || null,
    notes: body.notes || "",
  };
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
  res.render("pages/info-page", {
    pageTitle: title,
    content: content || "",
  });
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

function getAdminViewData(pageTitle, adminPath) {
  const settings = getSettingsObject(db);
  return {
    pageTitle: `Admin · ${pageTitle}`,
    adminPageTitle: pageTitle,
    adminPath,
    settings,
    communicationStatus: {
      emailReady: isEmailEnabled(settings),
      telegramReady: isTelegramEnabled(settings),
    },
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

module.exports = app;
