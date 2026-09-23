(function registerDeviceFeatures() {
  function initCameraDiagnostics() {
    document.querySelectorAll("[data-camera-card]").forEach((card) => {
      const image = card.querySelector("[data-camera-image]");
      const errorBox = card.querySelector("[data-camera-error]");
      const toggle = card.querySelector("[data-camera-stream-toggle]");
      const meta = card.querySelector("[data-camera-meta]");
      if (!image || !errorBox) return;
      const frameUrl = image.dataset.cameraFrameUrl;
      const streamUrl = card.dataset.cameraStreamUrl;
      let streaming = false;
      let diagnosing = false;
      const setMeta = (state, label) => {
        if (!meta) return;
        meta.className = `ui-status ui-status--${state}`;
        meta.innerHTML = '<span class="ui-status__dot" aria-hidden="true"></span>';
        meta.append(document.createTextNode(label));
      };
      const refreshFrame = () => {
        if (streaming || document.visibilityState !== "visible" || !frameUrl) return;
        image.src = `${frameUrl}${frameUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
      };
      const setStreaming = (active) => {
        streaming = active;
        if (!toggle) return;
        toggle.textContent = active ? "Stream stoppen" : "Stream";
        toggle.classList.toggle("btn-primary", active);
        toggle.classList.toggle("btn-outline-primary", !active);
      };
      image.addEventListener("load", () => {
        image.classList.remove("d-none");
        errorBox.classList.add("d-none");
        setMeta("ok", streaming ? "Live-Stream aktiv" : `Aktualisiert ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`);
      });
      image.addEventListener("error", async () => {
        setStreaming(false);
        errorBox.classList.remove("d-none");
        setMeta("error", "Verbindung unterbrochen");
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
        setMeta("loading", streaming ? "Stream wird geladen" : "Standbild wird geladen");
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
        card.querySelector("[data-camera-preview-load]")?.addEventListener("click", () => loadPreview(card));
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
        const sensorDetail = payload.sensorConfigured
          ? ` Sensorwert ${payload.sensorValue ?? "–"}, erwartet ${payload.expectedSensorValue ?? "–"}; ${payload.attempts || 0} Prüfungen.`
          : "";
        testStatus.textContent = `${payload.message}${sensorDetail} Diagnose-ID: ${payload.commandId || "–"}`;
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
  

  window.HeartPetFeatures?.register("camera-diagnostics", initCameraDiagnostics, { contexts: ["page"] });
  window.HeartPetFeatures?.register("camera-settings", initCameraSettings, { contexts: ["page"] });
  window.HeartPetFeatures?.register("homematic-door-discovery", initHomematicDoorDiscovery, { contexts: ["page"] });
  window.HeartPetFeatures?.register("climate-status", initClimateStatus, { contexts: ["page"] });
})();
