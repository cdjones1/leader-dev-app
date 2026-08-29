// ============================================================
// MODULE TEMPLATE ROUTES
// Admin-only. Defines the reusable content (title, description,
// task checklist) for each of the 8 module "slots." Every new
// plan copies this content into its own Module records at
// creation time - editing a template later never changes plans
// already in progress.
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

// List all 8 templates (however many exist so far) with their tasks.
router.get('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const templates = await prisma.moduleTemplate.findMany({
    include: { taskTemplates: { orderBy: { order: 'asc' } } },
    orderBy: { sequenceOrder: 'asc' },
  });

  res.json(templates);
});

// Create or update the template for a given sequence position (1-8).
// This is an "upsert" - if a template for this slot already exists,
// its title/description are replaced; otherwise a new one is created.
router.put('/:sequenceOrder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sequenceOrder = parseInt(req.params.sequenceOrder, 10);
  if (sequenceOrder < 1 || sequenceOrder > 8) {
    return res.status(400).json({ error: 'sequenceOrder must be between 1 and 8' });
  }

  const { title, description } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const template = await prisma.moduleTemplate.upsert({
    where: { sequenceOrder },
    update: { title, description: description || '' },
    create: { sequenceOrder, title, description: description || '' },
  });

  res.json(template);
});

// Add one task to a template's checklist.
router.post('/:sequenceOrder/tasks', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sequenceOrder = parseInt(req.params.sequenceOrder, 10);
  const { text, content, taskType, correctAnswer } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (taskType && !['READING', 'QUESTION'].includes(taskType)) {
    return res.status(400).json({ error: 'taskType must be READING or QUESTION' });
  }
  if (taskType === 'QUESTION' && !correctAnswer) {
    return res.status(400).json({ error: 'A QUESTION task needs a correctAnswer for it to be gradeable' });
  }

  const template = await prisma.moduleTemplate.findUnique({ where: { sequenceOrder } });
  if (!template) {
    return res.status(404).json({ error: 'No template exists yet for this module - create it first with PUT' });
  }

  const existingCount = await prisma.moduleTaskTemplate.count({ where: { moduleTemplateId: template.id } });

  const task = await prisma.moduleTaskTemplate.create({
    data: {
      moduleTemplateId: template.id,
      order: existingCount + 1,
      text,
      content: content || '',
      taskType: taskType || 'READING',
      correctAnswer: taskType === 'QUESTION' ? correctAnswer : null,
    },
  });

  res.status(201).json(task);
});

// Remove one task from a template's checklist.
router.delete('/tasks/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  await prisma.moduleTaskTemplate.delete({ where: { id: req.params.taskId } });
  res.status(204).send();
});

module.exports = router;
