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
      include: { taskTemplates: { orderBy: { order: 'asc' } } },
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
      for (const taskTemplate of template.taskTemplates) {
        await prisma.moduleTask.create({
          data: { moduleId: module.id, order: taskTemplate.order, text: taskTemplate.text },
        });
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
      modules: { orderBy: { sequenceOrder: 'asc' }, include: { tasks: { orderBy: { order: 'asc' } } } },
      assessments: true,
      reviewSteps: true,
      pairing: { include: { developer: true, developee: true } },
    },
  });
  if (!plan) {
    return res.status(404).json({ error: 'Plan not found' });
  }
  if (!(await checkPlanAccess(req, res, plan.id))) return;

  res.json(plan);
});

module.exports = router;
