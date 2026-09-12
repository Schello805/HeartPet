function createErrorHandler({ redactSensitiveText, sanitizeLogText, setFlash }) {
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const context = {
      method: sanitizeLogText(req.method),
      path: sanitizeLogText(req.path),
      status: Number(error?.status || 500),
      error: redactSensitiveText(error?.message || "Unbekannter Fehler"),
    };
    console.error(`[HeartPet][HTTP] ${JSON.stringify(context)}`);
    if (error?.name === "MulterError" || /file type|unexpected field/i.test(String(error?.message || ""))) {
      setFlash(req, "error", error.code === "LIMIT_FILE_SIZE"
        ? "Die Datei ist zu groß. Erlaubt sind maximal 20 MB."
        : "Datei konnte nicht hochgeladen werden. Bitte Dateityp und Größe prüfen.");
      return res.redirect("/");
    }
    return res.status(context.status >= 400 && context.status < 600 ? context.status : 500).render("pages/not-found", {
      pageTitle: "Technischer Fehler",
      message: "Die Anfrage konnte nicht verarbeitet werden.",
    });
  };
}

module.exports = { createErrorHandler };
