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
const { processDueReminders } = require("./reminders");
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

app.use(
  session({
    secret: "heartpet-session-secret",
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

  res.locals.flash = flash;
  res.locals.currentUser = req.session.user || null;
  res.locals.appSettings = getSettingsObject(db);
  res.locals.currentPath = req.path;
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.getAnimalAge = getAnimalAge;
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
  }

  sql += ` ORDER BY animals.name COLLATE NOCASE ASC`;

  const animals = db.prepare(sql).all(...params);

  res.render("pages/animals-index", {
    pageTitle: "Tiere",
    animals,
    filters: { search, status },
  });
});

app.get("/animals/new", (req, res) => {
  res.render("pages/animal-form", {
    pageTitle: "Tier anlegen",
    animal: null,
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
  });
});

app.post("/animals", (req, res) => {
  const payload = normalizeAnimalPayload(req.body);

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

  res.render("pages/animal-show", {
    pageTitle: animal.name,
    animal,
    related,
    categories: db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all(),
    species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
  });
});

app.get("/animals/:id/edit", (req, res) => {
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

app.post("/animals/:id/update", (req, res) => {
  const animal = findAnimal(req.params.id);
  if (!animal) {
    return renderNotFound(req, res, "Tier nicht gefunden.");
  }

  const payload = normalizeAnimalPayload(req.body);
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

app.post("/animals/:id/conditions", (req, res) => {
  db.prepare("INSERT INTO animal_conditions (animal_id, title, details) VALUES (?, ?, ?)")
    .run(req.params.id, req.body.title, req.body.details || "");
  setFlash(req, "success", "Vorerkrankung gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:id/medications", (req, res) => {
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

app.post("/animals/:id/vaccinations", (req, res) => {
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

app.post("/animals/:id/feedings", (req, res) => {
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

app.post("/animals/:id/notes", (req, res) => {
  db.prepare("INSERT INTO animal_notes (animal_id, title, content) VALUES (?, ?, ?)")
    .run(req.params.id, req.body.title, req.body.content);
  setFlash(req, "success", "Protokolleintrag gespeichert.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/animals/:id/reminders", (req, res) => {
  db.prepare(`
    INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    req.body.title,
    req.body.reminder_type || "Allgemein",
    req.body.due_at,
    req.body.channel_email ? 1 : 0,
    req.body.channel_telegram ? 1 : 0,
    req.body.notes || ""
  );
  setFlash(req, "success", "Erinnerung angelegt.");
  res.redirect(`/animals/${req.params.id}`);
});

app.post("/reminders/:id/complete", (req, res) => {
  db.prepare("UPDATE reminders SET completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  setFlash(req, "success", "Erinnerung als erledigt markiert.");
  res.redirect(req.get("referer") || "/");
});

app.post("/animals/:id/documents", upload.single("document"), (req, res) => {
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

  const payload = buildAnimalExportPayload(animal, getAnimalRelatedData(req.params.id));
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

app.post("/admin/categories", requireAdmin, (req, res) => {
  db.prepare("INSERT INTO document_categories (name) VALUES (?)").run(req.body.name);
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
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role, must_change_password)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.body.name, req.body.email, passwordHash, req.body.role || "viewer", 1);

  setFlash(req, "success", "Benutzer angelegt.");
  res.redirect(backTo(req, "/admin/benutzer"));
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
      (related.reminders || []).forEach((item) => {
        db.prepare(`
          INSERT INTO reminders (animal_id, title, reminder_type, due_at, channel_email, channel_telegram, notes, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          animalId,
          item.title,
          item.reminder_type || "Allgemein",
          item.due_at,
          item.channel_email || 0,
          item.channel_telegram || 0,
          item.notes || "",
          item.completed_at || null
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
    documents: db.prepare(`
      SELECT documents.*, document_categories.name AS category_name
      FROM documents
      LEFT JOIN document_categories ON document_categories.id = documents.category_id
      WHERE documents.animal_id = ?
      ORDER BY documents.uploaded_at DESC
    `).all(animalId),
  };
}

function normalizeAnimalPayload(body) {
  return {
    name: body.name,
    species_id: body.species_id || null,
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

function renderNotFound(req, res, message) {
  res.status(404).render("pages/not-found", {
    pageTitle: "Nicht gefunden",
    message,
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

function getAdminViewData(pageTitle, adminPath) {
  return {
    pageTitle: `Admin · ${pageTitle}`,
    adminPageTitle: pageTitle,
    adminPath,
    settings: getSettingsObject(db),
    categories: db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all(),
    species: db.prepare(`
      SELECT species.*, veterinarians.name AS veterinarian_name
      FROM species
      LEFT JOIN veterinarians ON veterinarians.id = species.default_veterinarian_id
      ORDER BY species.name ASC
    `).all(),
    veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
    users: db.prepare("SELECT id, name, email, role, must_change_password, created_at FROM users ORDER BY created_at ASC").all(),
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
