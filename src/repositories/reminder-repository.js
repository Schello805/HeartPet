function createReminderRepository(db) {
  function listDue(now) {
    return db.prepare(`
      SELECT reminders.*, animals.name AS animal_name
      FROM reminders
      INNER JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL
        AND reminders.due_at <= ?
        AND reminders.last_notified_at IS NULL
        AND animals.status = 'Aktiv'
      ORDER BY reminders.due_at ASC
    `).all(now);
  }

  function updateDelivery(id, delivery) {
    db.prepare(`
      UPDATE reminders
      SET last_notified_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_notified_at END,
          last_delivery_status = ?, last_delivery_error = ?
      WHERE id = ?
    `).run(delivery.notified ? 1 : 0, delivery.status, delivery.error || "", id);
  }

  function countActiveOpen(condition, ...params) {
    return db.prepare(`
      SELECT COUNT(*) AS count
      FROM reminders
      INNER JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL
        AND animals.status = 'Aktiv'
        AND ${condition}
    `).get(...params).count;
  }

  function listDigest(until) {
    return db.prepare(`
      SELECT reminders.*, animals.name AS animal_name
      FROM reminders
      INNER JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL
        AND REPLACE(reminders.due_at, ' ', 'T') <= ?
        AND animals.status = 'Aktiv'
      ORDER BY REPLACE(reminders.due_at, ' ', 'T') ASC
      LIMIT 20
    `).all(until);
  }

  function listPending(now, limit = 5) {
    return db.prepare(`
      SELECT reminders.id, reminders.title, reminders.due_at, reminders.animal_id,
             animals.name AS animal_name
      FROM reminders
      INNER JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.completed_at IS NULL
        AND REPLACE(reminders.due_at, ' ', 'T') <= ?
        AND animals.status = 'Aktiv'
      ORDER BY REPLACE(reminders.due_at, ' ', 'T') ASC
      LIMIT ?
    `).all(now, limit);
  }

  return { countActiveOpen, listDigest, listDue, listPending, updateDelivery };
}

module.exports = { createReminderRepository };
