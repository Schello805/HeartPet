function buildReminderEmailHtml(payload) {
  const {
    appName,
    logoUrl,
    animalName,
    title,
    type,
    dueLabel,
    notes,
    animalUrl,
    dashboardUrl,
    completeUrl,
  } = payload;

  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const cardRow = (label, value) => `
    <tr>
      <td style="padding:8px 0;color:#5f7b6f;font-size:13px;">${safe(label)}</td>
      <td style="padding:8px 0;color:#1d3128;font-size:14px;font-weight:600;text-align:right;">${safe(value)}</td>
    </tr>
  `;

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div>
                      <div style="font-size:22px;font-weight:800;color:#1d3128;margin-top:4px;">Erinnerung</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 20px;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#31483f;">
                  Für <strong>${safe(animalName || "ein Tier")}</strong> ist eine Erinnerung eingegangen.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${cardRow("Titel", title)}
                  ${cardRow("Fälligkeit", dueLabel)}
                  ${cardRow("Typ", type)}
                </table>
                ${notes ? `<div style="margin-top:14px;padding:12px;border:1px solid #d8ebdf;background:#f6fcf9;border-radius:8px;color:#395247;font-size:13px;line-height:1.5;"><strong>Hinweis:</strong><br/>${safe(notes).replaceAll("\n", "<br/>")}</div>` : ""}
                <div style="margin-top:18px;display:flex;flex-wrap:wrap;gap:10px;">
                  ${completeUrl ? `<a href="${safe(completeUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:#edf7f2;color:#1d3128;border:1px solid #cfe5d8;text-decoration:none;font-weight:700;font-size:13px;">Als erledigt markieren</a>` : ""}
                  ${animalUrl ? `<a href="${safe(animalUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">Zur Tierakte</a>` : ""}
                  ${dashboardUrl ? `<a href="${safe(dashboardUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:#edf7f2;color:#1d3128;border:1px solid #cfe5d8;text-decoration:none;font-weight:700;font-size:13px;">Dashboard</a>` : ""}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #e1f0e8;background:#f8fdfb;">
                <div style="font-size:12px;color:#6f897d;line-height:1.5;">
                  Diese Nachricht wurde automatisch von ${safe(appName)} versendet.<br/>
                  Wenn bereits erledigt, kannst du die Erinnerung in der Tierakte als erledigt markieren.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

function buildUserInviteEmailHtml(payload) {
  const { appName, logoUrl, name, email, role, inviteUrl } = payload;

  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const dataRow = (label, value) => `
    <tr>
      <td style="padding:7px 0;color:#5f7b6f;font-size:13px;">${safe(label)}</td>
      <td style="padding:7px 0;color:#1d3128;font-size:14px;font-weight:600;text-align:right;">${safe(value)}</td>
    </tr>
  `;

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div>
                      <div style="font-size:22px;font-weight:800;color:#1d3128;margin-top:4px;">Zugang eingerichtet</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 20px;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#31483f;">
                  Hallo <strong>${safe(name || "Nutzer")}</strong>, für dich wurde ein Zugang in <strong>${safe(appName)}</strong> angelegt.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${dataRow("Name", name || "-")}
                  ${dataRow("E-Mail", email || "-")}
                  ${dataRow("Rolle", role || "-")}
                </table>
                ${inviteUrl ? `<div style="margin-top:18px;"><a href="${safe(inviteUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">Passwort festlegen</a></div>` : ""}
                <div style="margin-top:14px;padding:12px;border:1px solid #d8ebdf;background:#f6fcf9;border-radius:8px;color:#395247;font-size:13px;line-height:1.5;">
                  <strong>Wichtig:</strong> Lege zuerst dein eigenes Passwort fest. Erst danach kannst du dich einloggen.
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 20px;border-top:1px solid #e1f0e8;background:#f8fdfb;">
                <div style="font-size:12px;color:#6f897d;line-height:1.5;">
                  Diese Nachricht wurde automatisch von ${safe(appName)} versendet.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

function buildUserCreatedAdminEmailHtml(payload) {
  const { appName, logoUrl, name, email, role, createdBy, usersUrl } = payload;
  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const row = (label, value) => `
    <tr>
      <td style="padding:7px 0;color:#5f7b6f;font-size:13px;">${safe(label)}</td>
      <td style="padding:7px 0;color:#1d3128;font-size:14px;font-weight:600;text-align:right;">${safe(value)}</td>
    </tr>
  `;

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
          <tr><td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
              <td><div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div><div style="font-size:22px;font-weight:800;margin-top:4px;">Neuer Benutzer angelegt</div></td>
              <td align="right">${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:18px 20px;">
            <p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#31483f;">In <strong>${safe(appName)}</strong> wurde ein neuer Zugang eingerichtet.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              ${row("Name", name)}${row("E-Mail", email)}${row("Rolle", role)}${row("Angelegt von", createdBy)}
            </table>
            <div style="margin-top:18px;"><a href="${safe(usersUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#fff;text-decoration:none;font-weight:700;font-size:13px;">Benutzer verwalten</a></div>
          </td></tr>
          <tr><td style="padding:14px 20px;border-top:1px solid #e1f0e8;background:#f8fdfb;font-size:12px;color:#6f897d;line-height:1.5;">Diese Sicherheitsinformation wurde automatisch von ${safe(appName)} versendet.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim();
}

function buildEmailChangeConfirmationHtml(payload) {
  const { appName, logoUrl, name, newEmail, confirmUrl } = payload;
  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div>
                      <div style="font-size:22px;font-weight:800;color:#1d3128;margin-top:4px;">E-Mail bestätigen</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 20px;">
                <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#31483f;">
                  Hallo <strong>${safe(name)}</strong>, bitte bestätige die Änderung auf <strong>${safe(newEmail)}</strong>.
                </p>
                <a href="${safe(confirmUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">E-Mail jetzt bestätigen</a>
                <div style="margin-top:14px;padding:12px;border:1px solid #d8ebdf;background:#f6fcf9;border-radius:8px;color:#395247;font-size:13px;line-height:1.5;">
                  Erst nach Klick auf den Button wird die neue E-Mail-Adresse in HeartPet übernommen.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

function buildDailyDigestEmailHtml(payload) {
  const { appName, logoUrl, dashboardUrl, generatedAt, counts, rows } = payload;
  const safe = (value) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const tableRows = rows.length
    ? rows
        .map(
          (item) => `
            <tr>
              <td style="padding:8px 6px;border-bottom:1px solid #e7f2ec;">${safe(item.dueLabel)}</td>
              <td style="padding:8px 6px;border-bottom:1px solid #e7f2ec;">${safe(item.animal_name || "Ohne Tier")}</td>
              <td style="padding:8px 6px;border-bottom:1px solid #e7f2ec;">${safe(item.title)}</td>
              <td style="padding:8px 6px;border-bottom:1px solid #e7f2ec;">${safe(item.reminder_type || "Erinnerung")}</td>
            </tr>
          `
        )
        .join("")
    : `<tr><td colspan="4" style="padding:10px 6px;color:#5f7b6f;">Keine offenen Erinnerungen.</td></tr>`;

  return `
<!doctype html>
<html lang="de">
  <body style="margin:0;padding:0;background:#f2faf6;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#1d3128;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2faf6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:700px;background:#fcfffd;border:1px solid #cfe5d8;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(180deg,#f2fbf6 0%,#eaf7f0 100%);border-bottom:1px solid #cfe5d8;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-size:12px;color:#5f7b6f;letter-spacing:.08em;text-transform:uppercase;">${safe(appName)}</div>
                      <div style="font-size:22px;font-weight:800;color:#1d3128;margin-top:4px;">Tageszusammenfassung</div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${logoUrl ? `<img src="${safe(logoUrl)}" alt="${safe(appName)} Logo" style="width:64px;height:64px;object-fit:contain;" />` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 20px;">
                <p style="margin:0 0 12px 0;color:#31483f;font-size:14px;">Stand: <strong>${safe(generatedAt)}</strong></p>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px 0;">
                  <span style="padding:6px 10px;border-radius:999px;background:#ffe9e6;color:#7a2f27;font-weight:700;font-size:12px;">Überfällig: ${safe(counts.overdue)}</span>
                  <span style="padding:6px 10px;border-radius:999px;background:#fff4d6;color:#7b5b16;font-weight:700;font-size:12px;">Heute: ${safe(counts.today)}</span>
                  <span style="padding:6px 10px;border-radius:999px;background:#eaf7f0;color:#1d563e;font-weight:700;font-size:12px;">Nächste 3 Tage: ${safe(counts.nextDays)}</span>
                </div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;border:1px solid #d8ebdf;border-radius:8px;overflow:hidden;">
                  <thead>
                    <tr style="background:#f6fcf9;color:#345146;">
                      <th align="left" style="padding:8px 6px;">Zeit</th>
                      <th align="left" style="padding:8px 6px;">Tier</th>
                      <th align="left" style="padding:8px 6px;">Titel</th>
                      <th align="left" style="padding:8px 6px;">Typ</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                </table>
                ${dashboardUrl ? `<div style="margin-top:14px;"><a href="${safe(dashboardUrl)}" style="display:inline-block;padding:10px 14px;border-radius:7px;background:linear-gradient(180deg,#42b084 0%,#2e9a6f 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;">Zum Dashboard</a></div>` : ""}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

module.exports = {
  buildReminderEmailHtml,
  buildUserInviteEmailHtml,
  buildUserCreatedAdminEmailHtml,
  buildEmailChangeConfirmationHtml,
  buildDailyDigestEmailHtml,
};
