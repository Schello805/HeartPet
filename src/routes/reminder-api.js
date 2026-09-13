const express = require("express");
const dayjs = require("dayjs");

function createReminderApiRouter({ repository }) {
  const router = express.Router();
  router.get("/api/reminders/pending", (req, res) => {
    const now = dayjs().format("YYYY-MM-DDTHH:mm");
    const reminders = repository.listPending(now);
    return res.json({
      count: repository.countActiveOpen("REPLACE(reminders.due_at, ' ', 'T') <= ?", now),
      reminders,
    });
  });
  router.heartpetMountPath = "";
  return router;
}

module.exports = { createReminderApiRouter };
