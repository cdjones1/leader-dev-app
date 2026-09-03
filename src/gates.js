// ============================================================
// GATE POSITION HELPERS
// A plan's assessment/review gates always land at the halfway
// point and at the very end, whatever the module count is.
// Centralized here so every file that needs this math agrees on
// it, instead of each hardcoding "4" and "8" separately.
// ============================================================

// For an 8-module plan: midpoint = 4. For a 6-module plan: midpoint = 3.
// For an odd count like 7: midpoint = 4 (first block gets the extra module).
function midpointModule(moduleCount) {
  return Math.ceil(moduleCount / 2);
}

// Returns which gate (if any) sits right after this module, or null
// if this module isn't a gate point at all.
function gateAfterModule(sequenceOrder, moduleCount) {
  if (sequenceOrder === midpointModule(moduleCount)) return 'AFTER_MODULE_4'; // the enum value name is historical - it really just means "the midpoint gate"
  if (sequenceOrder === moduleCount) return 'AFTER_MODULE_8'; // "the final gate"
  return null;
}

module.exports = { midpointModule, gateAfterModule };
