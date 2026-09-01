(function setupDashboardCustomizer(global) {
  const storageKey = "heartpet-dashboard-layout-v1";

  function init() {
    const root = document.querySelector("[data-dashboard-customizer]");
    const panel = root?.querySelector("[data-dashboard-customize-panel]");
    const toggle = root?.querySelector("[data-dashboard-customize-toggle]");
    const sections = [...document.querySelectorAll("[data-dashboard-section]")];
    if (!root || !panel || !toggle || !sections.length || root.dataset.boundCustomizer === "1") return;
    root.dataset.boundCustomizer = "1";

    const defaults = sections.map((section) => section.dataset.dashboardSection);
    let state = loadState(defaults);
    let editing = false;
    const save = () => localStorage.setItem(storageKey, JSON.stringify(state));
    const apply = () => sections.forEach((section) => {
      const id = section.dataset.dashboardSection;
      const hidden = state.hidden.includes(id);
      section.style.order = String(state.order.indexOf(id) + 1);
      section.classList.toggle("d-none", hidden && !editing);
      section.classList.toggle("dashboard-section-is-hidden", hidden && editing);
    });
    const renderControls = () => {
      sections.forEach((section) => section.querySelector(":scope > .dashboard-section-controls")?.remove());
      if (!editing) return;
      state.order.forEach((id, index) => {
        const section = sections.find((item) => item.dataset.dashboardSection === id);
        if (!section) return;
        section.prepend(createSectionControls({ section, id, index, state, save, apply, renderControls }));
      });
    };

    const help = document.createElement("span");
    help.className = "small text-body-secondary";
    help.textContent = "Abschnitte direkt an den Karten sortieren.";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn btn-sm btn-link";
    reset.textContent = "Standard wiederherstellen";
    reset.addEventListener("click", () => {
      state = { order: defaults, hidden: [] };
      save(); apply(); renderControls();
    });
    panel.replaceChildren(help, reset);
    toggle.addEventListener("click", () => {
      editing = !editing;
      panel.classList.toggle("d-none", !editing);
      toggle.textContent = editing ? "Anpassen schließen" : "⚙ Anpassen";
      toggle.setAttribute("aria-label", editing ? "Dashboard-Anpassung schließen" : "Dashboard anpassen");
      apply(); renderControls();
    });
    apply();
  }

  function loadState(defaults) {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved?.order) {
        return {
          order: [...saved.order.filter((id) => defaults.includes(id)), ...defaults.filter((id) => !saved.order.includes(id))],
          hidden: (saved.hidden || []).filter((id) => defaults.includes(id)),
        };
      }
    } catch {}
    return { order: defaults, hidden: [] };
  }

  function createSectionControls(context) {
    const { section, id, index, state, save, apply, renderControls } = context;
    const title = section.dataset.dashboardTitle || id;
    const row = document.createElement("div");
    row.className = "dashboard-section-controls";
    const label = document.createElement("strong");
    label.textContent = title;
    const actions = document.createElement("div");
    actions.className = "btn-group btn-group-sm";
    [["↑", -1, "Nach oben"], ["↓", 1, "Nach unten"]].forEach(([text, direction, actionLabel]) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "btn btn-outline-secondary"; button.textContent = text;
      button.title = actionLabel; button.setAttribute("aria-label", `${title} ${actionLabel}`);
      button.disabled = index + direction < 0 || index + direction >= state.order.length;
      button.addEventListener("click", () => {
        const next = index + direction;
        [state.order[index], state.order[next]] = [state.order[next], state.order[index]];
        save(); apply(); renderControls();
      });
      actions.append(button);
    });
    const visibility = document.createElement("button");
    visibility.type = "button"; visibility.className = "btn btn-outline-secondary";
    visibility.textContent = state.hidden.includes(id) ? "Einblenden" : "Ausblenden";
    visibility.setAttribute("aria-label", `${title} ${visibility.textContent}`);
    visibility.addEventListener("click", () => {
      state.hidden = state.hidden.includes(id) ? state.hidden.filter((item) => item !== id) : [...state.hidden, id];
      save(); apply(); renderControls();
    });
    actions.append(visibility); row.append(label, actions);
    return row;
  }

  global.HeartPetDashboardCustomizer = { init };
})(window);
