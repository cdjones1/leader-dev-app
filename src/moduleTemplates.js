// ============================================================
// MODULE TEMPLATE ROUTES
// Admin-only. Defines the reusable content for each of the 8
// module "slots" - now organized as SECTIONS (each its own page
// once copied into a real plan), each holding a group of tasks.
// Editing a template later never changes plans already in progress.
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

const VALID_TYPES = ['READING', 'NOTICE', 'WARNING', 'QUESTION', 'CHECKLIST', 'MULTIPLE_CHOICE'];

function validateTaskShape({ taskType, correctAnswer, checklistItems, choiceOptions }) {
  if (taskType && !VALID_TYPES.includes(taskType)) {
    return `taskType must be one of: ${VALID_TYPES.join(', ')}`;
  }
  if (taskType === 'QUESTION' && !correctAnswer) {
    return 'A QUESTION task needs a correctAnswer for it to be gradeable';
  }
  if (taskType === 'CHECKLIST' && (!Array.isArray(checklistItems) || checklistItems.length === 0)) {
    return 'A CHECKLIST task needs at least one checklist item';
  }
  if (taskType === 'MULTIPLE_CHOICE') {
    if (!Array.isArray(choiceOptions) || choiceOptions.length < 2) {
      return 'A MULTIPLE_CHOICE task needs at least 2 options';
    }
    if (!choiceOptions.some((o) => o.isCorrect)) {
      return 'A MULTIPLE_CHOICE task needs exactly one option marked correct';
    }
    if (choiceOptions.filter((o) => o.isCorrect).length > 1) {
      return 'A MULTIPLE_CHOICE task can only have ONE correct option';
    }
  }
  return null;
}

// List all 8 templates with their sections and each section's tasks.
router.get('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const templates = await prisma.moduleTemplate.findMany({
    include: {
      sectionTemplates: {
        orderBy: { order: 'asc' },
        include: {
          taskTemplates: {
            orderBy: { order: 'asc' },
            include: {
              checklistItemTemplates: { orderBy: { order: 'asc' } },
              choiceOptionTemplates: { orderBy: { order: 'asc' } },
            },
          },
        },
      },
    },
    orderBy: { sequenceOrder: 'asc' },
  });

  res.json(templates);
});

// Create or update the template for a given sequence position (1-8).
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

// --------------------------------------------------------------
// SECTIONS - each becomes its own page once copied into a real plan.
// --------------------------------------------------------------

// Add a section to a module template.
router.post('/:sequenceOrder/sections', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sequenceOrder = parseInt(req.params.sequenceOrder, 10);
  const { title, assignedTo } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (assignedTo && !['DEVELOPER', 'DEVELOPEE'].includes(assignedTo)) {
    return res.status(400).json({ error: 'assignedTo must be DEVELOPER or DEVELOPEE' });
  }

  const template = await prisma.moduleTemplate.findUnique({ where: { sequenceOrder } });
  if (!template) {
    return res.status(404).json({ error: 'No template exists yet for this module - create it first with PUT' });
  }

  const existingCount = await prisma.moduleSectionTemplate.count({ where: { moduleTemplateId: template.id } });

  const section = await prisma.moduleSectionTemplate.create({
    data: {
      moduleTemplateId: template.id,
      order: existingCount + 1,
      title,
      assignedTo: assignedTo || 'DEVELOPEE',
    },
  });

  res.status(201).json(section);
});

// Update a section's title/assignment.
router.put('/sections/:sectionId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { title, assignedTo } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (assignedTo && !['DEVELOPER', 'DEVELOPEE'].includes(assignedTo)) {
    return res.status(400).json({ error: 'assignedTo must be DEVELOPER or DEVELOPEE' });
  }

  const existing = await prisma.moduleSectionTemplate.findUnique({ where: { id: req.params.sectionId } });
  if (!existing) {
    return res.status(404).json({ error: 'Section not found' });
  }

  const updated = await prisma.moduleSectionTemplate.update({
    where: { id: req.params.sectionId },
    data: { title, assignedTo: assignedTo || 'DEVELOPEE' },
  });

  res.json(updated);
});

// Remove a section entirely (cascades its tasks).
router.delete('/sections/:sectionId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  await prisma.moduleSectionTemplate.delete({ where: { id: req.params.sectionId } });
  res.status(204).send();
});

// --------------------------------------------------------------
// TASKS - now created within a specific section, not directly
// under a module.
// --------------------------------------------------------------

router.post('/sections/:sectionId/tasks', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { text, content, taskType, correctAnswer, checklistItems, choiceOptions } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, correctAnswer, checklistItems, choiceOptions });
  if (shapeError) {
    return res.status(400).json({ error: shapeError });
  }

  const section = await prisma.moduleSectionTemplate.findUnique({ where: { id: req.params.sectionId } });
  if (!section) {
    return res.status(404).json({ error: 'Section not found' });
  }

  const existingCount = await prisma.moduleTaskTemplate.count({ where: { sectionTemplateId: section.id } });

  const task = await prisma.moduleTaskTemplate.create({
    data: {
      sectionTemplateId: section.id,
      order: existingCount + 1,
      text,
      content: content || '',
      taskType: taskType || 'READING',
      correctAnswer: taskType === 'QUESTION' ? correctAnswer : null,
    },
  });

  if (taskType === 'CHECKLIST') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.checklistItemTemplate.create({
        data: { taskTemplateId: task.id, order: i + 1, text: checklistItems[i].text },
      });
    }
  }

  if (taskType === 'MULTIPLE_CHOICE') {
    for (let i = 0; i < choiceOptions.length; i++) {
      await prisma.choiceOptionTemplate.create({
        data: {
          taskTemplateId: task.id,
          order: i + 1,
          text: choiceOptions[i].text,
          isCorrect: !!choiceOptions[i].isCorrect,
        },
      });
    }
  }

  res.status(201).json(task);
});

// Update an existing task. Sub-items are fully replaced on every update.
router.put('/tasks/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { text, content, taskType, correctAnswer, checklistItems, choiceOptions } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, correctAnswer, checklistItems, choiceOptions });
  if (shapeError) {
    return res.status(400).json({ error: shapeError });
  }

  const existing = await prisma.moduleTaskTemplate.findUnique({ where: { id: req.params.taskId } });
  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const updated = await prisma.moduleTaskTemplate.update({
    where: { id: req.params.taskId },
    data: {
      text,
      content: content || '',
      taskType: taskType || 'READING',
      correctAnswer: taskType === 'QUESTION' ? correctAnswer : null,
    },
  });

  await prisma.checklistItemTemplate.deleteMany({ where: { taskTemplateId: updated.id } });
  await prisma.choiceOptionTemplate.deleteMany({ where: { taskTemplateId: updated.id } });

  if (taskType === 'CHECKLIST') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.checklistItemTemplate.create({
        data: { taskTemplateId: updated.id, order: i + 1, text: checklistItems[i].text },
      });
    }
  }

  if (taskType === 'MULTIPLE_CHOICE') {
    for (let i = 0; i < choiceOptions.length; i++) {
      await prisma.choiceOptionTemplate.create({
        data: {
          taskTemplateId: updated.id,
          order: i + 1,
          text: choiceOptions[i].text,
          isCorrect: !!choiceOptions[i].isCorrect,
        },
      });
    }
  }

  res.json(updated);
});

// Remove one task.
router.delete('/tasks/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  await prisma.moduleTaskTemplate.delete({ where: { id: req.params.taskId } });
  res.status(204).send();
});

module.exports = router;
