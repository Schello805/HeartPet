(function exposeFormValidation(global) {
  function resetCustomValidation(form) {
    form.querySelectorAll("input, select, textarea").forEach((field) => field.setCustomValidity(""));
  }

  function validateDateRelations(form) {
    const pairs = [
      ['input[name="birth_date"], input[name="animal_birth_date"]', 'input[name="intake_date"], input[name="animal_intake_date"]', "Das Aufnahmedatum darf nicht vor dem Geburtsdatum liegen."],
      ['input[name="start_date"]', 'input[name="end_date"]', "Das Enddatum darf nicht vor dem Startdatum liegen."],
      ['input[name="vaccination_date"]', 'input[name="next_due_date"]', "Die nächste Fälligkeit darf nicht vor dem Impfdatum liegen."],
    ];
    for (const [startSelector, endSelector, message] of pairs) {
      const start = form.querySelector(startSelector);
      const end = form.querySelector(endSelector);
      if (start && end && start.value && end.value && start.value > end.value) {
        end.setCustomValidity(message);
        return end;
      }
    }
    return null;
  }

  function validatePasswordConfirmation(form) {
    const password = form.querySelector('input[name="new_password"]');
    const confirmation = form.querySelector('input[name="new_password_confirm"]');
    if (!password || !confirmation || !password.value || !confirmation.value || password.value === confirmation.value) return null;
    confirmation.setCustomValidity("Die neuen Passwörter stimmen nicht überein.");
    return confirmation;
  }

  function applyGermanValidationMessages(form) {
    for (const field of form.querySelectorAll("input, select, textarea")) {
      if (field.validity.valueMissing || field.validity.typeMismatch || field.validity.badInput) {
        field.setCustomValidity(field.validity.valueMissing ? "Dieses Feld ist ein Pflichtfeld." : "Bitte gib einen gültigen Wert ein.");
        return field;
      }
    }
    const fieldError = validatePasswordConfirmation(form) || validateDateRelations(form);
    if (fieldError) return fieldError;
    const statusConfirm = form.querySelector("[data-status-confirm-input]");
    if (statusConfirm?.required && !statusConfirm.checked) {
      statusConfirm.setCustomValidity("Bitte bestätige den Statuswechsel.");
      return statusConfirm;
    }
    return null;
  }

  global.HeartPetFormValidation = { applyGermanValidationMessages, resetCustomValidation };
})(window);
