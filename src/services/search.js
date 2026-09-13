function createSearchService({ db, formatDateTime }) {
  function search(rawQuery) {
    const q = String(rawQuery || "").trim();
    if (q.length < 2) return [];
    const query = `%${q}%`;
    const results = [];

    db.prepare(`
      SELECT animals.id, animals.name, animals.status, species.name AS species_name
      FROM animals LEFT JOIN species ON species.id = animals.species_id
      WHERE animals.name LIKE ? OR animals.breed LIKE ? OR animals.source LIKE ? OR species.name LIKE ?
      ORDER BY animals.name COLLATE NOCASE ASC LIMIT 20
    `).all(query, query, query, query).forEach((item) => results.push({
      kind: "Tier",
      title: item.name,
      subtitle: `${item.species_name || "-"} | ${item.status || "-"}`,
      href: `/animals/${item.id}`,
      when: "",
    }));

    db.prepare(`
      SELECT documents.title, documents.uploaded_at, animals.id AS animal_id,
        animals.name AS animal_name, document_categories.name AS category_name
      FROM documents
      LEFT JOIN animals ON animals.id = documents.animal_id
      LEFT JOIN document_categories ON document_categories.id = documents.category_id
      WHERE documents.title LIKE ? OR documents.original_name LIKE ? OR document_categories.name LIKE ?
      ORDER BY documents.uploaded_at DESC LIMIT 20
    `).all(query, query, query).forEach((item) => results.push({
      kind: "Dokument",
      title: item.title,
      subtitle: `${item.animal_name || "Ohne Tier"} | ${item.category_name || "Ohne Kategorie"}`,
      href: item.animal_id ? `/animals/${item.animal_id}` : "/animals",
      when: formatDateTime(item.uploaded_at),
    }));

    db.prepare(`
      SELECT reminders.title, reminders.reminder_type AS kind, reminders.due_at AS at,
        reminders.completed_at, animals.id AS animal_id, animals.name AS animal_name
      FROM reminders LEFT JOIN animals ON animals.id = reminders.animal_id
      WHERE reminders.title LIKE ? OR reminders.reminder_type LIKE ? OR reminders.notes LIKE ?
      ORDER BY reminders.due_at DESC LIMIT 30
    `).all(query, query, query).forEach((item) => results.push({
      kind: item.completed_at ? "Ereignis (erledigt)" : "Ereignis",
      title: item.title,
      subtitle: `${item.animal_name || "Ohne Tier"} | ${item.kind || "Erinnerung"}`,
      href: item.animal_id ? `/animals/${item.animal_id}` : "/",
      when: formatDateTime(item.at),
    }));

    return results.slice(0, 60);
  }

  function searchSpecies(rawQuery) {
    const query = String(rawQuery || "").trim().toLowerCase();
    if (query.length < 2) return [];
    return db.prepare("SELECT name FROM species ORDER BY name ASC").all()
      .map((item) => item.name)
      .filter((name) => name.toLowerCase().includes(query))
      .sort((left, right) => {
        const startDifference = Number(!left.toLowerCase().startsWith(query)) - Number(!right.toLowerCase().startsWith(query));
        return startDifference || left.localeCompare(right, "de");
      })
      .slice(0, 12);
  }

  return { search, searchSpecies };
}

module.exports = { createSearchService };
