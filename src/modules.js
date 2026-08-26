// ============================================================
// MODULE ROUTES
// Handles: opening a module (starts its 5-day clock) and
// completing a module (which automatically opens the next one).
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');

const router = express.Router();

const FIVE_DAYS_IN_MS = 5 * 24 * 60 * 60 * 1000;

// --------------------------------------------------------------
// OPEN a module — starts its 5-day countdown.
// Only allowed if it's currently NOT_STARTED (can't re-open a
// completed or locked module this way — that's a separate action).
// --------------------------------------------------------------
router.post('/:id/open', requireAuth, async (req, res) => {
  const moduleId = req.params.id;

  const module = await prisma.module.findUnique({ where: { id: moduleId } });
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  if (module.status !== 'NOT_STARTED') {
    return res.status(400).json({ error: `Cannot open a module with status ${module.status}` });
  }

  const now = new Date();
  const dueAt = new Date(now.getTime() + FIVE_DAYS_IN_MS);

  const updated = await prisma.module.update({
    where: { id: moduleId },
    data: { status: 'OPEN', openedAt: now, dueAt },
  });

  // Record this in the permanent audit trail
  await prisma.moduleEvent.create({
    data: { moduleId, eventType: 'OPENED', actorId: req.user.userId },
  });

  res.json(updated);
});

// --------------------------------------------------------------
// COMPLETE a module — only allowed while it's OPEN (a locked
// module must be reopened first, that's a different action).
// Automatically opens the next module in sequence, if one exists.
// --------------------------------------------------------------
router.post('/:id/complete', requireAuth, async (req, res) => {
  const moduleId = req.params.id;

  const module = await prisma.module.findUnique({ where: { id: moduleId } });
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  if (module.status !== 'OPEN') {
    return res.status(400).json({ error: `Cannot complete a module with status ${module.status}` });
  }

  const now = new Date();

  const updated = await prisma.module.update({
    where: { id: moduleId },
    data: { status: 'COMPLETED', completedAt: now },
  });

  await prisma.moduleEvent.create({
    data: { moduleId, eventType: 'COMPLETED', actorId: req.user.userId },
  });

  // Modules 4 and 8 are gated by an assessment - don't auto-open the
  // next module. Instead, create the assessment and wait for grading.
  if (module.sequenceOrder === 4 || module.sequenceOrder === 8) {
    const gatePosition = module.sequenceOrder === 4 ? 'AFTER_MODULE_4' : 'AFTER_MODULE_8';
    const assessment = await prisma.assessment.create({
      data: { planId: module.planId, gatePosition, status: 'PENDING' },
    });
    return res.json({ completedModule: updated, assessmentCreated: assessment });
  }

  // Find and open the next module in this plan, if there is one
  const nextModule = await prisma.module.findFirst({
    where: { planId: module.planId, sequenceOrder: module.sequenceOrder + 1 },
  });

  if (nextModule) {
    const nextDueAt = new Date(now.getTime() + FIVE_DAYS_IN_MS);
    await prisma.module.update({
      where: { id: nextModule.id },
      data: { status: 'OPEN', openedAt: now, dueAt: nextDueAt },
    });
    await prisma.moduleEvent.create({
      data: { moduleId: nextModule.id, eventType: 'OPENED', actorId: null }, // null = triggered by the system, not a person
    });
  }

  res.json({ completedModule: updated, nextModuleOpened: !!nextModule });
});

// --------------------------------------------------------------
// VIEW a module's full history — useful for testing and for
// the eventual admin dashboard.
// --------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res) => {
  const module = await prisma.module.findUnique({
    where: { id: req.params.id },
    include: { events: { orderBy: { timestamp: 'asc' } } },
  });
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  res.json(module);
});

module.exports = router;
