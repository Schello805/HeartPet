(function initPasswordVisibilityFeature() {
  function initPasswordVisibility(scope = document) {
    scope.querySelectorAll('input[type="password"]:not([data-password-visibility-ready])').forEach((input) => {
      input.dataset.passwordVisibilityReady = "1";
      const wrapper = document.createElement("div");
      wrapper.className = "password-input-wrap";
      input.parentNode.insertBefore(wrapper, input);
      wrapper.append(input);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "password-visibility-toggle";
      button.setAttribute("aria-label", "Passwort anzeigen");
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 12s3.5-6 9.7-6 9.7 6 9.7 6-3.5 6-9.7 6-9.7-6-9.7-6Z"/><circle cx="12" cy="12" r="2.8"/></svg>';
      button.addEventListener("click", () => {
        const visible = input.type === "text";
        input.type = visible ? "password" : "text";
        button.setAttribute("aria-label", visible ? "Passwort anzeigen" : "Passwort verbergen");
        button.setAttribute("aria-pressed", String(!visible));
        input.focus({ preventScroll: true });
      });
      wrapper.append(button);
    });
  }

  window.HeartPetPasswordVisibility = { init: initPasswordVisibility };
})();
