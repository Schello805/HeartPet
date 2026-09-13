(function registerHeartPetFeatureRegistry() {
  const features = [];
  const names = new Set();

  function register(name, init, options = {}) {
    if (!name || typeof init !== "function" || names.has(name)) return;
    names.add(name);
    features.push({
      name,
      init,
      contexts: new Set(options.contexts || ["page"]),
    });
  }

  function init(scope = document, options = {}) {
    const context = options.context || "page";
    features.forEach((feature) => {
      if (!feature.contexts.has(context)) return;
      feature.init(scope, { context });
    });
  }

  window.HeartPetFeatures = { register, init };
})();
