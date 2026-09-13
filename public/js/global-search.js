(function registerGlobalSearchFeature() {
  const escapeHtml = (value) => String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  function init() {
    document.querySelectorAll("[data-global-search-autocomplete='true']").forEach((input) => {
      if (input.dataset.bound === "1") return;
      input.dataset.bound = "1";
      const field = input.closest(".search-autocomplete-field") || input.parentElement;
      if (!field) return;

      let list = field.querySelector(".global-search-suggest");
      if (!list) {
        list = document.createElement("div");
        list.className = "global-search-suggest";
        field.appendChild(list);
      }

      let timer = null;
      let latestQuery = "";
      const hide = () => {
        list.innerHTML = "";
        list.classList.remove("visible");
      };

      input.addEventListener("input", () => {
        window.clearTimeout(timer);
        const query = input.value.trim();
        latestQuery = query;
        if (query.length < 2) return hide();
        timer = window.setTimeout(async () => {
          try {
            const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(query)}`);
            if (!response.ok) return hide();
            const payload = await response.json();
            if (latestQuery !== query) return;
            if (!Array.isArray(payload.results) || payload.results.length === 0) return hide();
            list.innerHTML = payload.results.map((item) => `
              <a class="global-search-suggest-item" href="${escapeHtml(item.href)}">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.kind)} | ${escapeHtml(item.subtitle || "-")}</span>
              </a>
            `).join("");
            list.classList.add("visible");
          } catch (error) {
            console.error("Globale Suche konnte nicht geladen werden", error);
            hide();
          }
        }, 140);
      });
      input.addEventListener("blur", () => window.setTimeout(() => {
        if (!list.matches(":hover")) hide();
      }, 120));
      input.addEventListener("focus", () => {
        if (input.value.trim().length >= 2 && list.children.length > 0) list.classList.add("visible");
      });
    });
  }

  window.HeartPetGlobalSearch = { init };
})();
