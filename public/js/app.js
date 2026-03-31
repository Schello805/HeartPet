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
