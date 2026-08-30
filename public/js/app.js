let softNavInitialized = false;
let softNavInFlight = false;
const viewStateStorageKey = "heartpet-view-state";

function saveCurrentViewState() {
  try {
    const openDetails = Array.from(document.querySelectorAll(".main-content details[id]"))
      .filter((detail) => detail.open)
      .map((detail) => detail.id);
    const openCollapses = Array.from(document.querySelectorAll(".main-content .accordion-collapse[id].show"))
      .map((collapse) => collapse.id);

    sessionStorage.setItem(
      viewStateStorageKey,
      JSON.stringify({
        path: `${window.location.pathname}${window.location.search}`,
        scrollY: window.scrollY || window.pageYOffset || 0,
        openDetails,
        openCollapses,
        savedAt: Date.now(),
      })
    );
  } catch (error) {}
}

function restoreCurrentViewState() {
  try {
    const raw = sessionStorage.getItem(viewStateStorageKey);
    if (!raw) {
      return;
    }

    const state = JSON.parse(raw);
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (!state || state.path !== currentPath) {
      return;
    }

    const openDetailIds = new Set(Array.isArray(state.openDetails) ? state.openDetails : []);
    document.querySelectorAll(".main-content details[id]").forEach((detail) => {
      detail.open = openDetailIds.has(detail.id);
    });

    const openCollapseIds = new Set(Array.isArray(state.openCollapses) ? state.openCollapses : []);
    document.querySelectorAll(".main-content .accordion-collapse[id]").forEach((collapse) => {
      if (!openCollapseIds.has(collapse.id) || !window.bootstrap?.Collapse) {
        return;
      }
      window.bootstrap.Collapse.getOrCreateInstance(collapse, { toggle: false }).show();
    });

    window.requestAnimationFrame(() => {
      window.scrollTo(0, Number(state.scrollY || 0));
    });

    sessionStorage.removeItem(viewStateStorageKey);
  } catch (error) {}
}

function initCameraDiagnostics() {
  document.querySelectorAll("[data-camera-card]").forEach((card) => {
    const image = card.querySelector("[data-camera-image]");
    const errorBox = card.querySelector("[data-camera-error]");
    const toggle = card.querySelector("[data-camera-stream-toggle]");
    if (!image || !errorBox) return;
    const frameUrl = image.dataset.cameraFrameUrl;
    const streamUrl = card.dataset.cameraStreamUrl;
    let streaming = false;
    let diagnosing = false;
    const refreshFrame = () => {
      if (streaming || document.visibilityState !== "visible" || !frameUrl) return;
      image.src = `${frameUrl}${frameUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    };
    const setStreaming = (active) => {
      streaming = active;
      if (!toggle) return;
      toggle.textContent = active ? "Stream stoppen" : "Stream starten";
      toggle.classList.toggle("btn-primary", active);
      toggle.classList.toggle("btn-outline-primary", !active);
    };
    image.addEventListener("load", () => {
      image.classList.remove("d-none");
      errorBox.classList.add("d-none");
    });
    image.addEventListener("error", async () => {
      setStreaming(false);
      errorBox.classList.remove("d-none");
      errorBox.textContent = "Kameraverbindung wird geprüft …";
      if (diagnosing) return;
      diagnosing = true;
      try {
        const response = await fetch(card.dataset.cameraStatusUrl, { headers: { Accept: "application/json" } });
        const payload = await response.json();
        errorBox.textContent = payload.error || "Kamerabild konnte nicht geladen werden.";
      } catch (error) {
        errorBox.textContent = "Kameradiagnose konnte nicht geladen werden.";
      } finally {
        diagnosing = false;
      }
    });
    toggle?.addEventListener("click", () => {
      const nextUrl = streaming ? frameUrl : streamUrl;
      if (!nextUrl) return;
      setStreaming(!streaming);
      image.src = `${nextUrl}${nextUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    });
    window.setInterval(refreshFrame, 15000);
  });
}

function initCameraSettings() {
  document.querySelectorAll("[data-camera-settings]").forEach((root) => {
    if (root.dataset.bound === "1") return;
    root.dataset.bound = "1";
    const config = root.querySelector("[data-camera-config]");
    const list = root.querySelector("[data-camera-settings-list]");
    const template = root.querySelector("[data-camera-settings-template]");
    const empty = root.querySelector("[data-camera-empty]");
    if (!config || !list || !template) return;

    const serialize = () => {
      config.value = Array.from(list.querySelectorAll("[data-camera-settings-card], .camera-settings-card"))
        .map((card) => {
          const name = card.querySelector("[data-camera-name]")?.value.trim() || "";
          const snapshotUrl = card.querySelector("[data-camera-snapshot-url]")?.value.trim() || "";
          const streamUrl = card.querySelector("[data-camera-stream-url]")?.value.trim() || snapshotUrl;
          const group = card.querySelector("[data-camera-group]")?.value.trim() || "Kameras";
          return name || snapshotUrl || streamUrl ? `${name}|${snapshotUrl}|${streamUrl}|${group}` : "";
        })
        .filter(Boolean)
        .join("\n");
      empty?.classList.toggle("d-none", list.children.length > 0);
    };

    const loadPreview = async (card) => {
      const input = card.querySelector("[data-camera-snapshot-url]");
      const image = card.querySelector("[data-camera-preview]");
      const wrap = card.querySelector("[data-camera-preview-wrap]");
      const errorBox = card.querySelector("[data-camera-preview-error]");
      const url = input?.value.trim();
      if (!url || !image || !wrap || !errorBox) {
        wrap?.classList.add("d-none");
        errorBox?.classList.add("d-none");
        return;
      }
      const requestId = String(Date.now());
      card.dataset.previewRequest = requestId;
      errorBox.textContent = "Vorschau wird geladen …";
      errorBox.classList.remove("d-none", "alert-warning");
      errorBox.classList.add("alert-info");
      try {
        const response = await fetch("/admin/coop/camera-preview", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ url }),
        });
        if (!response.ok) throw new Error((await response.text()) || "Vorschau konnte nicht geladen werden.");
        const blobUrl = URL.createObjectURL(await response.blob());
        if (card.dataset.previewRequest !== requestId) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
        image.dataset.objectUrl = blobUrl;
        image.src = blobUrl;
        wrap.classList.remove("d-none");
        errorBox.classList.add("d-none");
      } catch (error) {
        if (card.dataset.previewRequest !== requestId) return;
        wrap.classList.add("d-none");
        errorBox.textContent = error.message;
        errorBox.classList.remove("d-none", "alert-info");
        errorBox.classList.add("alert-warning");
      }
    };

    const addCamera = ({ name = "", snapshotUrl = "", streamUrl = "", group = "Kameras" } = {}) => {
      const fragment = template.content.cloneNode(true);
      const card = fragment.querySelector(".camera-settings-card");
      card.querySelector("[data-camera-name]").value = name;
      card.querySelector("[data-camera-snapshot-url]").value = snapshotUrl;
      card.querySelector("[data-camera-stream-url]").value = streamUrl;
      card.querySelector("[data-camera-group]").value = group;
      card.querySelector("[data-camera-heading]").textContent = name || "Neue Kamera";
      let previewTimer;
      card.addEventListener("input", (event) => {
        card.querySelector("[data-camera-heading]").textContent = card.querySelector("[data-camera-name]").value.trim() || "Neue Kamera";
        serialize();
        if (event.target.matches("[data-camera-snapshot-url]")) {
          window.clearTimeout(previewTimer);
          previewTimer = window.setTimeout(() => loadPreview(card), 600);
        }
      });
      card.querySelector("[data-camera-remove]").addEventListener("click", () => {
        const image = card.querySelector("[data-camera-preview]");
        if (image?.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
        card.remove();
        serialize();
      });
      card.querySelector("[data-camera-move-up]").addEventListener("click", () => {
        const previous = card.previousElementSibling;
        if (previous) list.insertBefore(card, previous);
        serialize();
      });
      card.querySelector("[data-camera-move-down]").addEventListener("click", () => {
        const next = card.nextElementSibling;
        if (next) list.insertBefore(next, card);
        serialize();
      });
      list.appendChild(fragment);
      serialize();
      if (snapshotUrl) loadPreview(card);
    };

    String(config.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
      const parts = line.split("|").map((part) => part.trim());
      if (parts.length === 1) addCamera({ snapshotUrl: parts[0], streamUrl: parts[0] });
      else addCamera({ name: parts[0], snapshotUrl: parts[1], streamUrl: parts[2] || parts[1], group: parts[3] || "Kameras" });
    });
    root.querySelector("[data-camera-add]")?.addEventListener("click", () => addCamera());
    serialize();
  });
}

function initHomematicDoorDiscovery() {
  const root = document.querySelector("[data-homematic-door-setup]");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  const form = root.closest("form");
  const buttons = Array.from(form?.querySelectorAll("[data-homematic-discover]") || []);
  const status = root.querySelector("[data-homematic-discovery-status]");
  const selectedLabel = root.querySelector("[data-homematic-selected-label]");
  const picker = form?.querySelector("[data-homematic-picker]");
  const stalePicker = Array.from(document.body.children).find((element) => element.matches?.("[data-homematic-picker]"));
  if (stalePicker && stalePicker !== picker) stalePicker.remove();
  if (picker && picker.parentElement !== document.body) document.body.append(picker);
  const search = picker?.querySelector("[data-homematic-search]");
  const results = picker?.querySelector("[data-homematic-results]");
  const resultCount = picker?.querySelector("[data-homematic-result-count]");
  const pickerTitle = picker?.querySelector("[data-homematic-picker-title]");
  const pickerDescription = picker?.querySelector("[data-homematic-picker-description]");
  if (!buttons.length || !status || !picker || !search || !results || !resultCount) return;
  let datapoints = [];
  let activeButton = buttons[0];
  let activeInput = form.querySelector(`#${activeButton.dataset.homematicTarget}`);

  const describeDatapoint = (datapoint) => `${datapoint.device} · ${datapoint.channel} · ${datapoint.type || datapoint.name}`;
  const normalizeSearchText = (value) => String(value || "")
    .toLocaleLowerCase("de")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const renderResults = () => {
    const query = normalizeSearchText(search.value.trim());
    const allowedTypes = String(activeButton.dataset.homematicTypes || "").split(",").filter(Boolean);
    const needsWriteAccess = activeButton.dataset.homematicWritable === "true";
    const filtered = datapoints.filter((datapoint) =>
      (!needsWriteAccess || datapoint.writable)
      && (!allowedTypes.length || allowedTypes.includes(datapoint.type))
      && (!query || normalizeSearchText(`${datapoint.id} ${datapoint.device} ${datapoint.channel} ${datapoint.name} ${datapoint.type}`).includes(query))
    );
    const visible = filtered.slice(0, 60);
    resultCount.textContent = `${filtered.length} Treffer${filtered.length > visible.length ? ` · die ersten ${visible.length} werden angezeigt` : ""}`;
    results.replaceChildren(...visible.map((datapoint) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `list-group-item list-group-item-action p-3 ${activeInput?.value === datapoint.id ? "active" : ""}`;
      const heading = document.createElement("span");
      heading.className = "d-flex justify-content-between align-items-start gap-2";
      const name = document.createElement("strong");
      name.textContent = datapoint.device;
      const id = document.createElement("span");
      id.className = "badge text-bg-secondary-subtle border";
      id.textContent = `ISE ${datapoint.id}`;
      heading.append(name, id);
      const details = document.createElement("span");
      details.className = "small d-block mt-1";
      details.textContent = `${datapoint.channel} · ${datapoint.type || datapoint.name} · aktuell ${datapoint.value}`;
      item.append(heading, details);
      item.addEventListener("click", () => {
        activeInput.value = datapoint.id;
        if (selectedLabel && activeInput.id === "homematic_door_command_datapoint_id") {
          selectedLabel.textContent = describeDatapoint(datapoint);
          selectedLabel.classList.remove("d-none");
        }
        status.className = "alert alert-success py-2 mb-0 small";
        status.textContent = `${datapoint.device} mit ISE-ID ${datapoint.id} ausgewählt. Zum Abschluss Einstellungen speichern.`;
        window.bootstrap.Modal.getOrCreateInstance(picker).hide();
      });
      return item;
    }));
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "text-center text-body-secondary py-4";
      empty.textContent = "Keine passenden Datenpunkte gefunden.";
      results.replaceChildren(empty);
    }
  };
  search.addEventListener("input", renderResults);

  const openPicker = async (button) => {
    activeButton = button;
    activeInput = form.querySelector(`#${button.dataset.homematicTarget}`);
    if (!activeInput) return;
    if (pickerTitle) pickerTitle.textContent = `${activeInput.closest("div")?.querySelector("label")?.textContent || "Datenpunkt"} auswählen`;
    if (pickerDescription) pickerDescription.textContent = button.dataset.homematicWritable === "true" ? "Nur schreibbare CCU-Datenpunkte werden angezeigt." : "Passende Sensor-Datenpunkte werden angezeigt.";
    if (datapoints.length) {
      search.value = "";
      renderResults();
      window.bootstrap.Modal.getOrCreateInstance(picker).show();
      window.setTimeout(() => search.focus(), 250);
      return;
    }
    button.disabled = true;
    status.className = "alert alert-info py-2 mb-0 small";
    status.textContent = "Schreibbare CCU-Datenpunkte werden geladen …";
    try {
      const response = await fetch(root.dataset.discoveryUrl, { headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "CCU-Datenpunkte konnten nicht geladen werden.");
      datapoints = payload.datapoints;
      status.className = "alert alert-success py-2 mb-0 small";
      status.textContent = `${payload.datapoints.length} CCU-Datenpunkte geladen.`;
      search.value = "Hühnerklappe";
      renderResults();
      window.bootstrap.Modal.getOrCreateInstance(picker).show();
      window.setTimeout(() => search.focus(), 250);
    } catch (error) {
      status.className = "alert alert-danger py-2 mb-0 small";
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  buttons.forEach((button) => button.addEventListener("click", () => openPicker(button)));

  const testStatus = form.querySelector("[data-door-test-status]");
  form.querySelectorAll("[data-door-test]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    testStatus.className = "alert alert-info py-2 mb-0 small";
    testStatus.textContent = "Befehl wird an die CCU gesendet und die Endlage geprüft …";
    try {
      const response = await fetch(button.dataset.testUrl, { method: "POST", headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Türtest fehlgeschlagen.");
      testStatus.className = `alert ${payload.sensorConfigured && !payload.sensorConfirmed ? "alert-warning" : "alert-success"} py-2 mb-0 small`;
      testStatus.textContent = `${payload.message} Diagnose-ID: ${payload.commandId || "–"}`;
    } catch (error) {
      testStatus.className = "alert alert-danger py-2 mb-0 small";
      testStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }));
}

async function initClimateStatus() {
  const status = document.querySelector("[data-climate-status]");
  if (!status) return;
  try {
    const response = await fetch(status.dataset.statusUrl, { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      status.className = "alert alert-danger mb-0";
      const title = payload.loginOk ? "CCU-Login erfolgreich, Klimaabruf fehlgeschlagen" : "Verbindung fehlgeschlagen";
      status.innerHTML = `<strong class="d-block"></strong><span class="small"></span>`;
      status.querySelector("strong").textContent = title;
      const stageLabels = {
        configuration: "Konfiguration",
        login: "CCU-Anmeldung",
        "climate-read": "Datenabruf",
        parse: "Auswertung",
      };
      const stage = stageLabels[payload.stage] ? `Phase: ${stageLabels[payload.stage]}` : "";
      status.querySelector("span").textContent = [stage, payload.loginError, payload.error].filter(Boolean).join(" · ") || "CCU-Klimadaten konnten nicht abgefragt werden.";
      if (payload.logUrl) {
        const link = document.createElement("a");
        link.href = payload.logUrl;
        link.className = "d-block mt-2 fw-semibold";
        link.textContent = "Details im Systemlog öffnen";
        status.append(link);
      }
      return;
    }
    const values = [];
    if (payload.temperature !== null) values.push(`${Number(payload.temperature).toLocaleString("de-DE")} °C`);
    if (payload.humidity !== null) values.push(`${Number(payload.humidity).toLocaleString("de-DE")} % Luftfeuchte`);
    status.className = "alert alert-success mb-0";
    status.innerHTML = `<strong class="d-block">Verbindung erfolgreich</strong><span class="small"></span>`;
    status.querySelector("span").textContent = `${payload.loginOk ? "CCU-Anmeldung erfolgreich · " : ""}${values.join(" · ") || "Klima-Kanal antwortet erfolgreich."}`;
  } catch (error) {
    status.className = "alert alert-danger mb-0";
    status.innerHTML = `<strong class="d-block">Verbindungstest fehlgeschlagen</strong><span class="small">Status konnte nicht geladen werden.</span>`;
  }
}

async function loadPendingReminders() {
  const bannerTarget = document.querySelector(".page-header");
  if (!bannerTarget) {
    return;
  }

  const existing = document.querySelector(".floating-reminder");

  try {
    const response = await fetch("/api/reminders/pending");
    if (!response.ok) {
      existing?.remove();
      return;
    }

    const payload = await response.json();
    const count = Number(payload.count || 0);
    if (!count) {
      existing?.remove();
      try {
        sessionStorage.removeItem("heartpet-notified");
      } catch (error) {}
      return;
    }

    const href = window.location.pathname === "/" ? "#dringende-erinnerungen" : "/#dringende-erinnerungen";
    const bannerMarkup = `<strong>${count} fällige Erinnerung(en)</strong><span>Jetzt anzeigen</span>`;
    if (!existing) {
      const banner = document.createElement("a");
      banner.className = "floating-reminder";
      banner.href = href;
      banner.dataset.noSoftNav = "true";
      banner.innerHTML = bannerMarkup;
      bannerTarget.after(banner);
    } else {
      existing.href = href;
      existing.dataset.noSoftNav = "true";
      existing.innerHTML = bannerMarkup;
    }

    if ("Notification" in window) {
      if (Notification.permission === "default") {
        Notification.requestPermission();
      } else if (Notification.permission === "granted" && !sessionStorage.getItem("heartpet-notified")) {
        const first = payload.reminders[0];
        new Notification("HeartPet Erinnerung", {
          body: `${first.title}${first.animal_name ? ` für ${first.animal_name}` : ""}`,
        });
        sessionStorage.setItem("heartpet-notified", "1");
      }
    }
  } catch (error) {
    existing?.remove();
    console.error("HeartPet Hinweis konnte nicht geladen werden", error);
  }
}

function openHashTargetDetails() {
  const hash = String(window.location.hash || "").trim();
  if (!hash || hash === "#") {
    return;
  }

  const target = document.querySelector(hash);
  if (!target) {
    return;
  }

  const collapse =
    (target.classList?.contains("accordion-collapse") ? target : null) ||
    target.closest?.(".accordion-collapse") ||
    target.closest?.(".accordion-item")?.querySelector(".accordion-collapse");
  if (window.bootstrap?.Collapse) {
    const parentCollapses = [];
    let parent = target.parentElement?.closest?.(".collapse");
    while (parent) {
      parentCollapses.unshift(parent);
      parent = parent.parentElement?.closest?.(".collapse");
    }
    parentCollapses.forEach((item) => {
      window.bootstrap.Collapse.getOrCreateInstance(item, { toggle: false }).show();
    });
    if (collapse) {
      window.bootstrap.Collapse.getOrCreateInstance(collapse, { toggle: false }).show();
    }
  }

  const detail = target instanceof HTMLDetailsElement ? target : target.closest("details");
  if (detail) {
    detail.open = true;
  }
}

function initMobileNavToggle() {
  const offcanvasElement = document.getElementById("mobileNavOffcanvas");
  if (!offcanvasElement || !window.bootstrap?.Offcanvas) {
    return;
  }

  const offcanvas = window.bootstrap.Offcanvas.getOrCreateInstance(offcanvasElement);

  if (!document.body.dataset.mobileNavBound) {
    document.body.dataset.mobileNavBound = "1";
    document.addEventListener("click", (event) => {
      const navLink = event.target.closest("#mobileNavOffcanvas a[href]");
      if (navLink) {
        offcanvas.hide();
      }
    });
  }
}

function closeToast(toast) {
  if (!toast || toast.dataset.closing === "1") {
    return;
  }

  toast.dataset.closing = "1";
  toast.classList.add("is-closing");
  window.setTimeout(() => {
    toast.remove();
  }, 180);
}

function mountToast({ type = "success", message = "", title = "" }) {
  const viewport = document.querySelector(".toast-viewport");
  if (!viewport || !message) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = `flash toast flash-${type}`;
  toast.setAttribute("data-toast", "");
  toast.innerHTML = `
    <div class="toast-body">
      <strong class="toast-title">${title || (type === "error" ? "Fehler" : "Erfolg")}</strong>
      <div class="toast-message"></div>
    </div>
    <button type="button" class="toast-close" data-toast-close aria-label="Meldung schließen">×</button>
  `;
  toast.querySelector(".toast-message").textContent = message;
  viewport.appendChild(toast);
  bindToast(toast);
}

function bindToast(toast) {
  if (!toast || toast.dataset.bound === "1") {
    return;
  }

  toast.dataset.bound = "1";
  const closeButton = toast.querySelector("[data-toast-close]");
  closeButton?.addEventListener("click", () => closeToast(toast));

  const type = toast.classList.contains("flash-error") ? "error" : "success";
  const timeout = type === "error" ? 7000 : 4200;
  window.setTimeout(() => closeToast(toast), timeout);
}

function initToasts() {
  document.querySelectorAll("[data-toast]").forEach((toast) => bindToast(toast));
}

function initVeterinarianContactPopover() {
  const closeAll = () => {
    document.querySelectorAll("[data-vet-contact-popover]").forEach((popover) => {
      popover.hidden = true;
    });
    document.querySelectorAll("[data-vet-contact-toggle]").forEach((toggle) => {
      toggle.setAttribute("aria-expanded", "false");
    });
  };

  document.querySelectorAll("[data-vet-contact-toggle]").forEach((toggle) => {
    if (toggle.dataset.bound === "1") {
      return;
    }
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      const id = toggle.getAttribute("data-vet-contact-toggle");
      const popover = document.querySelector(`[data-vet-contact-popover="${id}"]`);
      if (!popover) {
        return;
      }
      const willOpen = popover.hidden;
      closeAll();
      popover.hidden = !willOpen;
      toggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
  });

  document.querySelectorAll("[data-vet-contact-close]").forEach((button) => {
    if (button.dataset.bound === "1") {
      return;
    }
    button.dataset.bound = "1";
    button.addEventListener("click", () => closeAll());
  });

  if (!document.body.dataset.vetPopoverBound) {
    document.body.dataset.vetPopoverBound = "1";
    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-vet-contact-popover]") || event.target.closest("[data-vet-contact-toggle]")) {
        return;
      }
      closeAll();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeAll();
      }
    });
  }
}

function initDrawerForms(scope = document) {
  scope.querySelectorAll("form[data-drawer-form]").forEach((form) => {
    if (form.dataset.bound === "1") {
      return;
    }

    form.dataset.bound = "1";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      resetCustomValidation(form);
      const invalidField = applyGermanValidationMessages(form);
      if (invalidField) {
        invalidField.reportValidity();
        return;
      }

      try {
        const formData = new FormData(form);
        const hasFileInput = form.querySelector('input[type="file"]');
        const useMultipart = Boolean(hasFileInput);
        const body = useMultipart ? formData : new URLSearchParams(formData);
        const response = await fetch(form.action, {
          method: form.method || "POST",
          body,
          headers: {
            "X-Requested-With": "heartpet-drawer",
          },
          credentials: "same-origin",
        });

        const text = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, "text/html");
        const fragment = doc.querySelector("[data-drawer-fragment]");
        const flash = doc.querySelector(".flash");
        const drawerBody = document.querySelector("[data-drawer-body]");

        if (fragment && drawerBody) {
          drawerBody.innerHTML = "";
          if (flash) {
            const type = flash.classList.contains("flash-error") ? "error" : "success";
            const message = flash.querySelector(".toast-message")?.textContent?.trim() || flash.textContent.trim();
            const title = flash.querySelector(".toast-title")?.textContent?.trim() || "";
            mountToast({ type, message, title });
          }
          drawerBody.appendChild(fragment.cloneNode(true));
          const title = fragment.getAttribute("data-drawer-title") || doc.title || "Bearbeiten";
          const drawerTitle = document.querySelector("#drawer-title");
          if (drawerTitle) {
            drawerTitle.textContent = title.replace(/\s+\|.*$/, "");
          }
          initDrawerNavigation();
          initDrawerForms(drawerBody);
          initVeterinarianContactPopover();
          initSpeciesAutocomplete();
          initRequiredMarks();
          initAnimalStatusWorkflow(drawerBody);
          initEventFormBehavior(drawerBody);
          initBulkSelection(drawerBody);
          return;
        }

        closeDrawer();
        const targetUrl = new URL(response.url || window.location.href, window.location.href);
        navigateTo(targetUrl, { push: targetUrl.toString() !== window.location.href, scrollTop: false });
      } catch (error) {
        console.error("Drawer-Formular konnte nicht gespeichert werden", error);
        form.dataset.bound = "fallback";
        HTMLFormElement.prototype.submit.call(form);
      }
    });
  });
}

function initBulkSelection(scope = document) {
  scope.querySelectorAll("[data-bulk-selection]").forEach((container) => {
    const selectAll = container.querySelector("[data-bulk-select-all]");
    const animalInputs = [...container.querySelectorAll("[data-bulk-animal]")];
    if (!selectAll || selectAll.dataset.bound === "1") return;

    selectAll.dataset.bound = "1";
    const updateSelectAll = () => {
      const selectedCount = animalInputs.filter((input) => input.checked).length;
      selectAll.checked = animalInputs.length > 0 && selectedCount === animalInputs.length;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < animalInputs.length;
    };
    selectAll.addEventListener("change", () => {
      animalInputs.forEach((input) => {
        input.checked = selectAll.checked;
      });
      updateSelectAll();
    });
    animalInputs.forEach((input) => input.addEventListener("change", updateSelectAll));
    updateSelectAll();
  });
}

async function openDrawer(urlLike) {
  const drawer = document.getElementById("app-drawer");
  const drawerBody = drawer?.querySelector("[data-drawer-body]");
  const drawerTitle = drawer?.querySelector("#drawer-title");
  if (!drawer || !drawerBody || !drawerTitle) {
    window.location.href = urlLike;
    return;
  }

  try {
    const targetUrl = new URL(urlLike, window.location.href);
    if (!targetUrl.searchParams.get("return_to")) {
      targetUrl.searchParams.set("return_to", `${window.location.pathname}${window.location.search}${window.location.hash}`);
    }

    const offcanvas = window.bootstrap?.Offcanvas?.getOrCreateInstance(drawer);
    offcanvas?.show();
    drawerBody.innerHTML = '<div class="panel"><p class="empty-state">Lade Formular ...</p></div>';

    const response = await fetch(targetUrl.toString(), {
      headers: {
        "X-Requested-With": "heartpet-drawer",
      },
      credentials: "same-origin",
    });

    if (!response.ok) {
      window.location.href = targetUrl.toString();
      return;
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const fragment = doc.querySelector("[data-drawer-fragment]");
    if (!fragment) {
      window.location.href = targetUrl.toString();
      return;
    }

    drawerBody.innerHTML = "";
    drawerBody.appendChild(fragment.cloneNode(true));
    drawerTitle.textContent = fragment.getAttribute("data-drawer-title") || "Bearbeiten";
    initDrawerNavigation();
    initDrawerForms(drawerBody);
    initVeterinarianContactPopover();
    initSpeciesAutocomplete();
    initRequiredMarks();
    initAnimalStatusWorkflow(drawerBody);
    initEventFormBehavior(drawerBody);
    initBulkSelection(drawerBody);
  } catch (error) {
    console.error("Drawer konnte nicht geladen werden", error);
    window.location.href = urlLike;
  }
}

function closeDrawer() {
  const drawer = document.getElementById("app-drawer");
  const drawerBody = drawer?.querySelector("[data-drawer-body]");
  if (!drawer || !drawerBody) {
    return;
  }

  const offcanvas = window.bootstrap?.Offcanvas?.getOrCreateInstance(drawer);
  offcanvas?.hide();
}

function initDrawerNavigation() {
  document.querySelectorAll("a[data-drawer]").forEach((anchor) => {
    if (anchor.dataset.bound === "1") {
      return;
    }
    anchor.dataset.bound = "1";
    anchor.dataset.noSoftNav = "true";
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      openDrawer(anchor.href);
    });
  });

  document.querySelectorAll("[data-drawer-close]").forEach((button) => {
    if (button.dataset.bound === "1") {
      return;
    }
    button.dataset.bound = "1";
    button.addEventListener("click", () => closeDrawer());
  });

  if (!document.body.dataset.drawerEscBound) {
    document.body.dataset.drawerEscBound = "1";
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeDrawer();
      }
    });
  }

  const drawer = document.getElementById("app-drawer");
  if (drawer && drawer.dataset.hiddenBound !== "1") {
    drawer.dataset.hiddenBound = "1";
    drawer.addEventListener("hidden.bs.offcanvas", () => {
      const drawerBody = drawer.querySelector("[data-drawer-body]");
      if (drawerBody) {
        drawerBody.innerHTML = "";
      }
    });
  }
}

function initAutoDrawerOpen() {
  const url = new URL(window.location.href);
  const drawerPath = url.searchParams.get("drawer");
  if (!drawerPath || document.body.dataset.autoDrawerHandled === "1") {
    return;
  }

  document.body.dataset.autoDrawerHandled = "1";
  url.searchParams.delete("drawer");
  const cleaned = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, "", cleaned);
  openDrawer(drawerPath);
}

function initSpeciesAutocomplete() {
  document.querySelectorAll("[data-species-autocomplete='true']").forEach((input) => {
    const datalist = input.parentElement?.querySelector("#species-suggestions") || document.querySelector("#species-suggestions");
    if (!datalist || input.dataset.bound === "1") {
      return;
    }

    input.dataset.bound = "1";
    let timer = null;
    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      const query = input.value.trim();
      if (query.length < 2) {
        return;
      }

      timer = window.setTimeout(async () => {
        try {
          const response = await fetch(`/api/species/search?q=${encodeURIComponent(query)}`);
          if (!response.ok) {
            return;
          }

          const payload = await response.json();
          if (!Array.isArray(payload.results)) {
            return;
          }

          datalist.innerHTML = payload.results
            .map((name) => `<option value="${String(name).replace(/"/g, "&quot;")}"></option>`)
            .join("");
        } catch (error) {
          console.error("Tierarten-Autovervollständigung konnte nicht geladen werden", error);
        }
      }, 180);
    });
  });
}

function initRequiredMarks() {
  document.querySelectorAll("label").forEach((label) => {
    const requiredField = label.querySelector("input[required], select[required], textarea[required]");
    const heading = label.querySelector("span");
    if (!requiredField || !heading || heading.querySelector(".required-mark")) {
      return;
    }

    const mark = document.createElement("span");
    mark.className = "required-mark";
    mark.textContent = " *";
    heading.append(mark);
  });
}

function initProfileUploadAutoSubmit() {
  document.querySelectorAll(".profile-upload-input").forEach((input) => {
    if (input.dataset.bound === "1") {
      return;
    }
    input.dataset.bound = "1";
    input.addEventListener("change", () => {
      if (!input.files || input.files.length === 0) {
        return;
      }

      const form = input.closest("form");
      const trigger = form?.querySelector(".profile-upload-trigger");
      if (trigger) {
        trigger.textContent = "Bild wird hochgeladen...";
      }

      if (!form) {
        return;
      }

      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        HTMLFormElement.prototype.submit.call(form);
      }
    });
  });
}

function initEventFormBehavior(scope = document) {
  scope.querySelectorAll("[data-event-form]").forEach((form) => {
    if (form.dataset.bound === "1") {
      return;
    }
    form.dataset.bound = "1";

    const kindInputs = [...form.querySelectorAll("[data-event-kind-select]")];
    const dateWrap = form.querySelector("[data-event-date-wrap]");
    const dateInput = form.querySelector("[data-event-date]");
    const timeWrap = form.querySelector("[data-event-time-wrap]");
    const timeInput = form.querySelector("[data-event-time]");
    const handledByVet = form.querySelector("[data-handled-by-vet]");
    const veterinarianFields = form.querySelector("[data-veterinarian-fields]");
    const veterinarianSelect = form.querySelector('select[name="veterinarian_id"]');
    const createReminder = form.querySelector("[data-create-reminder]");
    const reminderInlineWrap = form.querySelector("[data-reminder-inline-wrap]");
    const vetInlineWrap = form.querySelector("[data-vet-inline-wrap]");

    function updateEventForm() {
      const kind = kindInputs.find((input) => input.checked)?.value || "medication";
      const needsDate = kind !== "note" && kind !== "feeding";
      const needsTime = kind === "appointment" || kind === "reminder" || kind === "feeding";
      const canUseVeterinarian = ["medication", "vaccination", "appointment"].includes(kind);
      const showVeterinarian = canUseVeterinarian && Boolean(handledByVet?.checked);
      const canHaveReminder = ["medication", "vaccination", "appointment"].includes(kind);

      if (dateWrap) {
        dateWrap.hidden = !needsDate;
      }
      if (dateInput) {
        dateInput.required = needsDate;
        if (!needsDate) {
          dateInput.value = "";
        }
      }

      if (timeWrap) {
        timeWrap.hidden = !needsTime;
      }
      if (timeInput) {
        timeInput.required = needsTime;
        if (!needsTime) {
          timeInput.value = "";
        }
      }

      if (veterinarianFields) {
        veterinarianFields.hidden = !showVeterinarian;
      }
      if (vetInlineWrap) {
        vetInlineWrap.hidden = !canUseVeterinarian;
      }
      if (handledByVet && !canUseVeterinarian) {
        handledByVet.checked = false;
      }
      if (veterinarianSelect) {
        veterinarianSelect.disabled = !showVeterinarian;
        veterinarianSelect.required = showVeterinarian;
        if (!showVeterinarian) {
          veterinarianSelect.value = "";
        }
      }

      if (createReminder) {
        createReminder.disabled = !canHaveReminder;
        if (!canHaveReminder) {
          createReminder.checked = false;
        }
      }

      if (reminderInlineWrap) {
        reminderInlineWrap.hidden = !canHaveReminder;
      }
    }

    kindInputs.forEach((input) => input.addEventListener("change", updateEventForm));
    handledByVet?.addEventListener("change", updateEventForm);
    updateEventForm();
  });
}

function initAnimalStatusWorkflow(scope = document) {
  scope.querySelectorAll("[data-status-workflow]").forEach((workflow) => {
    if (workflow.dataset.bound === "1") {
      return;
    }
    workflow.dataset.bound = "1";

    const form = workflow.closest("form");
    const statusSelect = form?.querySelector("[data-animal-status-select]");
    const chip = workflow.querySelector("[data-status-workflow-chip]");
    const confirmWrap = workflow.querySelector("[data-status-confirm-wrap]");
    const confirmInput = workflow.querySelector("[data-status-confirm-input]");
    const confirmLabel = workflow.querySelector("[data-status-confirm-label]");
    const remindersWrap = workflow.querySelector("[data-status-reminders-wrap]");
    const remindersInput = workflow.querySelector("[data-status-reminders-input]");
    const detailWrap = workflow.querySelector("[data-status-detail-wrap]");
    const originalStatus = String(workflow.getAttribute("data-original-status") || "Aktiv").trim();
    const confirmLabels = {
      Vermittelt: "Ich bestätige, dass dieses Tier als vermittelt in die Historie wechseln soll.",
      Verkauft: "Ich bestätige, dass dieses Tier als verkauft in die Historie wechseln soll.",
      Verstorben: "Ich bestätige, dass dieses Tier als verstorben in die Historie wechseln soll.",
    };
    const chipTones = {
      Aktiv: "status-success",
      Vermittelt: "status-warning",
      Verkauft: "status-warning",
      Verstorben: "status-muted",
    };
    const detailRequirements = {
      Vermittelt: { nameRequired: true, dateRequired: true },
      Verkauft: { nameRequired: true, dateRequired: true },
      Verstorben: { nameRequired: false, dateRequired: true },
    };

    const updateStatusWorkflow = () => {
      const selectedStatus = String(statusSelect?.value || "Aktiv").trim();
      const requiresConfirmation = originalStatus === "Aktiv" && selectedStatus !== "Aktiv";

      workflow.querySelectorAll("[data-status-panel]").forEach((panel) => {
        panel.classList.toggle("d-none", panel.getAttribute("data-status-panel") !== selectedStatus);
      });

      if (chip) {
        chip.textContent = selectedStatus;
        chip.classList.remove("status-success", "status-warning", "status-muted");
        chip.classList.add(chipTones[selectedStatus] || "status-muted");
      }

      if (confirmWrap) {
        confirmWrap.classList.toggle("d-none", !requiresConfirmation);
      }

      if (confirmInput) {
        confirmInput.required = requiresConfirmation;
        if (!requiresConfirmation) {
          confirmInput.checked = false;
          confirmInput.setCustomValidity("");
        }
      }

      if (confirmLabel) {
        confirmLabel.textContent = confirmLabels[selectedStatus] || "";
      }

      const canChooseReminderClosure = requiresConfirmation && ["Vermittelt", "Verkauft"].includes(selectedStatus);
      if (remindersWrap) {
        remindersWrap.classList.toggle("d-none", !canChooseReminderClosure);
      }
      if (remindersInput && !canChooseReminderClosure) {
        remindersInput.checked = false;
      }

      if (detailWrap) {
        const showDetails = selectedStatus !== "Aktiv";
        detailWrap.classList.toggle("d-none", !showDetails);
        detailWrap.querySelectorAll("[data-status-detail-panel]").forEach((panel) => {
          const panelStatus = panel.getAttribute("data-status-detail-panel");
          const active = panelStatus === selectedStatus;
          panel.classList.toggle("d-none", !active);
          const requirements = detailRequirements[selectedStatus] || { nameRequired: false, dateRequired: false };
          const nameInput = panel.querySelector("[data-status-detail-name]");
          const dateInput = panel.querySelector("[data-status-detail-date]");
          if (nameInput) {
            nameInput.required = active && requirements.nameRequired;
          }
          if (dateInput) {
            dateInput.required = active && requirements.dateRequired;
          }
        });
      }
    };

    statusSelect?.addEventListener("change", updateStatusWorkflow);
    updateStatusWorkflow();
  });
}

function initGlobalSearchAutocomplete() {
  document.querySelectorAll("[data-global-search-autocomplete='true']").forEach((input) => {
    if (input.dataset.bound === "1") {
      return;
    }
    input.dataset.bound = "1";

    const field = input.closest(".search-autocomplete-field") || input.parentElement;
    if (!field) {
      return;
    }

    let list = field.querySelector(".global-search-suggest");
    if (!list) {
      list = document.createElement("div");
      list.className = "global-search-suggest";
      field.appendChild(list);
    }

    let timer = null;
    let latestQuery = "";

    const escapeHtml = (value) =>
      String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");

    const hide = () => {
      list.innerHTML = "";
      list.classList.remove("visible");
    };

    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      const query = input.value.trim();
      latestQuery = query;
      if (query.length < 2) {
        hide();
        return;
      }

      timer = window.setTimeout(async () => {
        try {
          const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(query)}`);
          if (!response.ok) {
            hide();
            return;
          }
          const payload = await response.json();
          if (latestQuery !== query) {
            return;
          }
          if (!Array.isArray(payload.results) || payload.results.length === 0) {
            hide();
            return;
          }

          list.innerHTML = payload.results
            .map((item) => `
              <a class="global-search-suggest-item" href="${escapeHtml(item.href)}">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.kind)} | ${escapeHtml(item.subtitle || "-")}</span>
              </a>
            `)
            .join("");
          list.classList.add("visible");
        } catch (error) {
          console.error("Globale Suche konnte nicht geladen werden", error);
          hide();
        }
      }, 140);
    });

    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!list.matches(":hover")) {
          hide();
        }
      }, 120);
    });

    input.addEventListener("focus", () => {
      const hasValue = input.value.trim().length >= 2;
      const hasItems = list.children.length > 0;
      if (hasValue && hasItems) {
        list.classList.add("visible");
      }
    });
  });
}

function isAnimalsWorkspaceDesktop() {
  return window.matchMedia("(min-width: 992px)").matches;
}

function syncAnimalsWorkspaceSummary(panel) {
  if (!(panel instanceof HTMLElement)) {
    return;
  }

  const selectedStrong = document.querySelector("[data-animals-selected-name]");
  const selectedSmall = document.querySelector("[data-animals-selected-species]");
  const nextStrong = document.querySelector("[data-animals-next-type]");
  const nextSmall = document.querySelector("[data-animals-next-label]");

  if (selectedStrong) {
    selectedStrong.textContent = panel.dataset.animalName || "Kein Tier";
  }
  if (selectedSmall) {
    selectedSmall.textContent = panel.dataset.animalSpecies || "Bitte links ein Tier auswählen";
  }
  if (nextStrong) {
    nextStrong.textContent = panel.dataset.animalNextType || "Offen";
  }
  if (nextSmall) {
    nextSmall.textContent = panel.dataset.animalNextLabel || "Noch kein Termin hinterlegt";
  }
}

function setAnimalsWorkspaceActiveLink(activeLink) {
  document.querySelectorAll("[data-animal-workspace-link]").forEach((link) => {
    link.classList.toggle("active", link === activeLink);
  });
}

async function loadAnimalWorkspacePanel(link, { push = true } = {}) {
  if (!link) {
    return false;
  }
  if (!(link instanceof HTMLElement) || !isAnimalsWorkspaceDesktop()) {
    return false;
  }

  const target = document.querySelector("[data-animal-workspace-target]");
  const panelUrl = link.dataset.panelUrl;
  if (!target || !panelUrl) {
    return false;
  }

  target.classList.add("loading");
  target.innerHTML = '<section class="panel animals-empty-detail"><p class="empty-state">Tierakte wird geladen ...</p></section>';

  try {
    const response = await fetch(panelUrl, {
      headers: {
        "X-Requested-With": "heartpet-workspace",
      },
      credentials: "same-origin",
    });

    if (!response.ok) {
      window.location.href = link.href;
      return true;
    }

    const html = await response.text();
    target.innerHTML = html;
    target.classList.remove("loading");
    setAnimalsWorkspaceActiveLink(link);
    const panel = target.querySelector("[data-animal-workspace-panel]");
    syncAnimalsWorkspaceSummary(panel);

    if (push) {
      const url = new URL(link.href, window.location.href);
      navigateTo(url, { push: true, scrollTop: false });
    }

    initPage();
    const stickyHeader = document.querySelector(".app-mobile-topbar");
    const headerOffset = stickyHeader instanceof HTMLElement ? stickyHeader.offsetHeight + 8 : 8;
    const targetTop = target.getBoundingClientRect().top + window.scrollY - headerOffset;
    window.scrollTo({ top: Math.max(targetTop, 0), behavior: "smooth" });
    return true;
  } catch (error) {
    console.error("Tierakte konnte nicht nachgeladen werden", error);
    window.location.href = link.href;
    return true;
  } finally {
    target.classList.remove("loading");
  }
}

function initAnimalWorkspace() {
  document.querySelectorAll("[data-animal-workspace-link]").forEach((link) => {
    if (link.dataset.boundWorkspace === "1") {
      return;
    }

    link.dataset.boundWorkspace = "1";
    link.addEventListener("click", (event) => {
      if (!isAnimalsWorkspaceDesktop()) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }

      event.preventDefault();
      loadAnimalWorkspacePanel(link, { push: true });
    });
  });
}

function resetCustomValidation(form) {
  form.querySelectorAll("input, select, textarea").forEach((field) => {
    field.setCustomValidity("");
  });
}

function validateDateRelations(form) {
  const birthDate = form.querySelector('input[name="birth_date"], input[name="animal_birth_date"]');
  const intakeDate = form.querySelector('input[name="intake_date"], input[name="animal_intake_date"]');
  if (birthDate && intakeDate && birthDate.value && intakeDate.value && birthDate.value > intakeDate.value) {
    intakeDate.setCustomValidity("Das Aufnahmedatum darf nicht vor dem Geburtsdatum liegen.");
    return intakeDate;
  }

  const startDate = form.querySelector('input[name="start_date"]');
  const endDate = form.querySelector('input[name="end_date"]');
  if (startDate && endDate && startDate.value && endDate.value && startDate.value > endDate.value) {
    endDate.setCustomValidity("Das Enddatum darf nicht vor dem Startdatum liegen.");
    return endDate;
  }

  const vaccinationDate = form.querySelector('input[name="vaccination_date"]');
  const nextDueDate = form.querySelector('input[name="next_due_date"]');
  if (vaccinationDate && nextDueDate && vaccinationDate.value && nextDueDate.value && vaccinationDate.value > nextDueDate.value) {
    nextDueDate.setCustomValidity("Die nächste Fälligkeit darf nicht vor dem Impfdatum liegen.");
    return nextDueDate;
  }

  return null;
}

function validatePasswordConfirmation(form) {
  const password = form.querySelector('input[name="new_password"]');
  const confirmation = form.querySelector('input[name="new_password_confirm"]');
  if (!password || !confirmation) {
    return null;
  }

  if (password.value && confirmation.value && password.value !== confirmation.value) {
    confirmation.setCustomValidity("Die neuen Passwörter stimmen nicht überein.");
    return confirmation;
  }

  return null;
}

function applyGermanValidationMessages(form) {
  const fields = form.querySelectorAll("input, select, textarea");
  for (const field of fields) {
    if (field.validity.valueMissing) {
      field.setCustomValidity("Dieses Feld ist ein Pflichtfeld.");
      return field;
    }

    if (field.validity.typeMismatch) {
      field.setCustomValidity("Bitte gib einen gültigen Wert ein.");
      return field;
    }

    if (field.validity.badInput) {
      field.setCustomValidity("Bitte gib einen gültigen Wert ein.");
      return field;
    }
  }

  const passwordError = validatePasswordConfirmation(form);
  if (passwordError) {
    return passwordError;
  }

  const dateError = validateDateRelations(form);
  if (dateError) {
    return dateError;
  }

  const statusConfirm = form.querySelector("[data-status-confirm-input]");
  if (statusConfirm?.required && !statusConfirm.checked) {
    statusConfirm.setCustomValidity("Bitte bestätige den Statuswechsel.");
    return statusConfirm;
  }

  return null;
}

function canSoftNavigate(url, anchor) {
  if (url.origin !== window.location.origin) {
    return false;
  }
  if (anchor.dataset.drawer) {
    return false;
  }
  if (anchor.target && anchor.target !== "_self") {
    return false;
  }
  if (anchor.hasAttribute("download")) {
    return false;
  }
  if (anchor.dataset.noSoftNav === "true") {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
    return false;
  }
  if (/^\/documents\/\d+\/download$/.test(url.pathname)) {
    return false;
  }
  if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search) {
    return false;
  }
  return true;
}

async function navigateTo(url, options = {}) {
  const { push = true, scrollTop = true } = options;
  if (softNavInFlight) {
    return;
  }

  softNavInFlight = true;
  try {
    const response = await fetch(url.toString(), {
      headers: {
        "X-Requested-With": "heartpet-soft-nav",
      },
      credentials: "same-origin",
    });

    if (!response.ok) {
      window.location.href = url.toString();
      return;
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const nextShell = doc.querySelector(".app-shell");
    const currentShell = document.querySelector(".app-shell");
    if (!nextShell || !currentShell) {
      window.location.href = url.toString();
      return;
    }

    currentShell.innerHTML = nextShell.innerHTML;
    document.title = doc.title || document.title;

    if (push) {
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (scrollTop) {
      window.scrollTo(0, 0);
    }

    document.body.classList.remove("nav-open");
    const offcanvasElement = document.getElementById("mobileNavOffcanvas");
    if (offcanvasElement && window.bootstrap?.Offcanvas) {
      window.bootstrap.Offcanvas.getOrCreateInstance(offcanvasElement).hide();
    }
    initPage();
  } catch (error) {
    console.error("Soft-Navigation fehlgeschlagen", error);
    window.location.href = url.toString();
  } finally {
    softNavInFlight = false;
  }
}

function initSoftNavigation() {
  if (softNavInitialized) {
    return;
  }
  softNavInitialized = true;

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest("a[href]");
    if (!anchor) {
      return;
    }
    if (event.defaultPrevented) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    const url = new URL(anchor.href, window.location.href);
    if (!canSoftNavigate(url, anchor)) {
      return;
    }

    event.preventDefault();
    navigateTo(url, { push: true, scrollTop: true });
  });

  window.addEventListener("popstate", () => {
    navigateTo(new URL(window.location.href), { push: false, scrollTop: false });
  });
}

function initPage() {
  try {
    sessionStorage.setItem("heartpet-nav-loaded", "1");
  } catch (error) {}

  initSoftNavigation();
  initMobileNavToggle();
  initToasts();
  initVeterinarianContactPopover();
  initDrawerNavigation();
  initAutoDrawerOpen();
  initDrawerForms();
  initSpeciesAutocomplete();
  initRequiredMarks();
  initAnimalStatusWorkflow();
  initProfileUploadAutoSubmit();
  initEventFormBehavior();
  initBulkSelection();
  initGlobalSearchAutocomplete();
  initAnimalWorkspace();
  initCameraDiagnostics();
  initCameraSettings();
  initHomematicDoorDiscovery();
  initClimateStatus();
  loadPendingReminders();
  openHashTargetDetails();
  restoreCurrentViewState();
}

window.addEventListener("hashchange", openHashTargetDetails);

document.addEventListener("click", (event) => {
  const row = event.target.closest(".table-row-link");
  if (!row) {
    return;
  }

  const interactive = event.target.closest("a, button, input, select, textarea, label");
  if (interactive) {
    return;
  }

  const url = new URL(row.dataset.href, window.location.href);
  navigateTo(url, { push: true, scrollTop: true });
});

document.addEventListener("keydown", (event) => {
  const row = event.target.closest(".table-row-link");
  if (!row) {
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const url = new URL(row.dataset.href, window.location.href);
    navigateTo(url, { push: true, scrollTop: true });
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  resetCustomValidation(form);

  const message = form.dataset.confirm;
  const invalidField = applyGermanValidationMessages(form);
  if (invalidField) {
    event.preventDefault();
    invalidField.reportValidity();
    return;
  }

  if (message && form.hasAttribute("data-confirm-modal")) {
    event.preventDefault();
    const modalElement = document.getElementById("app-confirm-modal");
    const messageElement = modalElement?.querySelector("[data-confirm-modal-message]");
    const titleElement = modalElement?.querySelector("#app-confirm-modal-title");
    const submitButton = modalElement?.querySelector("[data-confirm-modal-submit]");
    const iconElement = modalElement?.querySelector("[data-confirm-modal-icon]");
    const progressElement = modalElement?.querySelector("[data-confirm-modal-progress]");
    const actionsElement = modalElement?.querySelector("[data-confirm-modal-actions]");
    if (!modalElement || !messageElement || !titleElement || !submitButton || !iconElement || !progressElement || !actionsElement || !window.bootstrap?.Modal) return;
    modalElement.classList.remove("is-processing");
    modalElement.removeAttribute("aria-busy");
    progressElement.classList.add("d-none");
    actionsElement.classList.remove("d-none");
    messageElement.classList.remove("d-none");
    submitButton.disabled = false;
    messageElement.textContent = message;
    titleElement.textContent = form.dataset.confirmTitle || "Aktion bestätigen";
    submitButton.textContent = form.dataset.confirmSubmit || "Bestätigen";
    submitButton.onclick = () => {
      submitButton.disabled = true;
      modalElement.classList.add("is-processing");
      modalElement.setAttribute("aria-busy", "true");
      titleElement.textContent = form.dataset.confirmProgressTitle || "Stalltür wird bewegt";
      messageElement.classList.add("d-none");
      actionsElement.classList.add("d-none");
      progressElement.classList.remove("d-none");
      saveCurrentViewState();
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => form.submit()));
    };
    window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
    return;
  }

  if (message && !window.confirm(message)) {
    event.preventDefault();
    return;
  }

  if (form.dataset.drawerForm !== "true") {
    saveCurrentViewState();
  }
});

document.addEventListener("input", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) {
    return;
  }
  field.setCustomValidity("");
});

window.addEventListener("load", initPage);
