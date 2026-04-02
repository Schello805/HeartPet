module.exports = {
  id: "001_initial_schema",
  description: "Erzeugt das Basisschema aller HeartPet-Tabellen",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        must_change_password INTEGER NOT NULL DEFAULT 1,
        can_edit_animals INTEGER NOT NULL DEFAULT 1,
        can_manage_documents INTEGER NOT NULL DEFAULT 1,
        can_manage_gallery INTEGER NOT NULL DEFAULT 1,
        can_manage_health INTEGER NOT NULL DEFAULT 1,
        can_manage_feedings INTEGER NOT NULL DEFAULT 1,
        can_manage_notes INTEGER NOT NULL DEFAULT 1,
        can_manage_reminders INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS veterinarians (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        street TEXT,
        postal_code TEXT,
        city TEXT,
        country TEXT,
        email TEXT,
        phone TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS species (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        default_veterinarian_id INTEGER,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(default_veterinarian_id) REFERENCES veterinarians(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS animals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        species_id INTEGER,
        sex TEXT,
        birth_date TEXT,
        intake_date TEXT,
        source TEXT,
        microchip_number TEXT,
        status TEXT NOT NULL DEFAULT 'Aktiv',
        color TEXT,
        breed TEXT,
        weight_kg REAL,
        veterinarian_id INTEGER,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(species_id) REFERENCES species(id) ON DELETE SET NULL,
        FOREIGN KEY(veterinarian_id) REFERENCES veterinarians(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS animal_conditions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS animal_medications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        dosage TEXT,
        schedule TEXT,
        start_date TEXT,
        end_date TEXT,
        reminder_enabled INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS animal_vaccinations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        vaccination_date TEXT,
        next_due_date TEXT,
        reminder_enabled INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS animal_appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        appointment_at TEXT NOT NULL,
        location_mode TEXT NOT NULL DEFAULT 'praxis',
        location_text TEXT,
        veterinarian_id INTEGER,
        reminder_enabled INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE,
        FOREIGN KEY(veterinarian_id) REFERENCES veterinarians(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS animal_feedings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        time_of_day TEXT,
        food TEXT,
        amount TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS animal_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS document_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        is_required INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        category_id INTEGER,
        title TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER,
        uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE,
        FOREIGN KEY(category_id) REFERENCES document_categories(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS animal_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER NOT NULL,
        title TEXT,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animal_id INTEGER,
        title TEXT NOT NULL,
        reminder_type TEXT NOT NULL DEFAULT 'Allgemein',
        due_at TEXT NOT NULL,
        channel_email INTEGER NOT NULL DEFAULT 1,
        channel_telegram INTEGER NOT NULL DEFAULT 0,
        repeat_interval_days INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        completed_at TEXT,
        last_notified_at TEXT,
        last_delivery_status TEXT,
        last_delivery_error TEXT,
        source_kind TEXT,
        source_id INTEGER,
        source_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(animal_id) REFERENCES animals(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS email_change_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        requested_by_user_id INTEGER,
        new_email TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER,
        actor_email TEXT,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        channel TEXT NOT NULL,
        notification_type TEXT NOT NULL,
        recipient TEXT,
        subject TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      );
    `);
  },
};
