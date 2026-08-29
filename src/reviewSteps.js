// ============================================================
// REVIEW STEP ROUTES
// "Study and Review" - sits between a 4-module block and its
// assessment. Opens automatically when module 4 or 8 completes.
// Completing it is what actually creates the assessment - so the
// assessment doesn't even exist yet until review is done.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess } = require('./access');

const router = express.Router();

router.post('/:id/complete', requireAuth, async (req, res) => {
  const reviewStep = await prisma.reviewStep.findUnique({ where: { id: req.params.id } });
  if (!reviewStep) {
    return res.status(404).json({ error: 'Review step not found' });
  }
  if (!(await checkPlanAccess(req, res, reviewStep.planId))) return;
  if (reviewStep.status !== 'OPEN') {
    return res.status(400).json({ error: `Cannot complete a review step with status ${reviewStep.status}` });
  }

  const updated = await prisma.reviewStep.update({
    where: { id: reviewStep.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  // Completing review is what creates the actual assessment - it
  // didn't exist until now.
  const assessment = await prisma.assessment.create({
    data: { planId: reviewStep.planId, gatePosition: reviewStep.gatePosition, status: 'PENDING' },
  });

  res.json({ reviewStep: updated, assessmentCreated: assessment });
});

module.exports = router;
