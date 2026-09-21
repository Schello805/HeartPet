const express = require("express");

function createCalendarRouter({ calendar, db, renderNotFound }) {
  const router = express.Router();

  function sendCalendar(res, filename, content) {
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(content);
  }

  router.get("/calendar.ics", (req, res) => {
    return sendCalendar(res, "heartpet-kalender.ics", calendar.exportCalendar());
  });

  router.get("/animals/:id/calendar.ics", (req, res) => {
    const animal = db.prepare("SELECT id, name FROM animals WHERE id = ?").get(req.params.id);
    if (!animal) return renderNotFound(req, res, "Tier nicht gefunden.");
    const safeName = String(animal.name).toLocaleLowerCase("de-DE").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tier";
    return sendCalendar(res, `${safeName}-kalender.ics`, calendar.exportCalendar({ animalId: animal.id, name: `HeartPet - ${animal.name}` }));
  });

  return router;
}

module.exports = { createCalendarRouter };
