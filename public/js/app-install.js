(function initAppInstallation() {
  const DISMISSED_KEY = "heartpet-install-prompt-dismissed";
  let deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function isMobileDevice() {
    return window.matchMedia("(max-width: 991.98px)").matches
      || /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent);
  }

  function isIosDevice() {
    return /iPhone|iPad|iPod/i.test(window.navigator.userAgent);
  }

  function getDismissed() {
    try {
      return window.localStorage.getItem(DISMISSED_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function setDismissed() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch (error) {}
  }

  function setHidden(selector, hidden) {
    document.querySelectorAll(selector).forEach((element) => element.classList.toggle("d-none", hidden));
  }

  function updateInstallUi() {
    const hidden = isStandalone() || !isMobileDevice();
    setHidden("[data-app-install-entry]", hidden);
    setHidden("[data-app-install-prompt]", hidden || getDismissed() || (!deferredPrompt && !isIosDevice()));

    const description = isIosDevice()
      ? "In Safari zum Home-Bildschirm hinzufügen."
      : "Wie eine App direkt vom Startbildschirm öffnen.";
    document.querySelectorAll("[data-app-install-description]").forEach((element) => {
      element.textContent = description;
    });
  }

  function showManualInstructions() {
    const modalElement = document.getElementById("app-install-help-modal");
    if (!modalElement || !window.bootstrap?.Modal) return;

    const ios = isIosDevice();
    modalElement.querySelector("[data-app-install-help-text]").textContent = ios
      ? "Apple zeigt keinen direkten Installationsdialog. In Safari sind nur drei Schritte nötig:"
      : "Falls kein Installationsdialog erscheint, kannst du HeartPet über das Browsermenü hinzufügen:";
    const items = ios
      ? ["Diese Seite in Safari öffnen.", "Unten auf Teilen tippen.", "Zum Home-Bildschirm auswählen."]
      : ["Das Browsermenü öffnen.", "App installieren oder Zum Startbildschirm hinzufügen wählen.", "Die Installation bestätigen."];
    const steps = modalElement.querySelector("[data-app-install-help-steps]");
    steps.replaceChildren(...items.map((item) => {
      const listItem = document.createElement("li");
      listItem.textContent = item;
      return listItem;
    }));
    window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
  }

  async function requestInstallation() {
    if (!deferredPrompt) {
      showManualInstructions();
      return;
    }

    const prompt = deferredPrompt;
    deferredPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice?.outcome === "accepted") setDismissed();
    updateInstallUi();
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    updateInstallUi();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    setDismissed();
    updateInstallUi();
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-app-install-action]")) {
      requestInstallation();
      return;
    }
    if (event.target.closest("[data-app-install-dismiss]")) {
      setDismissed();
      updateInstallUi();
    }
  });

  if ("serviceWorker" in window.navigator && (window.isSecureContext || window.location.hostname === "localhost")) {
    window.navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateInstallUi, { once: true });
  } else {
    updateInstallUi();
  }
})();
