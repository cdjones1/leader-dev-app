// ============================================================
// ON-SHIFT REP RULES
// Pure functions (no database access) so the rules can be tested
// directly and used by the routes without being re-implemented.
// ============================================================
const MAX_REQUIRED_REPS = 20;

// Blank/missing means "use the default of 1". Returns null if the
// value was given but isn't a whole number from 1 to MAX_REQUIRED_REPS.
function parseRequiredReps(value) {
  if (value === undefined || value === null || value === '') return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REQUIRED_REPS) return null;
  return n;
}

// A rep's date is a plain "YYYY-MM-DD" string. Must be a real
// calendar date and not in the future (one day of slack so someone
// ahead of the server's UTC clock isn't wrongly rejected).
function isValidRepDate(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== value) return false; // rejects things like 2026-02-31
  if (d.getTime() > now + 24 * 60 * 60 * 1000) return false;
  return true;
}

// A signed-off rep carries the leader's PRINTED name plus a drawn
// signature. There is no login for the leader, so this works like a
// paper sign-off sheet: it records what was written. One sanity check
// keeps it honest - the printed name can't be the developee's own.
function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateSignerName(name, developeeName) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, reason: "Print the leader's name" };
  }
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2) return { ok: false, reason: "Print the leader's full name" };
  if (clean.length > 100) return { ok: false, reason: 'That name is too long' };
  if (normalizeName(clean) === normalizeName(developeeName)) {
    return { ok: false, reason: 'A rep has to be signed off by a leader, not by the person who did it' };
  }
  return { ok: true, name: clean };
}

// The drawn signature arrives as a PNG data URL. Only that exact shape
// is accepted (so nothing else can ever be stored and later shown as an
// image), and it has to be a sane size.
const MAX_SIGNATURE_LENGTH = 300000;
function isValidSignatureImage(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 100 || value.length > MAX_SIGNATURE_LENGTH) return false;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function countSigned(reps) {
  return (reps || []).filter((r) => r.signedOffAt).length;
}

// An item passes once it has at least its required number of
// SIGNED-OFF reps (logged-but-unsigned reps don't count).
function isCategoryPassed(category) {
  return countSigned(category.reps) >= category.requiredReps;
}

// The whole stage is done when it has items and every one passed.
function isStageDone(categories) {
  return categories.length > 0 && categories.every((c) => c.passed);
}

module.exports = { MAX_REQUIRED_REPS, MAX_SIGNATURE_LENGTH, parseRequiredReps, isValidRepDate, validateSignerName, isValidSignatureImage, countSigned, isCategoryPassed, isStageDone };
