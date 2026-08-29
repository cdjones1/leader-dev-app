// ============================================================
// MODULE ROUTES
// Handles: opening a module (starts its 5-day clock) and
// completing a module (which automatically opens the next one).
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess } = require('./access');

const router = express.Router();

const FIVE_DAYS_IN_MS = 5 * 24 * 60 * 60 * 1000;

// --------------------------------------------------------------
// TOGGLE a task's checked state. Only for READING tasks - a
// QUESTION task is marked complete by submitting an answer, not
// by checking a box.
// --------------------------------------------------------------
router.post('/tasks/:taskId/toggle', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: { module: true },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, task.module.planId))) return;
  if (task.taskType !== 'READING') {
    return res.status(400).json({ error: 'Only reading tasks can be toggled - question tasks are completed by submitting an answer' });
  }

  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: {
      completed: !task.completed,
      completedAt: !task.completed ? new Date() : null,
    },
  });

  res.json(stripAnswerIfUnsubmitted(updated));
});

// --------------------------------------------------------------
// A single task's own page. This is the ONLY place the correct
// answer is ever included in a response - and even then, only
// once the person has already locked in their own answer. Before
// that, correctAnswer is stripped out entirely so it never reaches
// the browser, not even hidden in the page source.
// --------------------------------------------------------------
function stripAnswerIfUnsubmitted(task) {
  if (task.taskType === 'QUESTION' && !task.submittedAt) {
    const { correctAnswer, ...safeTask } = task;
    return safeTask;
  }
  return task;
}

router.get('/tasks/:taskId', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: { module: true },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, task.module.planId))) return;

  res.json(stripAnswerIfUnsubmitted(task));
});

// --------------------------------------------------------------
// SUBMIT an answer to a QUESTION task. Locks in permanently -
// once submittedAt is set, this can never be called again for
// this task. The response includes the correct answer now, since
// submission is exactly the moment it's supposed to be revealed.
// --------------------------------------------------------------
router.post('/tasks/:taskId/submit-answer', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: { module: true },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, task.module.planId))) return;
  if (task.taskType !== 'QUESTION') {
    return res.status(400).json({ error: 'Only question tasks accept a submitted answer' });
  }
  if (task.submittedAt) {
    return res.status(400).json({ error: 'This answer was already submitted and is locked - it cannot be changed' });
  }

  const { answer } = req.body;
  if (!answer || !answer.trim()) {
    return res.status(400).json({ error: 'answer is required' });
  }

  const now = new Date();
  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: { submittedAnswer: answer, submittedAt: now, completed: true, completedAt: now },
  });

  res.json(updated); // safe to include correctAnswer now - this IS the reveal moment
});

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
  if (!(await checkPlanAccess(req, res, module.planId))) return;
  if (module.status !== 'NOT_STARTED') {
    return res.status(400).json({ error: `Cannot open a module with status ${module.status}` });
  }

  // General sequencing rule: module N (other than 1) can't open until
  // module N-1 has actually been completed - regardless of which
  // button someone clicks. The normal flow already does this via
  // auto-cascade, but nothing was stopping a direct, out-of-order
  // open request until now.
  if (module.sequenceOrder > 1) {
    const previousModule = await prisma.module.findFirst({
      where: { planId: module.planId, sequenceOrder: module.sequenceOrder - 1 },
    });
    if (!previousModule || previousModule.status !== 'COMPLETED') {
      return res.status(400).json({
        error: `Module ${module.sequenceOrder} is locked until module ${module.sequenceOrder - 1} is completed`,
      });
    }
  }

  // Module 5 has an ADDITIONAL gate on top of the sequencing rule
  // above: the midterm assessment (after module 4) must have PASSED.
  if (module.sequenceOrder === 5) {
    const midterm = await prisma.assessment.findUnique({
      where: { planId_gatePosition: { planId: module.planId, gatePosition: 'AFTER_MODULE_4' } },
    });
    if (!midterm || midterm.status !== 'PASSED') {
      return res.status(400).json({
        error: 'Module 5 is locked until the midterm assessment (after module 4) has passed',
      });
    }
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

  // Module 1 opening is what actually starts the plan's real clock -
  // this is the moment the 40-day window begins, distinct from
  // whenever the plan/pairing was administratively created.
  if (module.sequenceOrder === 1) {
    await prisma.developmentPlan.update({
      where: { id: module.planId },
      data: { startedAt: now },
    });
  }

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
  if (!(await checkPlanAccess(req, res, module.planId))) return;
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

  // Modules 4 and 8 lead into a "Study and Review" step before the
  // assessment - not straight to the assessment itself anymore.
  if (module.sequenceOrder === 4 || module.sequenceOrder === 8) {
    const gatePosition = module.sequenceOrder === 4 ? 'AFTER_MODULE_4' : 'AFTER_MODULE_8';
    const reviewStep = await prisma.reviewStep.create({
      data: { planId: module.planId, gatePosition, status: 'OPEN', openedAt: new Date() },
    });
    return res.json({ completedModule: updated, reviewStepOpened: reviewStep });
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
  if (!(await checkPlanAccess(req, res, module.planId))) return;
  res.json(module);
});

module.exports = router;
