// ============================================================
// PAIRING ROUTES
// Admin creates a developer <-> developee pairing. This has
// existed only as a test-data shortcut until now - this is the
// real version.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can create a pairing' });
  }

  const { developerId, developeeId } = req.body;
  if (!developerId || !developeeId) {
    return res.status(400).json({ error: 'developerId and developeeId are required' });
  }

  const [developer, developee] = await Promise.all([
    prisma.user.findUnique({ where: { id: developerId } }),
    prisma.user.findUnique({ where: { id: developeeId } }),
  ]);
  if (!developer) return res.status(404).json({ error: 'developerId does not match a real user' });
  if (!developee) return res.status(404).json({ error: 'developeeId does not match a real user' });

  const pairing = await prisma.developerPairing.create({
    data: { developerId, developeeId, assignedBy: req.user.userId },
    include: { developer: true, developee: true },
  });

  res.status(201).json(pairing);
});

// List all pairings - admin sees everything, others see only their own
// (this mirrors the existing GET /pairings logic in index.js, but as
// its own file so it's easier to find and extend).
router.get('/', requireAuth, async (req, res) => {
  const where = req.user.isAdmin
    ? {}
    : { OR: [{ developerId: req.user.userId }, { developeeId: req.user.userId }] };

  const pairings = await prisma.developerPairing.findMany({
    where,
    include: { developer: true, developee: true },
  });

  res.json(pairings);
});

// --------------------------------------------------------------
// DELETE a pairing - admin only. Refuses if any plans still exist
// for this pairing (delete those first) - this is intentionally
// NOT cascading, since deleting someone's plan history should
// always be a separate, deliberate action from deleting the pairing.
// --------------------------------------------------------------
router.delete('/:id', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can delete a pairing' });
  }

  const existingPlans = await prisma.developmentPlan.count({ where: { pairingId: req.params.id } });
  if (existingPlans > 0) {
    return res.status(400).json({
      error: `This pairing still has ${existingPlans} plan(s). Delete those first, then delete the pairing.`,
    });
  }

  const pairing = await prisma.developerPairing.findUnique({ where: { id: req.params.id } });
  if (!pairing) {
    return res.status(404).json({ error: 'Pairing not found' });
  }

  await prisma.developerPairing.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

module.exports = router;
