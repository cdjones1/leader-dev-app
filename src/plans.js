// ============================================================
// PLAN ROUTES
// Creating a real development plan for a pairing (8 modules,
// correctly set up with access-control participants from the
// start) and viewing your own plans.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess } = require('./access');

const router = express.Router();

// Shared answer-hiding rule, used everywhere a task might be sent
// to the browser: never include an answer before it's meant to be
// revealed. QUESTION tasks hide correctAnswer until submitted;
// MULTIPLE_CHOICE tasks hide every option's isCorrect until answered.
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
// CREATE a plan for a pairing. Admin-only for now, since assigning
// pairings and starting plans are both deliberate admin actions
// in our design.
// Creates: the plan, all 8 modules (not started), and the two
// participant records (developer + developee) that access control
// depends on.
// --------------------------------------------------------------
router.post('/', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can start a new development plan' });
  }

  const { pairingId } = req.body;
  if (!pairingId) {
    return res.status(400).json({ error: 'pairingId is required' });
  }

  const pairing = await prisma.developerPairing.findUnique({ where: { id: pairingId } });
  if (!pairing) {
    return res.status(404).json({ error: 'Pairing not found' });
  }

  const plan = await prisma.developmentPlan.create({ data: { pairingId } });

  // All 8 modules are created NOT_STARTED, including module 1 - nothing
  // auto-opens anymore. The plan's real clock (startedAt) only begins
  // once someone actually clicks to open module 1.
  // Content (title/description/tasks) is copied from the matching
  // template, if one exists yet - templates might not be filled in
  // yet, and that's fine, the module just starts blank.
  for (let seq = 1; seq <= 8; seq++) {
    const template = await prisma.moduleTemplate.findUnique({
      where: { sequenceOrder: seq },
      include: {
        sectionTemplates: {
          orderBy: { order: 'asc' },
          include: {
            taskTemplates: {
              orderBy: { order: 'asc' },
              include: {
                checklistItemTemplates: { orderBy: { order: 'asc' } },
                choiceOptionTemplates: { orderBy: { order: 'asc' } },
              },
            },
          },
        },
      },
    });

    const module = await prisma.module.create({
      data: {
        planId: plan.id,
        sequenceOrder: seq,
        status: 'NOT_STARTED',
        title: template ? template.title : null,
        description: template ? template.description : null,
      },
    });

    if (template) {
      for (const sectionTemplate of template.sectionTemplates) {
        const section = await prisma.moduleSection.create({
          data: {
            moduleId: module.id,
            order: sectionTemplate.order,
            title: sectionTemplate.title,
          },
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
            },
          });

          for (const item of taskTemplate.checklistItemTemplates) {
            await prisma.taskChecklistItem.create({
              data: { moduleTaskId: moduleTask.id, order: item.order, text: item.text },
            });
          }

          for (const option of taskTemplate.choiceOptionTemplates) {
            await prisma.taskChoiceOption.create({
              data: {
                moduleTaskId: moduleTask.id,
                order: option.order,
                text: option.text,
                isCorrect: option.isCorrect,
              },
            });
          }
        }
      }
    }
  }

  // Set up access control: the developer and developee on this
  // pairing become participants on this specific plan.
  await prisma.planParticipant.createMany({
    data: [
      { planId: plan.id, userId: pairing.developerId, participantRole: 'DEVELOPER' },
      { planId: plan.id, userId: pairing.developeeId, participantRole: 'DEVELOPEE' },
    ],
    skipDuplicates: true, // handles the self-paired test case (same user, one row)
  });

  res.status(201).json(plan);
});

// --------------------------------------------------------------
// LIST plans the logged-in user is a participant on.
// --------------------------------------------------------------
router.get('/mine', requireAuth, async (req, res) => {
  const participantRows = await prisma.planParticipant.findMany({
    where: { userId: req.user.userId },
    include: { plan: { include: { pairing: { include: { developer: true, developee: true } } } } },
  });

  const plans = participantRows.map((row) => ({
    planId: row.plan.id,
    myRole: row.participantRole,
    status: row.plan.status,
    developer: row.plan.pairing.developer.name,
    developee: row.plan.pairing.developee.name,
  }));

  res.json(plans);
});

// --------------------------------------------------------------
// VIEW one plan in full: all 8 modules and any assessments.
// --------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res) => {
  const plan = await prisma.developmentPlan.findUnique({
    where: { id: req.params.id },
    include: {
      modules: {
        orderBy: { sequenceOrder: 'asc' },
        include: {
          sections: {
            orderBy: { order: 'asc' },
            include: {
              tasks: {
                orderBy: { order: 'asc' },
                include: {
                  checklistItems: { orderBy: { order: 'asc' } },
                  choiceOptions: { orderBy: { order: 'asc' } },
                },
              },
            },
          },
        },
      },
      assessments: true,
      reviewSteps: true,
      pairing: { include: { developer: true, developee: true } },
    },
  });
  if (!plan) {
    return res.status(404).json({ error: 'Plan not found' });
  }
  if (!(await checkPlanAccess(req, res, plan.id))) return;

  // Never send an answer before it's meant to be revealed:
  // - QUESTION: strip correctAnswer until submittedAt is set
  // - MULTIPLE_CHOICE: strip each option's isCorrect until selectedOptionId is set
  for (const module of plan.modules) {
    for (const section of module.sections) {
      section.tasks = section.tasks.map((task) => stripHiddenAnswers(task));
    }
  }

  res.json(plan);
});

// --------------------------------------------------------------
// LIST all plans - admin only. Used for cleanup/management.
// --------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const plans = await prisma.developmentPlan.findMany({
    include: { pairing: { include: { developer: true, developee: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json(plans);
});

// --------------------------------------------------------------
// DELETE a plan - admin only, and irreversible. Cascades through
// every module, task, assessment, attempt, score, review step,
// and participant record tied to this plan. Does NOT touch the
// pairing itself or either user - only this specific plan's data.
// --------------------------------------------------------------
router.delete('/:id', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can delete a plan' });
  }

  const plan = await prisma.developmentPlan.findUnique({ where: { id: req.params.id } });
  if (!plan) {
    return res.status(404).json({ error: 'Plan not found' });
  }

  await prisma.developmentPlan.delete({ where: { id: req.params.id } });

  res.status(204).send();
});

module.exports = router;
