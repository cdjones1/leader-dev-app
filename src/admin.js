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
      since: p.createdAt,
      planId: p.id,
      developer: p.pairing.developer.name,
      developee: p.pairing.developee.name,
    });
  }

  for (const p of dueSoonPlans) {
    queue.push({
      reason: 'plan_due_soon',
      since: p.createdAt,
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

router.get('/needs-attention', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const FORTY_DAYS_IN_MS = 40 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS_IN_MS = 30 * 24 * 60 * 60 * 1000;
  const fortyDaysAgo = new Date(Date.now() - FORTY_DAYS_IN_MS);
  const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_IN_MS);

  const includePairingPeople = {
    plan: { include: { pairing: { include: { developer: true, developee: true } } } },
  };

  const [stalledModules, overduePlans, dueSoonPlans, problemAssessments] = await Promise.all([
    prisma.module.findMany({
      where: { status: 'LOCKED' },
      include: includePairingPeople,
    }),
    prisma.developmentPlan.findMany({
      where: { status: 'IN_PROGRESS', createdAt: { lt: fortyDaysAgo } },
      include: { pairing: { include: { developer: true, developee: true } } },
    }),
    // Due soon: past the 30-day mark, but NOT yet past 40 (those already
    // show up as plan_overdue above - no need to show the same plan twice).
    prisma.developmentPlan.findMany({
      where: {
        status: 'IN_PROGRESS',
        createdAt: { lt: thirtyDaysAgo, gte: fortyDaysAgo },
      },
      include: { pairing: { include: { developer: true, developee: true } } },
    }),
    prisma.assessment.findMany({
      where: { status: { in: ['LOCKED_NEEDS_MEETING', 'LOCKED_FINAL'] } },
      include: includePairingPeople,
    }),
  ]);

  const needsMeetingAssessments = problemAssessments.filter((a) => a.status === 'LOCKED_NEEDS_MEETING');
  const finalLockAssessments = problemAssessments.filter((a) => a.status === 'LOCKED_FINAL');

  const queue = buildQueue({ stalledModules, overduePlans, dueSoonPlans, needsMeetingAssessments, finalLockAssessments });

  res.json({ count: queue.length, items: queue });
});

module.exports = { router, buildQueue }; // buildQueue exported for testing
