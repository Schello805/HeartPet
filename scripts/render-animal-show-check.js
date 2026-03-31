const ejs = require("ejs");
const path = require("path");
const dayjs = require("dayjs");

const { initDatabase, getSettingsObject } = require("../src/db");

const db = initDatabase();
const animalId = Number(process.argv[2] || 1);

const animal = db.prepare(`
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
`).get(animalId);

if (!animal) {
  console.error(`Tier ${animalId} wurde nicht gefunden.`);
  process.exit(1);
}

const related = {
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

const reminderBuckets = related.reminders.reduce(
  (acc, reminder) => {
    if (reminder.completed_at) {
      acc.done.push(reminder);
    } else if (dayjs(reminder.due_at).isBefore(dayjs())) {
      acc.overdue.push(reminder);
    } else {
      acc.open.push(reminder);
    }
    return acc;
  },
  { overdue: [], open: [], done: [] }
);

const locals = {
  pageTitle: animal.name,
  animal,
  related,
  reminderBuckets,
  editState: { type: "", id: null },
  documentFilter: { categoryId: "", fileType: "" },
  categories: db.prepare("SELECT * FROM document_categories ORDER BY name ASC").all(),
  missingRequiredCategories: [],
  species: db.prepare("SELECT * FROM species ORDER BY name ASC").all(),
  veterinarians: db.prepare("SELECT * FROM veterinarians ORDER BY name ASC").all(),
  appSettings: getSettingsObject(db),
  currentPath: `/animals/${animalId}`,
  currentUser: { name: "Administrator", role: "admin", mustChangePassword: true },
  permissions: {
    isAdmin: true,
    canManageAdmin: true,
    canEditAnimals: true,
    canManageReminders: true,
  },
  flash: null,
  formatDate(value) {
    return value ? dayjs(value).format("DD.MM.YYYY") : "-";
  },
  formatDateTime(value) {
    return value ? dayjs(value).format("DD.MM.YYYY HH:mm") : "-";
  },
  getAnimalAge(value) {
    return value ? `${dayjs().diff(dayjs(value), "year")} Jahre` : "-";
  },
  getAnimalInitial(value) {
    return value ? String(value).trim().charAt(0).toUpperCase() : "?";
  },
  getRoleLabel(value) {
    const labels = {
      admin: "Administrator",
      user: "Benutzer",
      viewer: "Nur Lesen",
    };
    return labels[value] || value;
  },
};

ejs.renderFile(path.join(process.cwd(), "views", "pages", "animal-show.ejs"), locals, {}, (error, html) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }

  console.log("render-ok");
  console.log(html.slice(0, 600));
});
