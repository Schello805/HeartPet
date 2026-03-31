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
    if (!payload.count) {
      return;
    }

    const existing = document.querySelector(".floating-reminder");
    if (!existing) {
      const banner = document.createElement("div");
      banner.className = "floating-reminder";
      banner.innerHTML = `<strong>${payload.count} offene Erinnerung(en)</strong><span>Bitte im Dashboard oder in der Tierakte prüfen.</span>`;
      bannerTarget.after(banner);
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

window.addEventListener("load", loadPendingReminders);

window.addEventListener("load", () => {
  const toggle = document.querySelector(".mobile-nav-toggle");
  const sidebar = document.querySelector(".sidebar");
  if (!toggle || !sidebar) {
    return;
  }

  toggle.addEventListener("click", () => {
    const nextState = !document.body.classList.contains("nav-open");
    document.body.classList.toggle("nav-open", nextState);
    toggle.setAttribute("aria-expanded", nextState ? "true" : "false");
  });
});

window.addEventListener("load", () => {
  const input = document.querySelector("[data-species-autocomplete='true']");
  const datalist = document.querySelector("#species-suggestions");
  if (!input || !datalist) {
    return;
  }

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

window.addEventListener("load", () => {
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
});

window.addEventListener("load", () => {
  document.querySelectorAll(".profile-upload-input").forEach((input) => {
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
});

window.addEventListener("load", () => {
  const form = document.querySelector("[data-event-form]");
  if (!form) {
    return;
  }

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

document.addEventListener("click", (event) => {
  const row = event.target.closest(".table-row-link");
  if (!row) {
    return;
  }

  const interactive = event.target.closest("a, button, input, select, textarea, label");
  if (interactive) {
    return;
  }

  window.location.href = row.dataset.href;
});

document.addEventListener("keydown", (event) => {
  const row = event.target.closest(".table-row-link");
  if (!row) {
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    window.location.href = row.dataset.href;
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
  }
});

document.addEventListener("input", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) {
    return;
  }
  field.setCustomValidity("");
});
