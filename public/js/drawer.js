(function registerHeartPetDrawer() {
  const { applyGermanValidationMessages, resetCustomValidation } = window.HeartPetFormValidation || {};

  function initFragment(drawerBody) {
    window.HeartPetFeatures?.init(drawerBody, { context: "fragment" });
  }

  function showToastFromDocument(doc) {
    const flash = doc.querySelector(".flash");
    if (!flash) return;
    const type = flash.classList.contains("flash-error") ? "error" : "success";
    const message = flash.querySelector(".toast-message")?.textContent?.trim() || flash.textContent.trim();
    const title = flash.querySelector(".toast-title")?.textContent?.trim() || "";
    window.HeartPetToasts?.mount({ type, message, title });
  }

  function initForms(scope = document) {
    scope.querySelectorAll("form[data-drawer-form]").forEach((form) => {
      if (form.dataset.bound === "1") return;
      form.dataset.bound = "1";

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        resetCustomValidation?.(form);
        const invalidField = applyGermanValidationMessages?.(form);
        if (invalidField) {
          invalidField.reportValidity();
          return;
        }

        try {
          const formData = new FormData(form);
          const useMultipart = Boolean(form.querySelector('input[type="file"]'));
          const response = await fetch(form.action, {
            method: form.method || "POST",
            body: useMultipart ? formData : new URLSearchParams(formData),
            headers: { "X-Requested-With": "heartpet-drawer" },
            credentials: "same-origin",
          });

          const text = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(text, "text/html");
          const fragment = doc.querySelector("[data-drawer-fragment]");
          const drawerBody = document.querySelector("[data-drawer-body]");
          showToastFromDocument(doc);

          if (fragment && drawerBody) {
            drawerBody.innerHTML = "";
            drawerBody.appendChild(fragment.cloneNode(true));
            const drawerTitle = document.querySelector("#drawer-title");
            if (drawerTitle) {
              const title = fragment.getAttribute("data-drawer-title") || doc.title || "Bearbeiten";
              drawerTitle.textContent = title.replace(/\s+\|.*$/, "");
            }
            init();
            initFragment(drawerBody);
            return;
          }

          close();
          const targetUrl = new URL(response.url || window.location.href, window.location.href);
          window.HeartPetNavigation?.navigateTo(targetUrl, {
            push: targetUrl.toString() !== window.location.href,
            scrollTop: false,
          });
        } catch (error) {
          console.error("Drawer-Formular konnte nicht gespeichert werden", error);
          form.dataset.bound = "fallback";
          HTMLFormElement.prototype.submit.call(form);
        }
      });
    });
  }

  async function open(urlLike) {
    let targetUrl;
    try {
      targetUrl = new URL(urlLike, window.location.href);
      if (targetUrl.origin !== window.location.origin) {
        throw new Error("Drawer-Ziel liegt außerhalb von HeartPet.");
      }
    } catch (error) {
      console.error("Ungültiges Drawer-Ziel", error);
      return;
    }

    const drawer = document.getElementById("app-drawer");
    const drawerBody = drawer?.querySelector("[data-drawer-body]");
    const drawerTitle = drawer?.querySelector("#drawer-title");
    if (!drawer || !drawerBody || !drawerTitle) {
      window.location.assign(targetUrl.href);
      return;
    }

    try {
      if (!targetUrl.searchParams.get("return_to")) {
        targetUrl.searchParams.set("return_to", `${window.location.pathname}${window.location.search}${window.location.hash}`);
      }

      window.bootstrap?.Offcanvas?.getOrCreateInstance(drawer)?.show();
      drawerBody.innerHTML = '<div class="panel"><p class="empty-state">Lade Formular ...</p></div>';

      const response = await fetch(targetUrl.toString(), {
        headers: { "X-Requested-With": "heartpet-drawer" },
        credentials: "same-origin",
      });
      if (!response.ok) {
        window.location.assign(targetUrl.href);
        return;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(await response.text(), "text/html");
      const fragment = doc.querySelector("[data-drawer-fragment]");
      if (!fragment) {
        window.location.assign(targetUrl.href);
        return;
      }

      drawerBody.innerHTML = "";
      drawerBody.appendChild(fragment.cloneNode(true));
      drawerTitle.textContent = fragment.getAttribute("data-drawer-title") || "Bearbeiten";
      init();
      initFragment(drawerBody);
    } catch (error) {
      console.error("Drawer konnte nicht geladen werden", error);
      window.location.assign(targetUrl.href);
    }
  }

  function close() {
    const drawer = document.getElementById("app-drawer");
    const drawerBody = drawer?.querySelector("[data-drawer-body]");
    if (!drawer || !drawerBody) return;
    window.bootstrap?.Offcanvas?.getOrCreateInstance(drawer)?.hide();
  }

  function init() {
    document.querySelectorAll("a[data-drawer]").forEach((anchor) => {
      if (anchor.dataset.bound === "1") return;
      anchor.dataset.bound = "1";
      anchor.dataset.noSoftNav = "true";
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        open(anchor.href);
      });
    });

    document.querySelectorAll("[data-drawer-close]").forEach((button) => {
      if (button.dataset.bound === "1") return;
      button.dataset.bound = "1";
      button.addEventListener("click", () => close());
    });

    if (!document.body.dataset.drawerEscBound) {
      document.body.dataset.drawerEscBound = "1";
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") close();
      });
    }

    const drawer = document.getElementById("app-drawer");
    if (drawer && drawer.dataset.hiddenBound !== "1") {
      drawer.dataset.hiddenBound = "1";
      drawer.addEventListener("hidden.bs.offcanvas", () => {
        const drawerBody = drawer.querySelector("[data-drawer-body]");
        if (drawerBody) drawerBody.innerHTML = "";
      });
    }

    initForms();
  }

  function openFromQuery() {
    const url = new URL(window.location.href);
    const drawerPath = url.searchParams.get("drawer");
    if (!drawerPath || document.body.dataset.autoDrawerHandled === drawerPath) return;

    document.body.dataset.autoDrawerHandled = drawerPath;
    url.searchParams.delete("drawer");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    open(drawerPath);
  }

  window.HeartPetDrawer = { init, open, close, openFromQuery, initForms };
})();
