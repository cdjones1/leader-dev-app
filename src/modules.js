// ============================================================
// MODULE ROUTES
// Handles: opening a module (starts its 5-day clock) and
// completing a module (which automatically opens the next one).
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess, checkIsAssignedRole } = require('./access');

const router = express.Router();

const FIVE_DAYS_IN_MS = 5 * 24 * 60 * 60 * 1000;

// Shared answer-hiding rule - same as the one in plans.js. Never
// include an answer before it's meant to be revealed.
function stripHiddenAnswers(task) {
  let safeTask = task;
  if (task.taskType === 'QUESTION' && !task.submittedAt) {
    const { correctAnswer, ...rest } = safeTask;
    safeTask = rest;
  }
  if (task.taskType === 'MULTIPLE_CHOICE' && !task.selectedOptionId && task.choiceOptions) {
    safeTask = {
      ...safeTask,
      choiceOptions: task.choiceOptions.map(({ isCorrect, ...optRest }) => optRest),
    };
  }
  return safeTask;
}

// --------------------------------------------------------------
// A single task's own data (used inside a section's page) -
// includes checklist items and choice options, with hidden
// answers stripped per stripHiddenAnswers above.
// --------------------------------------------------------------
router.get('/tasks/:taskId', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: {
      section: { include: { module: true } },
      checklistItems: { orderBy: { order: 'asc' } },
      choiceOptions: { orderBy: { order: 'asc' } },
    },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, task.section.module.planId))) return;

  res.json(stripHiddenAnswers(task));
});

// --------------------------------------------------------------
// SUBMIT an answer to a QUESTION task. Locks in permanently.
// --------------------------------------------------------------
router.post('/tasks/:taskId/submit-answer', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: { section: { include: { module: true } } },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, task.section.module.planId))) return;
  if (!(await checkIsAssignedRole(req, res, task.section.module.planId, task.section.assignedTo))) return;
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
    data: { submittedAnswer: answer, submittedAt: now },
  });

  res.json(updated); // safe to include correctAnswer now - this IS the reveal moment
});

// --------------------------------------------------------------
// TOGGLE one checklist item within a CHECKLIST task.
// --------------------------------------------------------------
router.post('/tasks/checklist-items/:itemId/toggle', requireAuth, async (req, res) => {
  const item = await prisma.taskChecklistItem.findUnique({
    where: { id: req.params.itemId },
    include: { moduleTask: { include: { section: { include: { module: true } } } } },
  });
  if (!item) {
    return res.status(404).json({ error: 'Checklist item not found' });
  }
  const planId = item.moduleTask.section.module.planId;
  if (!(await checkPlanAccess(req, res, planId))) return;
  if (!(await checkIsAssignedRole(req, res, planId, item.moduleTask.section.assignedTo))) return;

  const now = new Date();
  const updatedItem = await prisma.taskChecklistItem.update({
    where: { id: item.id },
    data: { completed: !item.completed, completedAt: !item.completed ? now : null },
  });

  res.json(updatedItem);
});

// --------------------------------------------------------------
// SUBMIT a choice for a MULTIPLE_CHOICE task. Locks in permanently
// and is graded automatically right at submission time.
// --------------------------------------------------------------
router.post('/tasks/:taskId/submit-choice', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: { section: { include: { module: true } }, choiceOptions: true },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, task.section.module.planId))) return;
  if (!(await checkIsAssignedRole(req, res, task.section.module.planId, task.section.assignedTo))) return;
  if (task.taskType !== 'MULTIPLE_CHOICE') {
    return res.status(400).json({ error: 'Only multiple-choice tasks accept a submitted choice' });
  }
  if (task.selectedOptionId) {
    return res.status(400).json({ error: 'This choice was already submitted and is locked - it cannot be changed' });
  }

  const { optionId } = req.body;
  const chosenOption = task.choiceOptions.find((o) => o.id === optionId);
  if (!chosenOption) {
    return res.status(400).json({ error: 'optionId does not match one of this task\'s choices' });
  }

  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: {
      selectedOptionId: optionId,
      isCorrect: chosenOption.isCorrect, // graded automatically, right now, from the stored correct option
    },
    include: { choiceOptions: { orderBy: { order: 'asc' } } },
  });

  res.json(updated); // safe to include every option's isCorrect now - this IS the reveal moment
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
