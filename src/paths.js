// ============================================================
// DEVELOPMENT PATH ROUTES
// A path is a distinct named curriculum (e.g. "Front of House
// Senior Team Member") with its own separate set of 8 modules.
// Admin-only to manage; needed by anyone starting a plan.
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

// List all paths - any logged-in user can see the list (needed
// when starting a plan), but only admins can create/edit/delete.
router.get('/', requireAuth, async (req, res) => {
  const paths = await prisma.developmentPath.findMany({
    orderBy: { createdAt: 'asc' },
  });
  res.json(paths);
});

router.post('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name, description, moduleCount, goalDays, maxDays } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const count = moduleCount ? parseInt(moduleCount, 10) : 8;
  if (!Number.isInteger(count) || count < 1) {
    return res.status(400).json({ error: 'moduleCount must be a positive whole number' });
  }

  const goal = goalDays ? parseInt(goalDays, 10) : 30;
  const max = maxDays ? parseInt(maxDays, 10) : 40;
  if (!Number.isInteger(goal) || goal < 1) {
    return res.status(400).json({ error: 'goalDays must be a positive whole number' });
  }
  if (!Number.isInteger(max) || max < 1) {
    return res.status(400).json({ error: 'maxDays must be a positive whole number' });
  }
  if (max < goal) {
    return res.status(400).json({ error: 'maxDays must be greater than or equal to goalDays' });
  }

  const existing = await prisma.developmentPath.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return res.status(409).json({ error: 'A path with that name already exists' });
  }

  const path = await prisma.developmentPath.create({
    data: { name: name.trim(), description: description || '', moduleCount: count, goalDays: goal, maxDays: max },
  });

  res.status(201).json(path);
});

router.put('/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const existing = await prisma.developmentPath.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const updated = await prisma.developmentPath.update({
    where: { id: req.params.id },
    data: { name: name.trim(), description: description || '' },
  });

  res.json(updated);
});

// Deleting a path cascades to its own module templates (and their
// sections/tasks), but NEVER touches plans already created from it -
// those keep their own copied content and the pathName snapshot,
// regardless of what happens to the path definition afterward.
router.delete('/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const existing = await prisma.developmentPath.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Path not found' });
  }

  await prisma.developmentPath.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

module.exports = router;
