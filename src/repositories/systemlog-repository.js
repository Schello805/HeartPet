function createSystemlogRepository(db) {
  const listNotificationLogs = (level = "all") => {
    const filtered = level !== "all";
    return db.prepare(`
      SELECT * FROM notification_logs
      ${filtered ? "WHERE channel = ?" : ""}
      ORDER BY created_at DESC
      LIMIT 200
    `).all(...(filtered ? [level] : []));
  };

  const listAuditLogs = () => db.prepare(`
    SELECT * FROM audit_logs
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  const getOverviewCounts = () => ({
    activeAnimals: db.prepare("SELECT COUNT(*) AS count FROM animals WHERE status = 'Aktiv'").get().count,
    openReminders: db.prepare(`
      SELECT COUNT(*) AS count
      FROM reminders
      INNER JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL AND animals.status = 'Aktiv'
    `).get().count,
    notificationErrors24h: db.prepare(`
      SELECT COUNT(*) AS count
      FROM notification_logs
      WHERE status = 'error' AND datetime(created_at) >= datetime('now', '-1 day')
    `).get().count,
    lastNotificationAt: db.prepare("SELECT created_at FROM notification_logs ORDER BY created_at DESC LIMIT 1").get()?.created_at || "",
  });

  const checkDatabase = () => db.prepare("SELECT 1").get();

  return { checkDatabase, getOverviewCounts, listAuditLogs, listNotificationLogs };
}

module.exports = { createSystemlogRepository };
