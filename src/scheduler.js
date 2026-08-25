// ============================================================
// THE MODULE LOCK SCHEDULER
// ============================================================
// This is the riskiest piece of the whole system, so here's the
// reasoning in plain terms:
//
// Every few minutes, this function asks the database one simple
// question: "which modules are OPEN and past their due date?"
// For each one it finds, it locks it and writes a permanent
// record of that lock.
//
// Why polling instead of a precisely-timed alarm per module?
// Because polling is nearly impossible to get wrong in a way that
// LOSES a lock. If the server restarts, or this function is slow,
// or two checks overlap - it just catches up on the next run.
// A missed lock (a module that should have locked but silently
// didn't) is a much worse failure than a lock landing a few
// minutes late, and polling structurally can't have that failure
// mode. A precise per-module alarm can.
// ============================================================
const prisma = require('./db');

async function lockOverdueModules() {
  const now = new Date();

  // Find every module that is currently open and past its due date
  const overdueModules = await prisma.module.findMany({
    where: {
      status: 'OPEN',
      dueAt: { lt: now },
    },
  });

  if (overdueModules.length === 0) {
    return; // nothing to do - the common case, most runs find nothing
  }

  for (const module of overdueModules) {
    // Lock it and write the audit event together.
    // If this fails partway, the next run picks it back up -
    // that's the whole point of polling instead of a one-shot timer.
    await prisma.module.update({
      where: { id: module.id },
      data: { status: 'LOCKED', lockedAt: now },
    });

    await prisma.moduleEvent.create({
      data: {
        moduleId: module.id,
        eventType: 'LOCKED',
        actorId: null, // null = the system did this automatically, not a person
      },
    });

    console.log(`[scheduler] Locked module ${module.id} (was due ${module.dueAt.toISOString()})`);
  }
}

// Runs the check on a repeating timer. Every 5 minutes is frequent
// enough that a lock is never meaningfully late, and cheap enough
// that it costs nothing at this scale.
function startScheduler() {
  const FIVE_MINUTES_IN_MS = 5 * 60 * 1000;

  console.log('[scheduler] Started - checking for overdue modules every 5 minutes');

  // Run once immediately on startup, then repeat
  lockOverdueModules().catch((err) => console.error('[scheduler] Error:', err));

  setInterval(() => {
    lockOverdueModules().catch((err) => console.error('[scheduler] Error:', err));
  }, FIVE_MINUTES_IN_MS);
}

module.exports = { startScheduler, lockOverdueModules };
