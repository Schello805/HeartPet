const FIELD_SCHEMAS = Object.freeze({
  categoryName: { required: true, minLength: 2, maxLength: 80 },
  speciesName: { required: true, minLength: 2, maxLength: 80 },
  vaccinationName: { required: true, minLength: 2, maxLength: 120 },
  veterinarianName: { required: true, minLength: 2, maxLength: 120 },
  veterinarianStreet: { minLength: 3, maxLength: 120, pattern: /^[A-Za-zÄÖÜäöüß0-9 .,\-/]{3,120}$/ },
  veterinarianPostalCode: { minLength: 3, maxLength: 12, pattern: /^[A-Za-z0-9 -]{3,12}$/ },
  veterinarianCity: { minLength: 2, maxLength: 80, pattern: /^[A-Za-zÄÖÜäöüß0-9 .'\-]{2,80}$/ },
  veterinarianCountry: { minLength: 2, maxLength: 80, pattern: /^[A-Za-zÄÖÜäöüß .'\-]{2,80}$/ },
  veterinarianEmail: { maxLength: 254, type: "email" },
  veterinarianPhone: { minLength: 6, maxLength: 30, pattern: /^[+0-9()/\.\-\s]{6,30}$/ },
  veterinarianNotes: { maxLength: 4000 },
});

function normalizeText(value) {
  return String(value || "").trim();
}

function isValidEmail(value) {
  const email = normalizeText(value);
  if (!email || email.length > FIELD_SCHEMAS.veterinarianEmail.maxLength || /\s/.test(email)) return false;
  const separator = email.lastIndexOf("@");
  if (separator < 1 || separator === email.length - 1 || email.indexOf("@") !== separator) return false;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".")
    && domain.length <= 253 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

function validateText(value, schema, label) {
  const text = normalizeText(value);
  if (schema.required && !text) return `${label} ist erforderlich.`;
  if (!text) return "";
  if (schema.minLength && text.length < schema.minLength) return `${label} ist zu kurz.`;
  if (schema.maxLength && text.length > schema.maxLength) return `${label} ist zu lang.`;
  if (schema.type === "email" && !isValidEmail(text)) return `${label} ist ungültig.`;
  if (schema.pattern && !schema.pattern.test(text)) return `${label} enthält ungültige Zeichen.`;
  return "";
}

function normalizeVeterinarianPayload(source, prefix = "") {
  const get = (field) => normalizeText(source?.[`${prefix}${field}`]);
  return {
    street: get("street"),
    postal_code: get("postal_code"),
    city: get("city"),
    country: get("country"),
    email: get("email"),
    phone: get("phone"),
    notes: get("notes"),
  };
}

function validateVeterinarian(payload, name = "") {
  const checks = [
    [name, FIELD_SCHEMAS.veterinarianName, "Name"],
    [payload.street, FIELD_SCHEMAS.veterinarianStreet, "Straße/Hausnummer"],
    [payload.postal_code, FIELD_SCHEMAS.veterinarianPostalCode, "PLZ"],
    [payload.city, FIELD_SCHEMAS.veterinarianCity, "Ort"],
    [payload.country, FIELD_SCHEMAS.veterinarianCountry, "Land"],
    [payload.email, FIELD_SCHEMAS.veterinarianEmail, "E-Mail"],
    [payload.phone, FIELD_SCHEMAS.veterinarianPhone, "Telefon"],
    [payload.notes, FIELD_SCHEMAS.veterinarianNotes, "Notizen"],
  ];
  for (const [value, schema, label] of checks) {
    const error = validateText(value, schema, label);
    if (error) return error;
  }
  return "";
}

function htmlConstraints(schemaName) {
  const schema = FIELD_SCHEMAS[schemaName] || {};
  return {
    required: Boolean(schema.required),
    minlength: schema.minLength || null,
    maxlength: schema.maxLength || null,
    type: schema.type || "text",
  };
}

module.exports = {
  FIELD_SCHEMAS,
  htmlConstraints,
  isValidEmail,
  normalizeText,
  normalizeVeterinarianPayload,
  validateText,
  validateVeterinarian,
};
