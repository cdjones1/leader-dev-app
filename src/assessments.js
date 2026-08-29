// ============================================================
// ASSESSMENT ROUTES
// Handles grading the midterm (after module 4) and final (after
// module 8) assessments, including the 3-attempt rule:
//   attempt 1 fails -> attempt 2 allowed automatically
//   attempt 2 fails -> LOCKED_NEEDS_MEETING (developer must meet, then reopen)
//   attempt 3 fails -> LOCKED_FINAL (needs admin, not the developer)
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess, checkIsDeveloperOnPlan } = require('./access');

const router = express.Router();

// --------------------------------------------------------------
// GRADE an assessment attempt.
// Body: { overallResult: "PASS" or "FAIL", itemScores: [{ moduleId, score, comments }, ...] }
// --------------------------------------------------------------
router.post('/:id/grade', requireAuth, async (req, res) => {
  const assessmentId = req.params.id;
  const { overallResult, itemScores } = req.body;

  if (!['PASS', 'FAIL'].includes(overallResult)) {
    return res.status(400).json({ error: 'overallResult must be PASS or FAIL' });
  }
  if (!Array.isArray(itemScores) || itemScores.length === 0) {
    return res.status(400).json({ error: 'itemScores must be a non-empty array' });
  }

  const assessment = await prisma.assessment.findUnique({ where: { id: assessmentId } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkIsDeveloperOnPlan(req, res, assessment.planId))) return;
  if (!['PENDING', 'IN_PROGRESS'].includes(assessment.status)) {
    return res.status(400).json({
      error: `Cannot grade an assessment with status ${assessment.status}`,
    });
  }

  const attemptNumber = assessment.attemptCount + 1;

  const attempt = await prisma.assessmentAttempt.create({
    data: {
      assessmentId,
      attemptNumber,
      overallResult,
      gradedBy: req.user.userId,
      itemScores: {
        create: itemScores.map((s) => ({
          moduleId: s.moduleId,
          score: s.score,
          comments: s.comments || null,
        })),
      },
    },
    include: { itemScores: true },
  });

  // --------------------------------------------------------------
  // This is the core decision: what happens to the ASSESSMENT
  // based on this attempt's result and which attempt number it was.
  // --------------------------------------------------------------
  let newStatus;
  if (overallResult === 'PASS') {
    newStatus = 'PASSED';
  } else if (attemptNumber === 1) {
    newStatus = 'IN_PROGRESS'; // attempt 2 allowed
  } else if (attemptNumber === 2) {
    newStatus = 'LOCKED_NEEDS_MEETING'; // developer must meet with developee, then reopen
  } else {
    newStatus = 'LOCKED_FINAL'; // 3rd attempt failed - needs admin, not developer
  }

  const updatedAssessment = await prisma.assessment.update({
    where: { id: assessmentId },
    data: { status: newStatus, attemptCount: attemptNumber },
  });

  // If this passed, unlock what comes next: module 5 (for the midterm)
  // or mark the whole plan complete (for the final).
  let nextStepResult = null;
  if (newStatus === 'PASSED') {
    nextStepResult = await unlockNextStep(assessment);
  }

  res.json({ attempt, assessment: updatedAssessment, nextStep: nextStepResult });
});

// --------------------------------------------------------------
// Helper: when an assessment passes, open the next module (midterm)
// or mark the plan complete (final).
// --------------------------------------------------------------
async function unlockNextStep(assessment) {
  if (assessment.gatePosition === 'AFTER_MODULE_4') {
    const FIVE_DAYS_IN_MS = 5 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const module5 = await prisma.module.findFirst({
      where: { planId: assessment.planId, sequenceOrder: 5 },
    });
    if (module5) {
      await prisma.module.update({
        where: { id: module5.id },
        data: { status: 'OPEN', openedAt: now, dueAt: new Date(now.getTime() + FIVE_DAYS_IN_MS) },
      });
      await prisma.moduleEvent.create({
        data: { moduleId: module5.id, eventType: 'OPENED', actorId: null },
      });
      return { action: 'opened_module_5', moduleId: module5.id };
    }
  } else if (assessment.gatePosition === 'AFTER_MODULE_8') {
    await prisma.developmentPlan.update({
      where: { id: assessment.planId },
      data: { status: 'COMPLETE' },
    });
    return { action: 'plan_marked_complete' };
  }
  return null;
}

// --------------------------------------------------------------
// DEVELOPER REOPEN — only valid from LOCKED_NEEDS_MEETING, after
// the required follow-up meeting has happened. Allows attempt 3.
// --------------------------------------------------------------
router.post('/:id/reopen-after-meeting', requireAuth, async (req, res) => {
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkIsDeveloperOnPlan(req, res, assessment.planId))) return;
  if (assessment.status !== 'LOCKED_NEEDS_MEETING') {
    return res.status(400).json({
      error: `Can only reopen from LOCKED_NEEDS_MEETING, current status is ${assessment.status}`,
    });
  }

  const updated = await prisma.assessment.update({
    where: { id: assessment.id },
    data: { status: 'IN_PROGRESS' },
  });

  res.json(updated);
});

// --------------------------------------------------------------
// ADMIN REOPEN FOR RETRY — grants exactly one more attempt from
// LOCKED_FINAL, without automatically passing it. If that attempt
// also fails, the existing 3-attempt logic naturally sends it right
// back to LOCKED_FINAL - admin decides again from there.
// --------------------------------------------------------------
router.post('/:id/admin-reopen-for-retry', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can reopen a LOCKED_FINAL assessment' });
  }

  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (assessment.status !== 'LOCKED_FINAL') {
    return res.status(400).json({
      error: `Can only reopen from LOCKED_FINAL, current status is ${assessment.status}`,
    });
  }

  const updated = await prisma.assessment.update({
    where: { id: assessment.id },
    data: { status: 'IN_PROGRESS' }, // attemptCount is NOT reset - the next grade continues the real count
  });

  res.json(updated);
});

// --------------------------------------------------------------
// ADMIN RESOLUTION — only valid from LOCKED_FINAL. For now this
// gives admin one option: override to PASS and unlock the next step.
// (We flagged this as an open decision earlier - easy to add more
// options here later, e.g. ending the pairing instead.)
// --------------------------------------------------------------
router.post('/:id/admin-override-pass', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can resolve a LOCKED_FINAL assessment' });
  }

  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (assessment.status !== 'LOCKED_FINAL') {
    return res.status(400).json({
      error: `Can only override from LOCKED_FINAL, current status is ${assessment.status}`,
    });
  }

  const updated = await prisma.assessment.update({
    where: { id: assessment.id },
    data: { status: 'PASSED' },
  });

  const nextStepResult = await unlockNextStep(updated);

  res.json({ assessment: updated, nextStep: nextStepResult });
});

// --------------------------------------------------------------
// VIEW an assessment's full history
// --------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res) => {
  const assessment = await prisma.assessment.findUnique({
    where: { id: req.params.id },
    include: { attempts: { include: { itemScores: true }, orderBy: { attemptNumber: 'asc' } } },
  });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkPlanAccess(req, res, assessment.planId))) return;
  res.json(assessment);
});

module.exports = router;
