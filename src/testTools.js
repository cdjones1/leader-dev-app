// ============================================================
// TEST SHORTCUTS (admin only, self-paired test plans only)
// Lets an admin jump a TEST plan straight to a Study & Review so the
// flashcards and content can be checked without doing every module.
// It only works on a plan where the developer and the developee are
// the same person - a real developee's plan can never be fast-forwarded,
// because that would put false completion records on it.
// Uses the app's real completion logic, so the Study & Review it builds
// is exactly what a real developee would get.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { midpointModule } = require('./gates');
const { completeModuleRecord } = require('./moduleCompletion');
const { openEssayIfConfigured } = require('./essay');

const router = express.Router();
const FIVE_DAYS_IN_MS = 5 * 24 * 60 * 60 * 1000;

// Finish modules 1..limit in order using the real completion code.
// The module at a gate position completes into its Study & Review step.
async function completeModulesThrough(plan, limit, actorId) {
  for (let seq = 1; seq <= limit; seq++) {
    const mod = await prisma.module.findFirst({ where: { planId: plan.id, sequenceOrder: seq } });
    if (!mod || mod.status === 'COMPLETED') continue;
    const now = new Date();
    if (mod.status !== 'OPEN') {
      await prisma.module.update({
        where: { id: mod.id },
        data: { status: 'OPEN', openedAt: now, dueAt: new Date(now.getTime() + FIVE_DAYS_IN_MS) },
      });
      await prisma.moduleEvent.create({ data: { moduleId: mod.id, eventType: 'OPENED', actorId } });
    }
    await prisma.moduleSection.updateMany({
      where: { moduleId: mod.id, completed: false },
      data: { completed: true, completedAt: now },
    });
    const fresh = await prisma.module.findUnique({ where: { id: mod.id } });
    await completeModuleRecord(fresh, actorId);
  }
}

async function reviewStats(planId, gatePosition) {
  const step = await prisma.reviewStep.findUnique({ where: { planId_gatePosition: { planId, gatePosition } } });
  if (!step) return null;
  const sections = await prisma.moduleSection.count({ where: { reviewStepId: step.id } });
  const flashcards = await prisma.taskChecklistItem.count({
    where: { moduleTask: { taskType: 'FLASHCARD', section: { reviewStepId: step.id } } },
  });
  return { reviewStepId: step.id, sections, flashcards };
}

router.post('/plans/:planId/fast-forward', requireAuth, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const { target } = req.body || {};
    if (!['MIDTERM_REVIEW', 'FINAL_REVIEW'].includes(target)) {
      return res.status(400).json({ error: 'target must be MIDTERM_REVIEW or FINAL_REVIEW' });
    }
    const plan = await prisma.developmentPlan.findUnique({
      where: { id: req.params.planId },
      include: { pairing: true },
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.pairing.developerId !== plan.pairing.developeeId) {
      return res.status(400).json({ error: 'Test shortcuts only work on a test plan where you are both the developer and the developee. This plan belongs to a real developee.' });
    }
    if (plan.status !== 'IN_PROGRESS') return res.status(400).json({ error: 'This plan is already complete' });

    const midpoint = midpointModule(plan.moduleCount);
    const actorId = req.user.userId;
    const midGate = 'AFTER_MODULE_4';
    const finalGate = 'AFTER_MODULE_8';

    if (target === 'MIDTERM_REVIEW') {
      if (await prisma.reviewStep.findUnique({ where: { planId_gatePosition: { planId: plan.id, gatePosition: midGate } } })) {
        return res.status(400).json({ error: 'This plan is already at or past the Midterm Study & Review' });
      }
      await completeModulesThrough(plan, midpoint, actorId);
      const stats = await reviewStats(plan.id, midGate);
      return res.json({ target, ...(stats || {}) });
    }

    // FINAL_REVIEW: get through the midterm first (test records only).
    if (await prisma.reviewStep.findUnique({ where: { planId_gatePosition: { planId: plan.id, gatePosition: finalGate } } })) {
      return res.status(400).json({ error: 'This plan is already at or past the Final Study & Review' });
    }
    let midStep = await prisma.reviewStep.findUnique({ where: { planId_gatePosition: { planId: plan.id, gatePosition: midGate } } });
    if (!midStep) {
      await completeModulesThrough(plan, midpoint, actorId);
      midStep = await prisma.reviewStep.findUnique({ where: { planId_gatePosition: { planId: plan.id, gatePosition: midGate } } });
    }
    if (midStep && midStep.status !== 'COMPLETED') {
      await prisma.reviewStep.update({ where: { id: midStep.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    }
    const midterm = await prisma.assessment.findUnique({ where: { planId_gatePosition: { planId: plan.id, gatePosition: midGate } } });
    if (!midterm) {
      await prisma.assessment.create({ data: { planId: plan.id, gatePosition: midGate, status: 'PASSED', attemptCount: 1 } });
    } else if (midterm.status !== 'PASSED') {
      await prisma.assessment.update({ where: { id: midterm.id }, data: { status: 'PASSED' } });
    }
    // Part 2 begins (a test plan ignores the Part 2 hold).
    const first = await prisma.module.findFirst({ where: { planId: plan.id, sequenceOrder: midpoint + 1 } });
    if (first && first.status === 'NOT_STARTED') {
      const now = new Date();
      await prisma.module.update({ where: { id: first.id }, data: { status: 'OPEN', openedAt: now, dueAt: new Date(now.getTime() + FIVE_DAYS_IN_MS) } });
      await prisma.moduleEvent.create({ data: { moduleId: first.id, eventType: 'OPENED', actorId } });
    }
    await openEssayIfConfigured(plan);
    await completeModulesThrough(plan, plan.moduleCount, actorId);
    const stats = await reviewStats(plan.id, finalGate);
    res.json({ target, ...(stats || {}) });
  } catch (err) {
    console.error('fast-forward failed:', err);
    res.status(500).json({ error: 'Could not fast-forward this test plan: ' + err.message });
  }
});

module.exports = router;
