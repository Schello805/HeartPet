let softNavInitialized = false;
let softNavInFlight = false;
const viewStateStorageKey = "heartpet-view-state";
const {
  applyGermanValidationMessages = () => null,
  resetCustomValidation = () => {},
} = window.HeartPetFormValidation || {};

const initPasswordVisibility = window.HeartPetPasswordVisibility?.init || (() => null);

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

window.HeartPetToasts = { mount: mountToast };

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

function initBulkSelection(scope = document) {
  scope.querySelectorAll("[data-bulk-selection]").forEach((container) => {
    const selectAll = container.querySelector("[data-bulk-select-all]");
    const animalInputs = [...container.querySelectorAll("[data-bulk-animal]")];
    const groups = [...container.querySelectorAll("[data-bulk-group]")];
    if (!selectAll || selectAll.dataset.bound === "1") return;

    selectAll.dataset.bound = "1";
    const updateGroups = () => {
      groups.forEach((group) => {
        const groupSelect = group.querySelector("[data-bulk-select-group]");
        const groupInputs = [...group.querySelectorAll("[data-bulk-animal]")];
        if (!groupSelect) return;
        const selectedCount = groupInputs.filter((input) => input.checked).length;
        groupSelect.checked = groupInputs.length > 0 && selectedCount === groupInputs.length;
        groupSelect.indeterminate = selectedCount > 0 && selectedCount < groupInputs.length;
      });
    };
    const updateSelectAll = () => {
      const selectedCount = animalInputs.filter((input) => input.checked).length;
      selectAll.checked = animalInputs.length > 0 && selectedCount === animalInputs.length;
      selectAll.indeterminate = selectedCount > 0 && selectedCount < animalInputs.length;
      updateGroups();
    };
    selectAll.addEventListener("change", () => {
      animalInputs.forEach((input) => {
        input.checked = selectAll.checked;
      });
      updateSelectAll();
    });
    groups.forEach((group) => {
      const groupSelect = group.querySelector("[data-bulk-select-group]");
      const groupInputs = [...group.querySelectorAll("[data-bulk-animal]")];
      groupSelect?.addEventListener("change", () => {
        groupInputs.forEach((input) => {
          input.checked = groupSelect.checked;
        });
        updateSelectAll();
      });
    });
    animalInputs.forEach((input) => input.addEventListener("change", updateSelectAll));
    updateSelectAll();
  });
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
    if (form.dataset.eventBound === "1") {
      return;
    }
    form.dataset.eventBound = "1";

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
    const vaccinationCertificateWrap = form.querySelector("[data-vaccination-certificate-wrap]");
    const vaccinationCertificate = form.querySelector("[data-vaccination-certificate]");
    const vaccinationPresetWrap = form.querySelector("[data-vaccination-preset-wrap]");
    const vaccinationPreset = vaccinationPresetWrap?.querySelector("[data-vaccination-preset]");

    function updateEventForm() {
      const kind = kindInputs.find((input) => input.checked)?.value || "medication";
      const needsDate = kind !== "note" && kind !== "feeding";
      const needsTime = kind === "appointment" || kind === "reminder" || kind === "feeding";
      const canUseVeterinarian = ["medication", "vaccination", "appointment"].includes(kind);
      const showVeterinarian = canUseVeterinarian && Boolean(handledByVet?.checked);
      const canHaveReminder = ["medication", "vaccination", "appointment"].includes(kind);
      const isVaccination = kind === "vaccination";

      if (vaccinationCertificateWrap) {
        vaccinationCertificateWrap.hidden = !isVaccination;
      }
      if (vaccinationCertificate) {
        vaccinationCertificate.disabled = !isVaccination;
        if (!isVaccination) vaccinationCertificate.value = "";
      }
      if (vaccinationPresetWrap) {
        vaccinationPresetWrap.hidden = !isVaccination;
      }
      if (vaccinationPreset) {
        vaccinationPreset.disabled = !isVaccination;
      }

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
        veterinarianSelect.required = false;
        veterinarianSelect.setAttribute("aria-required", showVeterinarian ? "true" : "false");
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
    form.addEventListener("submit", (event) => {
      if (!handledByVet?.checked || veterinarianSelect?.value) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const modalElement = document.querySelector("#event-veterinarian-modal");
      const modalSelect = modalElement?.querySelector("[data-event-veterinarian-modal-select]");
      const applyButton = modalElement?.querySelector("[data-event-veterinarian-apply]");
      const removeButton = modalElement?.querySelector("[data-event-veterinarian-remove]");
      if (!modalElement || !modalSelect || !applyButton || !removeButton || !window.bootstrap?.Modal) return;

      modalSelect.replaceChildren(...[...veterinarianSelect.options].map((option) => option.cloneNode(true)));
      modalSelect.value = "";
      applyButton.disabled = true;
      modalSelect.onchange = () => {
        applyButton.disabled = !modalSelect.value;
      };

      const modal = window.bootstrap.Modal.getOrCreateInstance(modalElement);
      applyButton.onclick = () => {
        if (!modalSelect.value) return;
        veterinarianSelect.value = modalSelect.value;
        modal.hide();
        form.requestSubmit();
      };
      removeButton.onclick = () => {
        handledByVet.checked = false;
        updateEventForm();
        modal.hide();
        form.requestSubmit();
      };
      modalElement.addEventListener("shown.bs.modal", () => modalSelect.focus(), { once: true });
      modal.show();
    }, { capture: true });
    updateEventForm();
  });
}

function initVaccinationPresets(scope = document) {
  scope.querySelectorAll("[data-vaccination-preset]").forEach((select) => {
    if (select.dataset.bound === "1") return;
    select.dataset.bound = "1";
    select.addEventListener("change", () => {
      const form = select.closest("form");
      const target = form?.querySelector(select.dataset.vaccinationTarget || "");
      if (!(target instanceof HTMLInputElement)) return;
      if (select.value === "__custom__") {
        target.value = "";
        target.focus();
      } else if (select.value) {
        target.value = select.value;
      }
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}

function initVaccinationCompletion(scope = document) {
  const modalElement = document.querySelector("#vaccination-completion-modal");
  const modalForm = modalElement?.querySelector("[data-vaccination-completion-form]");
  const dateInput = modalElement?.querySelector("[data-vaccination-completion-date]");
  const title = modalElement?.querySelector("[data-vaccination-completion-title]");
  if (!modalElement || !modalForm || !dateInput || !title || !window.bootstrap?.Modal) return;

  scope.querySelectorAll("form[data-vaccination-completion]").forEach((form) => {
    if (form.dataset.vaccinationCompletionBound === "1") return;
    form.dataset.vaccinationCompletionBound = "1";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      const today = new Date();
      const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 10);
      modalForm.action = form.action;
      dateInput.value = localToday;
      dateInput.max = localToday;
      title.textContent = form.dataset.reminderTitle || "Impfung";

      modalElement.addEventListener("shown.bs.modal", () => dateInput.focus(), { once: true });
      window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
    }, { capture: true });
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
    document.body.className = doc.body.className;
    document.body.dataset.bsTheme = doc.body.dataset.bsTheme || "light";

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

window.HeartPetNavigation = { navigateTo };

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

function initTimelineToggles() {
  document.querySelectorAll("[data-timeline-more-toggle]").forEach((button) => {
    if (button.dataset.boundTimelineToggle === "1") return;
    const targetSelector = button.getAttribute("data-bs-target");
    const target = targetSelector ? document.querySelector(targetSelector) : null;
    if (!target) return;
    button.dataset.boundTimelineToggle = "1";
    target.addEventListener("shown.bs.collapse", () => {
      button.textContent = button.dataset.lessLabel || "Weniger anzeigen";
    });
    target.addEventListener("hidden.bs.collapse", () => {
      button.textContent = button.dataset.moreLabel || "Mehr anzeigen";
    });
  });
}

let updateStatusInitialized = false;

function initUpdateStatus() {
  if (updateStatusInitialized) return;
  const indicator = document.querySelector("[data-update-indicator]");
  if (!indicator) return;
  updateStatusInitialized = true;

  const latestVersion = document.querySelector("[data-update-latest-version]");
  const command = document.querySelector("[data-update-command]");
  const copyButton = document.querySelector("[data-update-copy]");

  fetch("/api/update-status", { headers: { Accept: "application/json" } })
    .then((response) => response.ok ? response.json() : null)
    .then((status) => {
      if (!status?.updateAvailable || !status.latestRevision) return;
      indicator.textContent = `Update ${status.latestRevision} verfügbar`;
      indicator.classList.remove("d-none");
      if (latestVersion) latestVersion.textContent = status.latestRevision;
    })
    .catch(() => {});

  copyButton?.addEventListener("click", async () => {
    const value = command?.textContent?.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      copyButton.textContent = "Kopiert";
    } catch {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
      copyButton.textContent = "Kopiert";
    }
  });
}

window.HeartPetFeatures?.register("veterinarian-contact", initVeterinarianContactPopover, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("species-autocomplete", initSpeciesAutocomplete, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("required-marks", initRequiredMarks, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("event-form", initEventFormBehavior, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("vaccination-presets", initVaccinationPresets, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("vaccination-completion", initVaccinationCompletion, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("bulk-selection", initBulkSelection, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("profile-upload", initProfileUploadAutoSubmit, { contexts: ["page", "fragment"] });
window.HeartPetFeatures?.register("animal-workspace", initAnimalWorkspace, { contexts: ["page"] });
window.HeartPetFeatures?.register("dashboard-customizer", () => window.HeartPetDashboardCustomizer?.init(), { contexts: ["page"] });
window.HeartPetFeatures?.register("timeline-toggles", initTimelineToggles, { contexts: ["page"] });
window.HeartPetFeatures?.register("update-status", initUpdateStatus, { contexts: ["page"] });
window.HeartPetFeatures?.register("pending-reminders", loadPendingReminders, { contexts: ["page"] });
window.HeartPetFeatures?.register("password-visibility", initPasswordVisibility, { contexts: ["page", "fragment"] });

function initPage() {
  try {
    sessionStorage.setItem("heartpet-nav-loaded", "1");
  } catch (error) {}

  initSoftNavigation();
  initMobileNavToggle();
  initToasts();
  initPasswordVisibility(document);
  window.HeartPetDrawer?.init();
  window.HeartPetFeatures?.init(document, { context: "page" });
  window.HeartPetDrawer?.openFromQuery();
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

  if (message) {
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
      titleElement.textContent = form.dataset.confirmProgressTitle || "Aktion wird ausgeführt";
      messageElement.classList.add("d-none");
      actionsElement.classList.add("d-none");
      progressElement.classList.remove("d-none");
      saveCurrentViewState();
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => form.submit()));
    };
    window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
    return;
  }

  if (form.dataset.drawerForm !== "true") {
    saveCurrentViewState();
  }
  const submitter = event.submitter;
  if (submitter instanceof HTMLButtonElement && !submitter.disabled && !submitter.name) {
    submitter.disabled = true;
    submitter.setAttribute("aria-busy", "true");
    submitter.classList.add("is-submitting");
    const originalText = submitter.textContent.trim();
    submitter.dataset.originalText = originalText;
    submitter.textContent = originalText ? `${originalText} …` : "Wird gespeichert …";
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
