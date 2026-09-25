(function registerQuickEntry() {
  function init(scope = document) {
    scope.querySelectorAll("[data-quick-entry]").forEach((container) => {
      if (container.dataset.quickEntryBound === "1") return;
      container.dataset.quickEntryBound = "1";
      const select = container.querySelector("[data-quick-entry-animal]");
      const links = [...container.querySelectorAll("[data-quick-entry-kind]")];
      if (!select || !links.length) return;

      const updateLinks = () => {
        const animalId = String(select.value || "").replace(/\D/g, "");
        links.forEach((link) => {
          const kind = link.dataset.quickEntryKind;
          link.href = animalId ? `/animals/${animalId}/events/new?kind=${encodeURIComponent(kind)}` : "#";
          link.classList.toggle("disabled", !animalId);
          link.setAttribute("aria-disabled", animalId ? "false" : "true");
        });
      };

      select.addEventListener("change", updateLinks);
      links.forEach((link) => {
        link.addEventListener("click", () => {
          const modal = link.closest(".modal");
          if (modal && window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modal).hide();
          }
        });
      });
      updateLinks();
    });
  }

  window.HeartPetFeatures?.register("quick-entry", init, { contexts: ["page"] });
})();
