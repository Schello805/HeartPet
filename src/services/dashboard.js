const dayjs = require("dayjs");

function createDashboardService({ db, animalWorkspace, getSettings, homematic, parseCameras, readWeather, search }) {
  async function buildView(rawQuery) {
    const q = String(rawQuery || "").trim();
    const searchable = q.length >= 2;
    const now = dayjs();
    const endOfDay = now.endOf("day").format("YYYY-MM-DDTHH:mm");
    const nowValue = now.format("YYYY-MM-DDTHH:mm");
    const stats = {
      animalCount: db.prepare("SELECT COUNT(DISTINCT id) AS count FROM animals WHERE status = 'Aktiv'").get().count,
      documentCount: db.prepare("SELECT COUNT(*) AS count FROM documents").get().count,
      openReminderCount: db.prepare(`SELECT COUNT(*) AS count FROM reminders INNER JOIN animals ON animals.id = reminders.animal_id WHERE reminders.completed_at IS NULL AND animals.status = 'Aktiv'`).get().count,
      dueReminderCount: db.prepare(`SELECT COUNT(*) AS count FROM reminders INNER JOIN animals ON animals.id = reminders.animal_id WHERE reminders.completed_at IS NULL AND REPLACE(reminders.due_at, ' ', 'T') <= ? AND animals.status = 'Aktiv'`).get(nowValue).count,
    };
    const speciesCounts = db.prepare(`
      SELECT COALESCE(species.name, 'Ohne Tierart') AS name, species.id AS species_id, COUNT(animals.id) AS count
      FROM animals LEFT JOIN species ON species.id = animals.species_id
      WHERE animals.status = 'Aktiv' GROUP BY species.id, species.name
      ORDER BY species.name COLLATE NOCASE ASC
    `).all();
    const activeAnimals = db.prepare(`
      SELECT animals.id, animals.name, species.name AS species_name
      FROM animals LEFT JOIN species ON species.id = animals.species_id
      WHERE animals.status = 'Aktiv'
      ORDER BY animals.name COLLATE NOCASE ASC
    `).all();
    const upcomingReminders = db.prepare(`
      SELECT reminders.*, animals.name AS animal_name FROM reminders
      LEFT JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL AND animals.status = 'Aktiv'
        AND REPLACE(reminders.due_at, ' ', 'T') > ?
      ORDER BY REPLACE(reminders.due_at, ' ', 'T') ASC LIMIT 10
    `).all(endOfDay);
    const urgentReminders = db.prepare(`
      SELECT reminders.*, animals.name AS animal_name,
        CASE WHEN REPLACE(reminders.due_at, ' ', 'T') < ? THEN 'overdue'
          WHEN REPLACE(reminders.due_at, ' ', 'T') <= ? THEN 'today' ELSE 'upcoming' END AS urgency
      FROM reminders LEFT JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL AND animals.status = 'Aktiv'
        AND REPLACE(reminders.due_at, ' ', 'T') <= ?
      ORDER BY CASE WHEN REPLACE(reminders.due_at, ' ', 'T') < ? THEN 0
        WHEN REPLACE(reminders.due_at, ' ', 'T') <= ? THEN 1 ELSE 2 END,
        REPLACE(reminders.due_at, ' ', 'T') ASC LIMIT 12
    `).all(nowValue, endOfDay, endOfDay, nowValue, endOfDay);
    const attentionAnimals = animalWorkspace.enrichAnimals(db.prepare(`
      SELECT animals.*, species.name AS species_name,
        COALESCE(veterinarians.name, species_vet.name) AS veterinarian_name
      FROM animals
      LEFT JOIN species ON species.id = animals.species_id
      LEFT JOIN veterinarians ON veterinarians.id = animals.veterinarian_id
      LEFT JOIN veterinarians AS species_vet ON species_vet.id = species.default_veterinarian_id
      WHERE animals.status = 'Aktiv'
      ORDER BY datetime(animals.updated_at) DESC, animals.id DESC LIMIT 10
    `).all())
      .filter((animal) => animal.overdueReminderCount > 0 || animal.openReminderCount > 0 || !animal.veterinarian_name || animal.isProfileIncomplete)
      .sort((left, right) => right.overdueReminderCount - left.overdueReminderCount || right.openReminderCount - left.openReminderCount || String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
      .map((animal) => ({ ...animal, dashboardAttentionReasons: animalWorkspace.buildDashboardAttentionReasons(animal, { includeReminders: false }) }))
      .filter((animal) => animal.dashboardAttentionReasons.length > 0)
      .slice(0, 6);

    const settings = getSettings();
    const doorSensorId = String(settings.homematic_door_sensor_datapoint_id || "").trim();
    const doorLevelId = String(settings.homematic_door_level_datapoint_id || "").trim();
    const doorSensorConfigured = /^\d+$/.test(doorSensorId);
    const doorLevelConfigured = /^\d+$/.test(doorLevelId);
    const [weather, climate, doorSensorValue, doorLevelValue] = await Promise.all([
      readWeather(settings),
      homematic.readClimate(settings),
      doorSensorConfigured ? homematic.readDatapoint(settings, doorSensorId) : null,
      doorLevelConfigured ? homematic.readDatapoint(settings, doorLevelId) : null,
    ]);
    const sensorTrueMeansOpen = settings.homematic_door_sensor_true_state !== "closed";
    const rawDoorLevel = Number(doorLevelValue);
    return {
      pageTitle: "Dashboard",
      search: { q, searchable },
      searchResults: searchable ? search(q) : [],
      stats,
      speciesCounts,
      activeAnimals,
      upcomingReminders,
      urgentReminders,
      attentionAnimals,
      weather,
      coop: {
        cameras: parseCameras(settings.coop_camera_streams),
        temperature: climate.temperature,
        humidity: climate.humidity,
        climateError: climate.error || "",
        retrievedAt: new Date().toISOString(),
        temperatureConfigured: Boolean(homematic.getClimateDatapointIds(settings)),
        humidityConfigured: Boolean(homematic.getClimateDatapointIds(settings)),
        doorConfigured: Boolean(homematic.getDoorCommand(settings, true)),
        doorCloseConfigured: Boolean(homematic.getDoorCommand(settings, false)),
        doorSensorConfigured,
        doorIsOpen: doorSensorValue === null ? null : Boolean(doorSensorValue) === sensorTrueMeansOpen,
        doorLevelConfigured,
        doorOpenPercent: doorLevelValue === null || !Number.isFinite(rawDoorLevel) ? null : Math.round(Math.max(0, Math.min(100, rawDoorLevel > 1 ? rawDoorLevel : rawDoorLevel * 100))),
      },
    };
  }

  return { buildView };
}

module.exports = { createDashboardService };
