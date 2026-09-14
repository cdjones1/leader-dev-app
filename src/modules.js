// ============================================================
// MODULE ROUTES
// Handles: opening a module (starts its 5-day clock) and
// completing a module (which automatically opens the next one).
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess, checkIsAssignedRole, checkNoActiveAssessmentLock, checkIsDeveloperOnPlan } = require('./access');
const { midpointModule, gateAfterModule } = require('./gates');

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

// A section belongs to EITHER a module OR a review step, never both -
// this resolves whichever one it actually is to get the plan ID.
function getSectionPlanId(section) {
  return section.module ? section.module.planId : section.reviewStep.planId;
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
      section: { include: { module: true, reviewStep: true } },
      checklistItems: { orderBy: { order: 'asc' } },
      choiceOptions: { orderBy: { order: 'asc' } },
    },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, getSectionPlanId(task.section)))) return;
  if (!(await checkNoActiveAssessmentLock(req, res, getSectionPlanId(task.section)))) return;

  res.json(stripHiddenAnswers(task));
});

// --------------------------------------------------------------
// SUBMIT an answer to a QUESTION task. Locks in permanently.
// --------------------------------------------------------------
router.post('/tasks/:taskId/submit-answer', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: { section: { include: { module: true, reviewStep: true } } },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, getSectionPlanId(task.section)))) return;
  if (!(await checkNoActiveAssessmentLock(req, res, getSectionPlanId(task.section)))) return;
  if (!(await checkIsAssignedRole(req, res, getSectionPlanId(task.section), task.assignedTo))) return;
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
    include: { moduleTask: { include: { section: { include: { module: true, reviewStep: true } } } } },
  });
  if (!item) {
    return res.status(404).json({ error: 'Checklist item not found' });
  }
  const planId = getSectionPlanId(item.moduleTask.section);
  if (!(await checkPlanAccess(req, res, planId))) return;
  if (!(await checkNoActiveAssessmentLock(req, res, planId))) return;
  if (!(await checkIsAssignedRole(req, res, planId, item.moduleTask.assignedTo))) return;

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
    include: { section: { include: { module: true, reviewStep: true } }, choiceOptions: true },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, getSectionPlanId(task.section)))) return;
  if (!(await checkNoActiveAssessmentLock(req, res, getSectionPlanId(task.section)))) return;
  if (!(await checkIsAssignedRole(req, res, getSectionPlanId(task.section), task.assignedTo))) return;
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
// TOGGLE an ACTION_ITEM task's checked state. Each one is
// completed independently - no submit/lock involved, just a
// checkbox someone can check and uncheck freely.
// --------------------------------------------------------------
router.post('/tasks/:taskId/toggle', requireAuth, async (req, res) => {
  const task = await prisma.moduleTask.findUnique({
    where: { id: req.params.taskId },
    include: { section: { include: { module: true, reviewStep: true } } },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, getSectionPlanId(task.section)))) return;
  if (!(await checkNoActiveAssessmentLock(req, res, getSectionPlanId(task.section)))) return;
  if (!(await checkIsAssignedRole(req, res, getSectionPlanId(task.section), task.assignedTo))) return;
  if (task.taskType !== 'ACTION_ITEM') {
    return res.status(400).json({ error: 'Only action-item tasks can be toggled directly' });
  }

  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: {
      completed: !task.completed,
      completedAt: !task.completed ? new Date() : null,
    },
  });

  res.json(updated);
});
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
  if (!(await checkNoActiveAssessmentLock(req, res, module.planId))) return;
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

  // The module right after the midpoint has an ADDITIONAL gate on
  // top of the sequencing rule above: the midterm assessment (right
  // after the midpoint module) must have PASSED. Uses the module's
  // OWN plan's moduleCount, so this works correctly whether the plan
  // has 8 modules, 6, or any other count.
  const plan = await prisma.developmentPlan.findUnique({ where: { id: module.planId } });
  const midpoint = midpointModule(plan.moduleCount);
  if (module.sequenceOrder === midpoint + 1) {
    const midterm = await prisma.assessment.findUnique({
      where: { planId_gatePosition: { planId: module.planId, gatePosition: 'AFTER_MODULE_4' } },
    });
    if (!midterm || midterm.status !== 'PASSED') {
      return res.status(400).json({
        error: `Module ${module.sequenceOrder} is locked until the midterm assessment (after module ${midpoint}) has passed`,
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
// REOPEN a stalled (auto-locked) module - admin only. This is the
// recovery path for the "Module Stalled" item on the admin
// dashboard: gives it a fresh 5-day window from right now, so it
// doesn't just get immediately re-locked on the next scheduler run.
// --------------------------------------------------------------
router.post('/:id/admin-reopen', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can reopen a stalled module' });
  }

  const moduleId = req.params.id;
  const module = await prisma.module.findUnique({ where: { id: moduleId } });
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  if (module.status !== 'LOCKED') {
    return res.status(400).json({ error: `Cannot reopen a module with status ${module.status} - only a LOCKED module can be reopened this way` });
  }

  const now = new Date();
  const fiveDaysInMs = 5 * 24 * 60 * 60 * 1000;

  const updated = await prisma.module.update({
    where: { id: moduleId },
    data: { status: 'OPEN', dueAt: new Date(now.getTime() + fiveDaysInMs), lockedAt: null },
  });

  await prisma.moduleEvent.create({
    data: { moduleId, eventType: 'REOPENED', actorId: req.user.userId },
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
  if (!(await checkPlanAccess(req, res, module.planId))) return;
  if (!(await checkNoActiveAssessmentLock(req, res, module.planId))) return;
  if (module.status !== 'OPEN') {
    return res.status(400).json({ error: `Cannot complete a module with status ${module.status}` });
  }

  // Every section in this module needs to actually be finished first -
  // a section can only reach "completed" once every task inside it
  // satisfies its own requirement, so checking sections here
  // transitively guarantees every task is done too. This closes the
  // gap where someone could click "Mark Complete" directly on the
  // plan page without ever working through the sections themselves.
  const sections = await prisma.moduleSection.findMany({ where: { moduleId } });
  const unfinishedSections = sections.filter((s) => !s.completed);
  if (unfinishedSections.length > 0) {
    return res.status(400).json({
      error: 'Not every section in this module is complete yet',
      missing: unfinishedSections.map((s) => s.title),
    });
  }

  const now = new Date();

  const updated = await prisma.module.update({
    where: { id: moduleId },
    data: { status: 'COMPLETED', completedAt: now },
  });

  await prisma.moduleEvent.create({
    data: { moduleId, eventType: 'COMPLETED', actorId: req.user.userId },
  });

  // The midpoint and final modules lead into a "Study and Review"
  // step before the assessment - not straight to the assessment
  // itself. Uses this plan's OWN moduleCount, so this correctly finds
  // the right gate regardless of how many modules the plan has.
  const plan = await prisma.developmentPlan.findUnique({ where: { id: module.planId } });
  const gatePosition = gateAfterModule(module.sequenceOrder, plan.moduleCount);
  if (gatePosition) {
    const reviewStep = await prisma.reviewStep.create({
      data: { planId: module.planId, gatePosition, status: 'OPEN', openedAt: new Date() },
    });

    // Copy this path's review-gate content (if any) into real
    // sections/tasks for this specific review step - same nested
    // copy pattern plans.js uses for a regular module's sections,
    // just attaching via reviewStepId instead of moduleId. Older
    // plans, or a path with nothing authored yet, just get an empty
    // review step, same as before this feature existed.
    if (plan.pathId) {
      const gate = await prisma.reviewGateTemplate.findUnique({
        where: { pathId_gatePosition: { pathId: plan.pathId, gatePosition } },
        include: {
          sectionTemplates: {
            orderBy: { order: 'asc' },
            include: {
              taskTemplates: {
                orderBy: { order: 'asc' },
                include: {
                  checklistItemTemplates: { orderBy: { order: 'asc' } },
                  choiceOptionTemplates: { orderBy: { order: 'asc' } },
                  quizQuestionTemplates: {
                    orderBy: { order: 'asc' },
                    include: { choiceOptionTemplates: { orderBy: { order: 'asc' } } },
                  },
                },
              },
            },
          },
        },
      });

      if (gate) {
        const flashcardTaskIds = [];
        for (const sectionTemplate of gate.sectionTemplates) {
          const section = await prisma.moduleSection.create({
            data: { reviewStepId: reviewStep.id, order: sectionTemplate.order, title: sectionTemplate.title },
          });

          for (const taskTemplate of sectionTemplate.taskTemplates) {
            const moduleTask = await prisma.moduleTask.create({
              data: {
                sectionId: section.id,
                order: taskTemplate.order,
                text: taskTemplate.text,
                content: taskTemplate.content,
                taskType: taskTemplate.taskType,
                assignedTo: taskTemplate.assignedTo,
                correctAnswer: taskTemplate.correctAnswer,
                link: taskTemplate.link,
                pageReference: taskTemplate.pageReference,
              },
            });

            for (const item of taskTemplate.checklistItemTemplates) {
              await prisma.taskChecklistItem.create({
                data: {
                  moduleTaskId: moduleTask.id,
                  order: item.order,
                  text: item.text,
                  description: item.description,
                  link: item.link,
                },
              });
            }

            for (const option of taskTemplate.choiceOptionTemplates) {
              await prisma.taskChoiceOption.create({
                data: { moduleTaskId: moduleTask.id, order: option.order, text: option.text, isCorrect: option.isCorrect },
              });
            }

            for (const qt of taskTemplate.quizQuestionTemplates) {
              const quizQuestion = await prisma.sectionQuizQuestion.create({
                data: { moduleTaskId: moduleTask.id, order: qt.order, text: qt.text, content: qt.content },
              });
              for (const opt of qt.choiceOptionTemplates) {
                await prisma.sectionQuizChoiceOption.create({
                  data: { questionId: quizQuestion.id, order: opt.order, text: opt.text, isCorrect: opt.isCorrect },
                });
              }
            }

            if (taskTemplate.taskType === 'FLASHCARD') {
              flashcardTaskIds.push(moduleTask.id);
            }
          }
        }

        // Every Flashcard Set task in a review gate automatically pulls
        // in all the flashcards from earlier modules - appended after
        // whatever the admin manually authored, each one tagged with
        // which module it actually came from. Snapshotted once, right
        // now, so it never shifts under someone mid-review even if the
        // source modules' content changes later.
        if (flashcardTaskIds.length > 0) {
          const midpoint = midpointModule(plan.moduleCount);
          // Midterm pulls from modules 1 through the midpoint. Final
          // pulls from the SECOND half only (midpoint+1 through the
          // end) - the material not already covered by the midterm,
          // not a comprehensive re-pull of everything.
          const minSequenceOrder = gatePosition === 'AFTER_MODULE_4' ? 1 : midpoint + 1;
          const maxSequenceOrder = gatePosition === 'AFTER_MODULE_4' ? midpoint : plan.moduleCount;

          const priorModules = await prisma.module.findMany({
            where: { planId: plan.id, sequenceOrder: { gte: minSequenceOrder, lte: maxSequenceOrder } },
            orderBy: { sequenceOrder: 'asc' },
            include: {
              sections: {
                orderBy: { order: 'asc' },
                include: {
                  tasks: {
                    where: { taskType: 'FLASHCARD' },
                    orderBy: { order: 'asc' },
                    include: { checklistItems: { orderBy: { order: 'asc' } } },
                  },
                },
              },
            },
          });

          const aggregatedCards = [];
          for (const priorModule of priorModules) {
            const sourceLabel = `Module ${priorModule.sequenceOrder}${priorModule.title ? ' — ' + priorModule.title : ''}`;
            for (const priorSection of priorModule.sections) {
              for (const priorTask of priorSection.tasks) {
                for (const card of priorTask.checklistItems) {
                  aggregatedCards.push({ text: card.text, description: card.description, sourceLabel });
                }
              }
            }
          }

          if (aggregatedCards.length > 0) {
            for (const flashcardTaskId of flashcardTaskIds) {
              const existingCount = await prisma.taskChecklistItem.count({ where: { moduleTaskId: flashcardTaskId } });
              for (let i = 0; i < aggregatedCards.length; i++) {
                const card = aggregatedCards[i];
                await prisma.taskChecklistItem.create({
                  data: {
                    moduleTaskId: flashcardTaskId,
                    order: existingCount + i + 1,
                    text: card.text,
                    description: card.description,
                    sourceLabel: card.sourceLabel,
                  },
                });
              }
            }
          }
        }
      }
    }

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
// MARK REVIEWED — the developer (or admin) acknowledging a
// completed module, separate from the developee just finishing it.
// Doesn't block or gate anything else - purely a record that the
// developer actually looked at it.
// --------------------------------------------------------------
router.post('/:id/mark-reviewed', requireAuth, async (req, res) => {
  const moduleId = req.params.id;

  const module = await prisma.module.findUnique({ where: { id: moduleId } });
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  if (!(await checkIsDeveloperOnPlan(req, res, module.planId))) return;
  if (module.status !== 'COMPLETED') {
    return res.status(400).json({ error: `Cannot review a module with status ${module.status} - it needs to be completed first` });
  }
  if (module.reviewedAt) {
    return res.status(400).json({ error: 'This module has already been marked reviewed' });
  }

  const updated = await prisma.module.update({
    where: { id: moduleId },
    data: { reviewedAt: new Date() },
  });

  res.json(updated);
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
  if (!(await checkNoActiveAssessmentLock(req, res, module.planId))) return;
  res.json(module);
});

module.exports = router;
