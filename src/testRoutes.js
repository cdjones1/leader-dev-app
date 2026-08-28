// ============================================================
// TEST-ONLY ROUTES
// These exist purely to make manual testing easier through Postman,
// instead of hand-typing scripts into Render's terminal.
// Safe to delete once you have a real "create a plan" admin screen.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');

const router = express.Router();

// --------------------------------------------------------------
// Creates a pairing + plan + a COMPLETED module 4 + a PENDING
// assessment gate, all in one call - ready to grade immediately.
// Uses YOUR OWN logged-in user id automatically, no copy-pasting needed.
// --------------------------------------------------------------
router.post('/seed-assessment', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'This test-only route is restricted to admins' });
  }

  const userId = req.user.userId;

  const pairing = await prisma.developerPairing.create({
    data: { developerId: userId, developeeId: userId, assignedBy: userId },
  });

  const plan = await prisma.developmentPlan.create({ data: { pairingId: pairing.id } });

  // Add the user as both developer and developee on this test plan,
  // so they can access it under the new access-control rules.
  await prisma.planParticipant.create({
    data: { planId: plan.id, userId, participantRole: 'DEVELOPER' },
  });

  const module4 = await prisma.module.create({
    data: { planId: plan.id, sequenceOrder: 4, status: 'COMPLETED', completedAt: new Date() },
  });

  const assessment = await prisma.assessment.create({
    data: { planId: plan.id, gatePosition: 'AFTER_MODULE_4', status: 'PENDING' },
  });

  res.json({ pairingId: pairing.id, planId: plan.id, module4Id: module4.id, assessmentId: assessment.id });
});

module.exports = router;
