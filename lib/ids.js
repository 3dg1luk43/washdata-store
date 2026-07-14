// Deterministic, convergent IDs. Shared by browser (washstore.js) and node tests.
// Two users with the same appliance/program produce the same device/profile id,
// so their contributions aggregate without a server.
export function lc(s) {
  return String(s == null ? '' : s).toLowerCase();
}

// Lowercase, trim, collapse any run of non-alphanumeric chars to a single hyphen.
export function normalizeToken(s) {
  return lc(s)
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deviceId(applianceType, brand, model) {
  return [normalizeToken(applianceType), normalizeToken(brand), normalizeToken(model)].join('__');
}

export function profileId(devId, program) {
  return `${devId}__${normalizeToken(program)}`;
}
