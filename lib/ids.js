// Deterministic, convergent IDs. Shared by browser (washstore.js) and node tests.
// Two users with the same appliance/program produce the same device/profile id,
// so their contributions aggregate without a server.
export function lc(s) {
  return String(s == null ? '' : s).toLowerCase();
}

// Lowercase, trim, collapse any run of separator chars to a single hyphen.
// NFKD + a combining-mark strip fold diacritics, so an accented spelling and its
// plain-ASCII equivalent converge to the same token. Letters/numbers of ANY script are
// kept (Unicode-aware), so a non-Latin name (e.g. Cyrillic/CJK) keeps its own distinct
// token instead of collapsing to an empty string and colliding with every other one.
export function normalizeToken(s) {
  return lc(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining diacritics
    .replace(/[^\p{L}\p{N}]+/gu, '-')  // keep letters/numbers of any script
    .replace(/^-+|-+$/g, '');
}

export function deviceId(applianceType, brand, model) {
  return [normalizeToken(applianceType), normalizeToken(brand), normalizeToken(model)].join('__');
}

export function profileId(devId, program) {
  return `${devId}__${normalizeToken(program)}`;
}
