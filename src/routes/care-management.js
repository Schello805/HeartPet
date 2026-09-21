const express = require("express");
const dayjs = require("dayjs");

const INVENTORY_CATEGORIES = ["Futter", "Medikamente", "Pflege", "Verbrauchsmaterial", "Sonstiges"];
const INVENTORY_UNITS = ["Stück", "Packung", "kg", "g", "l", "ml"];
const EXPENSE_CATEGORIES = ["Tierarzt", "Medikamente", "Futter", "Ausstattung", "Versicherung", "Sonstiges"];

function parseNonNegativeNumber(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  const parsed = Number(normalized);
  return normalized !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseAmountCents(value) {
  const parsed = parseNonNegativeNumber(value);
  if (parsed === null) return null;
  const cents = Math.round(parsed * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dayjs(value).isValid() && dayjs(value).format("YYYY-MM-DD") === value;
}

function createCareManagementRouter({ createAuditLog, db, isDrawerRequest, redirectDocumentDrawerRequest, renderNotFound, requireAdmin, safeLocalReturnPath, setFlash }) {
  const router = express.Router();

  function getOverview() {
    const inventory = db.prepare(`
      SELECT *, quantity <= minimum_quantity AS is_low
      FROM inventory_items
      ORDER BY is_low DESC, category COLLATE NOCASE, name COLLATE NOCASE
    `).all();
    const expenses = db.prepare(`
      SELECT expenses.*, animals.name AS animal_name
      FROM expenses LEFT JOIN animals ON animals.id = expenses.animal_id
      ORDER BY expense_date DESC, expenses.id DESC LIMIT 100
    `).all();
    const now = dayjs();
    const monthPrefix = now.format("YYYY-MM");
    const yearPrefix = now.format("YYYY");
    return {
      inventory,
      expenses,
      summary: {
        lowStockCount: inventory.filter((item) => item.is_low).length,
        expiringCount: inventory.filter((item) => item.expires_on && dayjs(item.expires_on).isValid() && !dayjs(item.expires_on).isAfter(now.add(30, "day"), "day")).length,
        monthCents: expenses.filter((item) => String(item.expense_date).startsWith(monthPrefix)).reduce((sum, item) => sum + item.amount_cents, 0),
        yearCents: expenses.filter((item) => String(item.expense_date).startsWith(yearPrefix)).reduce((sum, item) => sum + item.amount_cents, 0),
      },
    };
  }

  router.get("/versorgung", (req, res) => {
    res.render("pages/care-management", { pageTitle: "Versorgung", ...getOverview() });
  });

  function renderDrawer(req, res, type, item = null) {
    if (!isDrawerRequest(req)) return redirectDocumentDrawerRequest(req, res, "/versorgung");
    return res.render("pages/care-management-drawer", {
      pageTitle: type === "inventory" ? (item ? "Bestand bearbeiten" : "Bestand anlegen") : (item ? "Kosten bearbeiten" : "Kosten erfassen"),
      type,
      item,
      animals: db.prepare("SELECT id, name FROM animals WHERE status = 'Aktiv' ORDER BY name COLLATE NOCASE").all(),
      inventoryCategories: INVENTORY_CATEGORIES,
      inventoryUnits: INVENTORY_UNITS,
      expenseCategories: EXPENSE_CATEGORIES,
      today: dayjs().format("YYYY-MM-DD"),
      returnTo: safeLocalReturnPath(req.query.return_to, "/versorgung"),
    });
  }

  router.get("/versorgung/bestand/new", requireAdmin, (req, res) => renderDrawer(req, res, "inventory"));
  router.get("/versorgung/bestand/:id/edit", requireAdmin, (req, res) => {
    const item = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(req.params.id);
    return item ? renderDrawer(req, res, "inventory", item) : renderNotFound(req, res, "Bestand nicht gefunden.");
  });
  router.get("/versorgung/kosten/new", requireAdmin, (req, res) => renderDrawer(req, res, "expense"));
  router.get("/versorgung/kosten/:id/edit", requireAdmin, (req, res) => {
    const item = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
    return item ? renderDrawer(req, res, "expense", item) : renderNotFound(req, res, "Kostenposition nicht gefunden.");
  });

  function inventoryPayload(body) {
    const name = String(body.name || "").trim();
    const category = INVENTORY_CATEGORIES.includes(body.category) ? body.category : "Sonstiges";
    const unit = INVENTORY_UNITS.includes(body.unit) ? body.unit : "Stück";
    const quantity = parseNonNegativeNumber(body.quantity);
    const minimumQuantity = parseNonNegativeNumber(body.minimum_quantity);
    if (!name || name.length > 120) return { error: "Bitte gib einen Namen mit maximal 120 Zeichen ein." };
    if (quantity === null || minimumQuantity === null) return { error: "Menge und Mindestbestand müssen gültige, nichtnegative Zahlen sein." };
    const expiresOn = String(body.expires_on || "").trim() || null;
    if (expiresOn && !isIsoDate(expiresOn)) return { error: "Bitte gib ein gültiges Haltbarkeitsdatum ein." };
    return { name, category, unit, quantity, minimumQuantity, expiresOn, notes: String(body.notes || "").trim() };
  }

  function expensePayload(body) {
    const description = String(body.description || "").trim();
    const category = EXPENSE_CATEGORIES.includes(body.category) ? body.category : "Sonstiges";
    const amountCents = parseAmountCents(body.amount);
    const expenseDate = String(body.expense_date || "").trim();
    if (!description || description.length > 160) return { error: "Bitte gib eine Beschreibung mit maximal 160 Zeichen ein." };
    if (amountCents === null) return { error: "Bitte gib einen gültigen, nichtnegativen Betrag ein." };
    if (!isIsoDate(expenseDate)) return { error: "Bitte gib ein gültiges Datum ein." };
    const animalId = /^\d+$/.test(String(body.animal_id || "")) ? Number(body.animal_id) : null;
    if (animalId && !db.prepare("SELECT 1 FROM animals WHERE id = ?").get(animalId)) return { error: "Das ausgewählte Tier wurde nicht gefunden." };
    return { description, category, amountCents, expenseDate, animalId, notes: String(body.notes || "").trim() };
  }

  router.post("/versorgung/bestand", requireAdmin, (req, res) => {
    const payload = inventoryPayload(req.body);
    if (payload.error) { setFlash(req, "error", payload.error); return res.redirect("/versorgung"); }
    const result = db.prepare("INSERT INTO inventory_items (name, category, quantity, unit, minimum_quantity, expires_on, notes) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(payload.name, payload.category, payload.quantity, payload.unit, payload.minimumQuantity, payload.expiresOn, payload.notes);
    createAuditLog(req, "inventory.create", { name: payload.name }, { entityType: "inventory", entityId: result.lastInsertRowid });
    setFlash(req, "success", "Bestand angelegt.");
    return res.redirect(safeLocalReturnPath(req.body.return_to, "/versorgung"));
  });

  router.post("/versorgung/bestand/:id/update", requireAdmin, (req, res) => {
    const payload = inventoryPayload(req.body);
    if (payload.error) { setFlash(req, "error", payload.error); return res.redirect("/versorgung"); }
    const result = db.prepare("UPDATE inventory_items SET name = ?, category = ?, quantity = ?, unit = ?, minimum_quantity = ?, expires_on = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(payload.name, payload.category, payload.quantity, payload.unit, payload.minimumQuantity, payload.expiresOn, payload.notes, req.params.id);
    if (!result.changes) return renderNotFound(req, res, "Bestand nicht gefunden.");
    createAuditLog(req, "inventory.update", { name: payload.name }, { entityType: "inventory", entityId: req.params.id });
    setFlash(req, "success", "Bestand aktualisiert.");
    return res.redirect(safeLocalReturnPath(req.body.return_to, "/versorgung"));
  });

  router.post("/versorgung/bestand/:id/delete", requireAdmin, (req, res) => {
    const item = db.prepare("SELECT name FROM inventory_items WHERE id = ?").get(req.params.id);
    db.prepare("DELETE FROM inventory_items WHERE id = ?").run(req.params.id);
    createAuditLog(req, "inventory.delete", { name: item?.name || "" }, { entityType: "inventory", entityId: req.params.id });
    setFlash(req, "success", "Bestand entfernt.");
    return res.redirect("/versorgung");
  });

  router.post("/versorgung/kosten", requireAdmin, (req, res) => {
    const payload = expensePayload(req.body);
    if (payload.error) { setFlash(req, "error", payload.error); return res.redirect("/versorgung"); }
    const result = db.prepare("INSERT INTO expenses (animal_id, category, description, amount_cents, expense_date, notes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(payload.animalId, payload.category, payload.description, payload.amountCents, payload.expenseDate, payload.notes);
    createAuditLog(req, "expense.create", { description: payload.description, amount_cents: payload.amountCents }, { entityType: "expense", entityId: result.lastInsertRowid });
    setFlash(req, "success", "Kosten erfasst.");
    return res.redirect(safeLocalReturnPath(req.body.return_to, "/versorgung"));
  });

  router.post("/versorgung/kosten/:id/update", requireAdmin, (req, res) => {
    const payload = expensePayload(req.body);
    if (payload.error) { setFlash(req, "error", payload.error); return res.redirect("/versorgung"); }
    const result = db.prepare("UPDATE expenses SET animal_id = ?, category = ?, description = ?, amount_cents = ?, expense_date = ?, notes = ? WHERE id = ?")
      .run(payload.animalId, payload.category, payload.description, payload.amountCents, payload.expenseDate, payload.notes, req.params.id);
    if (!result.changes) return renderNotFound(req, res, "Kostenposition nicht gefunden.");
    createAuditLog(req, "expense.update", { description: payload.description, amount_cents: payload.amountCents }, { entityType: "expense", entityId: req.params.id });
    setFlash(req, "success", "Kosten aktualisiert.");
    return res.redirect(safeLocalReturnPath(req.body.return_to, "/versorgung"));
  });

  router.post("/versorgung/kosten/:id/delete", requireAdmin, (req, res) => {
    const item = db.prepare("SELECT description FROM expenses WHERE id = ?").get(req.params.id);
    db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
    createAuditLog(req, "expense.delete", { description: item?.description || "" }, { entityType: "expense", entityId: req.params.id });
    setFlash(req, "success", "Kostenposition entfernt.");
    return res.redirect("/versorgung");
  });

  return router;
}

module.exports = { createCareManagementRouter, isIsoDate, parseAmountCents, parseNonNegativeNumber };
