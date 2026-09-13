function createReminderDeliveryService({ repository, channels }) {
  async function processDue(now, settings, hooks = {}) {
    for (const reminder of repository.listDue(now)) {
      const delivery = { status: "skipped", error: "", notified: false };
      try {
        for (const [name, channel] of Object.entries(channels)) {
          if (!channel.selected(reminder) || !channel.enabled(settings)) continue;
          await channel.sendReminder(settings, reminder);
          hooks.onNotification?.({
            channel: name,
            type: "reminder",
            recipient: channel.recipient(settings),
            subject: `Erinnerung: ${reminder.title}`,
            status: "sent",
            error: "",
            reminder,
          });
          delivery.notified = true;
        }
        delivery.status = delivery.notified ? "sent" : "skipped";
      } catch (error) {
        delivery.status = "error";
        delivery.error = error.message;
        hooks.onNotification?.({
          channel: activeChannelName(settings, reminder),
          type: "reminder",
          recipient: activeRecipient(settings, reminder),
          subject: `Erinnerung: ${reminder.title}`,
          status: "error",
          error: error.message,
          reminder,
        });
      }
      repository.updateDelivery(reminder.id, delivery);
    }
  }

  function activeChannelName(settings, reminder) {
    const entry = Object.entries(channels).find(([, channel]) =>
      channel.selected(reminder) && channel.enabled(settings));
    return entry?.[0] || "none";
  }

  function activeRecipient(settings, reminder) {
    const channel = Object.values(channels).find((candidate) =>
      candidate.selected(reminder) && candidate.enabled(settings));
    return channel?.recipient(settings) || "";
  }

  return { processDue };
}

module.exports = { createReminderDeliveryService };
