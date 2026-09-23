function startServer({ app, port, bindHost, scheduler, accessUrls, beforeClose }) {
  scheduler.start();

  const server = app.listen(port, bindHost, () => {
    console.log("HeartPet läuft auf:");
    for (const url of accessUrls) {
      console.log(`- ${url}`);
    }
    console.log("Anmeldung unter /login.");
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[HeartPet] ${signal}: Beende Dienst und CCU-Sitzung.`);
    const forceExit = setTimeout(() => process.exit(1), 10000);
    forceExit.unref();
    await beforeClose();
    server.close(() => process.exit(0));
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  return server;
}

module.exports = { startServer };
