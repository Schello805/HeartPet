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

async function loadPendingReminders() {
  const bannerTarget = document.querySelector(".page-header");
  if (!bannerTarget) {
    return;
  }

  try {
    const response = await fetch("/api/reminders/pending");
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const existing = document.querySelector(".floating-reminder");
    if (!payload.count) {
      existing?.remove();
      try {
        sessionStorage.removeItem("heartpet-notified");
      } catch (error) {}
      return;
    }

    const href = window.location.pathname === "/" ? "#dringende-erinnerungen" : "/#dringende-erinnerungen";
    const bannerMarkup = `<strong>${payload.count} offene Erinnerung(en)</strong><span>Jetzt direkt anzeigen</span>`;
    if (!existing) {
      const banner = document.createElement("a");
      banner.className = "floating-reminder";
      banner.href = href;
      banner.innerHTML = bannerMarkup;
      bannerTarget.after(banner);
    } else {
      existing.href = href;
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
  if (collapse && window.bootstrap?.Collapse) {
    window.bootstrap.Collapse.getOrCreateInstance(collapse, { toggle: false }).show();
  }

  const detail = target instanceof HTMLDetailsElement ? target : target.closest("details");
  if (detail) {
    detail.open = true;
  }
}

function initMobileNavToggle() {
  const offcanvasElement = document.getElementById("mobileNavOffcanvas");
  if (offcanvasElement && window.bootstrap?.Offcanvas) {
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
    return;
  }

  const toggles = Array.from(document.querySelectorAll(".mobile-nav-toggle"));
  if (!toggles.length) {
    return;
  }

  const setExpandedState = (expanded) => {
    toggles.forEach((toggle) => {
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  };

  toggles.forEach((toggle) => {
    if (toggle.dataset.bound === "1") {
      return;
    }
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", () => {
      const nextState = !document.body.classList.contains("nav-open");
      document.body.classList.toggle("nav-open", nextState);
      setExpandedState(nextState);
    });
  });

  if (!document.body.dataset.mobileNavBound) {
    document.body.dataset.mobileNavBound = "1";
    document.addEventListener("click", (event) => {
      if (!document.body.classList.contains("nav-open")) {
        return;
      }
      if (event.target.closest(".sidebar") || event.target.closest(".mobile-nav-toggle")) {
        return;
      }
      document.body.classList.remove("nav-open");
      setExpandedState(false);
    });

    document.addEventListener("click", (event) => {
      const navLink = event.target.closest(".sidebar a[href]");
      if (!navLink || !window.matchMedia("(max-width: 960px)").matches) {
        return;
      }
      document.body.classList.remove("nav-open");
      setExpandedState(false);
    });
  }
}

function initSidebarGroups() {
  const storageKey = "heartpet-sidebar-groups";
  let openGroups = {};
  const isMobile = window.matchMedia("(max-width: 960px)").matches;
  try {
    openGroups = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
  } catch (error) {
    openGroups = {};
  }

  document.querySelectorAll("[data-sidebar-group]").forEach((group) => {
    const key = group.dataset.sidebarGroup;
    const toggle = group.querySelector(".sidebar-group-toggle");
    if (!key || !toggle) {
      return;
    }

    const applyState = (isOpen) => {
      group.classList.toggle("open", isOpen);
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    };

    const initialState = isMobile ? true : Boolean(openGroups[key]);
    applyState(initialState);

    if (toggle.dataset.bound === "1") {
      return;
    }

    toggle.dataset.bound = "1";
    toggle.addEventListener("click", () => {
      const nextState = !group.classList.contains("open");
      applyState(nextState);
      openGroups[key] = nextState;
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(openGroups));
      } catch (error) {}
    });
  });
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
          initEventFormBehavior(drawerBody);
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

    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("drawer-open");
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
    initEventFormBehavior(drawerBody);
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

  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  window.setTimeout(() => {
    if (!drawer.classList.contains("open")) {
      drawerBody.innerHTML = "";
    }
  }, 180);
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

      form?.requestSubmit();
    });
  });
}

function initEventFormBehavior(scope = document) {
  scope.querySelectorAll("[data-event-form]").forEach((form) => {
    if (form.dataset.bound === "1") {
      return;
    }
    form.dataset.bound = "1";

    const kindSelect = form.querySelector("[data-event-kind-select]");
    const timeWrap = form.querySelector("[data-event-time-wrap]");
    const timeInput = form.querySelector("[data-event-time]");
    const handledByVet = form.querySelector("[data-handled-by-vet]");
    const veterinarianFields = form.querySelector("[data-veterinarian-fields]");
    const veterinarianSelect = form.querySelector('select[name="veterinarian_id"]');
    const createReminder = form.querySelector("[data-create-reminder]");
    const reminderInlineWrap = form.querySelector("[data-reminder-inline-wrap]");

    function updateEventForm() {
      const kind = kindSelect?.value || "medication";
      const needsTime = kind === "appointment" || kind === "reminder";
      const showVeterinarian = Boolean(handledByVet?.checked);
      const canHaveReminder = kind !== "reminder";

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

    kindSelect?.addEventListener("change", updateEventForm);
    handledByVet?.addEventListener("change", updateEventForm);
    updateEventForm();
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
  return window.matchMedia("(min-width: 961px)").matches;
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
      window.history.pushState({ animalWorkspace: true }, "", link.href);
    }

    initPage();
    target.scrollIntoView({ block: "start", behavior: "smooth" });
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

  return validatePasswordConfirmation(form) || validateDateRelations(form);
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
  initSidebarGroups();
  initToasts();
  initVeterinarianContactPopover();
  initDrawerNavigation();
  initAutoDrawerOpen();
  initDrawerForms();
  initSpeciesAutocomplete();
  initRequiredMarks();
  initProfileUploadAutoSubmit();
  initEventFormBehavior();
  initGlobalSearchAutocomplete();
  initAnimalWorkspace();
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
