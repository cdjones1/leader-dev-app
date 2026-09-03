// ============================================================
// ADMIN DASHBOARD ROUTES
// The "needs attention" queue: one combined, sorted list of
// everything an admin might need to act on - stalled modules,
// overdue plans, and assessments stuck needing a meeting or
// final resolution. Oldest problem first.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');

const router = express.Router();

function requireAdmin(req, res) {
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

// Combines three different kinds of problems into one list, each
// tagged with a "reason" and "since" (how long it's been an issue),
// then sorts so the oldest, most overdue problem shows up first.
function buildQueue({ stalledModules, overduePlans, dueSoonPlans, needsMeetingAssessments, finalLockAssessments }) {
  const queue = [];

  for (const m of stalledModules) {
    queue.push({
      reason: 'module_stalled',
      since: m.lockedAt,
      planId: m.planId,
      moduleId: m.id,
      developer: m.plan.pairing.developer.name,
      developee: m.plan.pairing.developee.name,
    });
  }

  for (const p of overduePlans) {
    queue.push({
      reason: 'plan_overdue',
      since: p.startedAt,
      planId: p.id,
      developer: p.pairing.developer.name,
      developee: p.pairing.developee.name,
    });
  }

  for (const p of dueSoonPlans) {
    queue.push({
      reason: 'plan_due_soon',
      since: p.startedAt,
      planId: p.id,
      developer: p.pairing.developer.name,
      developee: p.pairing.developee.name,
    });
  }

  for (const a of needsMeetingAssessments) {
    queue.push({
      reason: 'assessment_needs_meeting',
      since: a.createdAt,
      planId: a.planId,
      assessmentId: a.id,
      developer: a.plan.pairing.developer.name,
      developee: a.plan.pairing.developee.name,
    });
  }

  for (const a of finalLockAssessments) {
    queue.push({
      reason: 'assessment_locked_final',
      since: a.createdAt,
      planId: a.planId,
      assessmentId: a.id,
      developer: a.plan.pairing.developer.name,
      developee: a.plan.pairing.developee.name,
    });
  }

  // Oldest problem first - whatever's been sitting longest needs
  // attention soonest.
  queue.sort((a, b) => new Date(a.since) - new Date(b.since));

  return queue;
}

// List every user in the system - only for populating admin dropdowns
// (e.g. picking who's the developer/developee when creating a pairing).
router.get('/users', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  });

  res.json(users);
});

// --------------------------------------------------------------
// DELETE a user - admin only. Two safety rules: you can't delete
// yourself, and you can't delete someone still tied to a pairing
// (delete the pairing first - same "clean up in order" pattern
// as plans before pairings).
// --------------------------------------------------------------
router.delete('/users/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  if (req.params.id === req.user.userId) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  const existingPairings = await prisma.developerPairing.count({
    where: { OR: [{ developerId: req.params.id }, { developeeId: req.params.id }] },
  });
  if (existingPairings > 0) {
    return res.status(400).json({
      error: `This person is part of ${existingPairings} pairing(s). Delete those first, then delete the user.`,
    });
  }

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  await prisma.user.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

router.get('/needs-attention', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const includePairingPeople = {
    plan: { include: { pairing: { include: { developer: true, developee: true } } } },
  };

  const [stalledModules, allActivePlans, problemAssessments] = await Promise.all([
    prisma.module.findMany({
      where: { status: 'LOCKED' },
      include: includePairingPeople,
    }),
    // Every plan's goalDays/maxDays can differ now (each path sets its
    // own), so a single database-level date cutoff can't tell overdue
    // apart from due-soon across every plan at once - fetch every
    // started, in-progress plan and do the real day math per plan below.
    prisma.developmentPlan.findMany({
      where: { status: 'IN_PROGRESS', startedAt: { not: null } },
      include: { pairing: { include: { developer: true, developee: true } } },
    }),
    prisma.assessment.findMany({
      where: { status: { in: ['LOCKED_NEEDS_MEETING', 'LOCKED_FINAL'] } },
      include: includePairingPeople,
    }),
  ]);

  // A plan that hasn't been started yet never appears here - its own
  // clock hasn't begun (already guaranteed by the startedAt filter
  // above, kept here as the readable rule this logic follows).
  const overduePlans = allActivePlans.filter((plan) => {
    const daysElapsed = (Date.now() - plan.startedAt) / MS_PER_DAY;
    return daysElapsed >= plan.maxDays;
  });

  // Due soon: past this plan's own goalDays, but not yet past its own
  // maxDays (those already show up as plan_overdue above - no need to
  // show the same plan twice).
  const dueSoonPlans = allActivePlans.filter((plan) => {
    const daysElapsed = (Date.now() - plan.startedAt) / MS_PER_DAY;
    return daysElapsed >= plan.goalDays && daysElapsed < plan.maxDays;
  });

  const needsMeetingAssessments = problemAssessments.filter((a) => a.status === 'LOCKED_NEEDS_MEETING');
  const finalLockAssessments = problemAssessments.filter((a) => a.status === 'LOCKED_FINAL');

  const queue = buildQueue({ stalledModules, overduePlans, dueSoonPlans, needsMeetingAssessments, finalLockAssessments });

  res.json({ count: queue.length, items: queue });
});

module.exports = { router, buildQueue }; // buildQueue exported for testing
