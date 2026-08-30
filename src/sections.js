// ============================================================
// MODULE SECTION ROUTES
// A section is its own page, holding a group of tasks. Reading
// tasks just display - no individual completion. Question,
// checklist, and multiple-choice tasks still capture their own
// data, but the WHOLE section is only marked done with one action
// at the end, once everything that needs an answer has one.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess, checkIsAssignedRole } = require('./access');

const router = express.Router();

// Shared answer-hiding rule, same as elsewhere.
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

// A section's own page: its tasks, each with hidden answers stripped.
router.get('/:sectionId', requireAuth, async (req, res) => {
  const section = await prisma.moduleSection.findUnique({
    where: { id: req.params.sectionId },
    include: {
      module: true,
      tasks: {
        orderBy: { order: 'asc' },
        include: {
          checklistItems: { orderBy: { order: 'asc' } },
          choiceOptions: { orderBy: { order: 'asc' } },
        },
      },
    },
  });
  if (!section) {
    return res.status(404).json({ error: 'Section not found' });
  }
  if (!(await checkPlanAccess(req, res, section.module.planId))) return;

  section.tasks = section.tasks.map((t) => stripHiddenAnswers(t));
  res.json(section);
});

// Figures out what's still missing before a section can be marked
// complete - every QUESTION needs a submitted answer, every
// MULTIPLE_CHOICE needs a selected option, every CHECKLIST needs
// every one of its items checked. READING tasks need nothing.
function findIncompleteRequirements(tasks) {
  const missing = [];
  for (const task of tasks) {
    if (task.taskType === 'QUESTION' && !task.submittedAt) {
      missing.push(`"${task.text}" still needs an answer submitted`);
    }
    if (task.taskType === 'MULTIPLE_CHOICE' && !task.selectedOptionId) {
      missing.push(`"${task.text}" still needs an answer selected`);
    }
    if (task.taskType === 'CHECKLIST' && !task.checklistItems.every((i) => i.completed)) {
      missing.push(`"${task.text}" still has unchecked items`);
    }
  }
  return missing;
}

// Mark the whole section complete - the single acknowledgment that
// replaces needing to click "complete" on every reading task.
router.post('/:sectionId/complete', requireAuth, async (req, res) => {
  const section = await prisma.moduleSection.findUnique({
    where: { id: req.params.sectionId },
    include: {
      module: true,
      tasks: { include: { checklistItems: true } },
    },
  });
  if (!section) {
    return res.status(404).json({ error: 'Section not found' });
  }
  if (!(await checkPlanAccess(req, res, section.module.planId))) return;
  if (!(await checkIsAssignedRole(req, res, section.module.planId, section.assignedTo))) return;
  if (section.completed) {
    return res.status(400).json({ error: 'This section is already marked complete' });
  }

  const missing = findIncompleteRequirements(section.tasks);
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'This section is not ready to complete yet',
      missing,
    });
  }

  const updated = await prisma.moduleSection.update({
    where: { id: section.id },
    data: { completed: true, completedAt: new Date() },
  });

  res.json(updated);
});

module.exports = router;
