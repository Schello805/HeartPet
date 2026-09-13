(function registerAnimalStatusFeature() {
  function init(scope = document) {
    scope.querySelectorAll("[data-status-workflow]").forEach((workflow) => {
      if (workflow.dataset.bound === "1") return;
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

      const update = () => {
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
        confirmWrap?.classList.toggle("d-none", !requiresConfirmation);
        if (confirmInput) {
          confirmInput.required = requiresConfirmation;
          if (!requiresConfirmation) {
            confirmInput.checked = false;
            confirmInput.setCustomValidity("");
          }
        }
        if (confirmLabel) confirmLabel.textContent = confirmLabels[selectedStatus] || "";

        const canChooseReminderClosure = requiresConfirmation && ["Vermittelt", "Verkauft"].includes(selectedStatus);
        remindersWrap?.classList.toggle("d-none", !canChooseReminderClosure);
        if (remindersInput && !canChooseReminderClosure) remindersInput.checked = false;

        if (!detailWrap) return;
        detailWrap.classList.toggle("d-none", selectedStatus === "Aktiv");
        detailWrap.querySelectorAll("[data-status-detail-panel]").forEach((panel) => {
          const active = panel.getAttribute("data-status-detail-panel") === selectedStatus;
          const requirements = detailRequirements[selectedStatus] || { nameRequired: false, dateRequired: false };
          panel.classList.toggle("d-none", !active);
          const nameInput = panel.querySelector("[data-status-detail-name]");
          const dateInput = panel.querySelector("[data-status-detail-date]");
          if (nameInput) nameInput.required = active && requirements.nameRequired;
          if (dateInput) dateInput.required = active && requirements.dateRequired;
        });
      };

      statusSelect?.addEventListener("change", update);
      update();
    });
  }

  window.HeartPetAnimalStatus = { init };
})();
