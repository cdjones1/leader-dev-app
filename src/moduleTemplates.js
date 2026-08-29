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

const VALID_TYPES = ['READING', 'QUESTION', 'CHECKLIST', 'MULTIPLE_CHOICE'];

// Checks that the sub-content for a task actually matches its type,
// and returns a clear error if not - used by both create and update.
function validateTaskShape({ taskType, correctAnswer, checklistItems, choiceOptions, assignedTo }) {
  if (taskType && !VALID_TYPES.includes(taskType)) {
    return `taskType must be one of: ${VALID_TYPES.join(', ')}`;
  }
  if (assignedTo && !['DEVELOPER', 'DEVELOPEE'].includes(assignedTo)) {
    return 'assignedTo must be DEVELOPER or DEVELOPEE';
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

// List all 8 templates (however many exist so far) with their tasks.
router.get('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const templates = await prisma.moduleTemplate.findMany({
    include: {
      taskTemplates: {
        orderBy: { order: 'asc' },
        include: {
          checklistItemTemplates: { orderBy: { order: 'asc' } },
          choiceOptionTemplates: { orderBy: { order: 'asc' } },
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

// Add one task to a template. checklistItems: [{text}], choiceOptions: [{text, isCorrect}].
router.post('/:sequenceOrder/tasks', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const sequenceOrder = parseInt(req.params.sequenceOrder, 10);
  const { text, content, taskType, correctAnswer, checklistItems, choiceOptions, assignedTo, section } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, correctAnswer, checklistItems, choiceOptions, assignedTo });
  if (shapeError) {
    return res.status(400).json({ error: shapeError });
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
      section: section || null,
      text,
      content: content || '',
      taskType: taskType || 'READING',
      assignedTo: assignedTo || 'DEVELOPEE',
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

// Update an existing task. Sub-items (checklist items / choice options)
// are fully replaced on every update, matching the "edit reloads the
// whole form, resubmit replaces it" pattern already used for the main
// task fields.
router.put('/tasks/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { text, content, taskType, correctAnswer, checklistItems, choiceOptions, assignedTo, section } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, correctAnswer, checklistItems, choiceOptions, assignedTo });
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
      section: section || null,
      content: content || '',
      taskType: taskType || 'READING',
      assignedTo: assignedTo || 'DEVELOPEE',
      correctAnswer: taskType === 'QUESTION' ? correctAnswer : null,
    },
  });

  // Replace all sub-items with whatever was just submitted.
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

// Remove one task from a template's checklist.
router.delete('/tasks/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  await prisma.moduleTaskTemplate.delete({ where: { id: req.params.taskId } });
  res.status(204).send();
});

module.exports = router;
