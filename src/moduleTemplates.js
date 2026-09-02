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

const VALID_TYPES = ['READING', 'NOTICE', 'WARNING', 'QUESTION', 'CHECKLIST', 'MULTIPLE_CHOICE', 'ACTION_ITEM', 'VIDEO'];

// Notice and Warning tasks are never shown by their title to the
// person viewing the section - the title is purely a label for the
// admin's own list, so it doesn't need to be required for those two.
const TITLE_OPTIONAL_TYPES = ['NOTICE', 'WARNING'];

function resolveTaskTitle(text, taskType) {
  if (text && text.trim()) return text.trim();
  if (taskType === 'NOTICE') return 'Info';
  if (taskType === 'WARNING') return 'Important';
  return null; // still missing and required
}

function validateTaskShape({ taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link }) {
  if (taskType && !VALID_TYPES.includes(taskType)) {
    return `taskType must be one of: ${VALID_TYPES.join(', ')}`;
  }
  if (assignedTo && !['DEVELOPER', 'DEVELOPEE'].includes(assignedTo)) {
    return 'assignedTo must be DEVELOPER or DEVELOPEE';
  }
  if (taskType === 'QUESTION' && !correctAnswer) {
    return 'A QUESTION task needs a correctAnswer for it to be gradeable';
  }
  if (taskType === 'VIDEO' && !link) {
    return 'A VIDEO task needs a link to the video';
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

// List all 8 templates FOR A SPECIFIC PATH, with their sections and each section's tasks.
router.get('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId } = req.query;
  if (!pathId) {
    return res.status(400).json({ error: 'pathId query parameter is required' });
  }

  const templates = await prisma.moduleTemplate.findMany({
    where: { pathId },
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

// Create or update the template for a given sequence position (1-8)
// WITHIN A SPECIFIC PATH. Uses literal "path"/"module" markers in the
// URL (not just two bare wildcard segments) so this can never collide
// with another route, regardless of registration order.
router.put('/path/:pathId/module/:sequenceOrder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId } = req.params;
  const sequenceOrder = parseInt(req.params.sequenceOrder, 10);
  if (sequenceOrder < 1 || sequenceOrder > 8) {
    return res.status(400).json({ error: 'sequenceOrder must be between 1 and 8' });
  }

  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const { title, description } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const template = await prisma.moduleTemplate.upsert({
    where: { pathId_sequenceOrder: { pathId, sequenceOrder } },
    update: { title, description: description || '' },
    create: { pathId, sequenceOrder, title, description: description || '' },
  });

  res.json(template);
});

// --------------------------------------------------------------
// SECTIONS - each becomes its own page once copied into a real plan.
// --------------------------------------------------------------

// Add a section to a specific path's module template.
router.post('/path/:pathId/module/:sequenceOrder/sections', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId } = req.params;
  const sequenceOrder = parseInt(req.params.sequenceOrder, 10);
  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const template = await prisma.moduleTemplate.findUnique({
    where: { pathId_sequenceOrder: { pathId, sequenceOrder } },
  });
  if (!template) {
    return res.status(404).json({ error: 'No template exists yet for this module - create it first with PUT' });
  }

  const existingCount = await prisma.moduleSectionTemplate.count({ where: { moduleTemplateId: template.id } });

  const section = await prisma.moduleSectionTemplate.create({
    data: {
      moduleTemplateId: template.id,
      order: existingCount + 1,
      title,
    },
  });

  res.status(201).json(section);
});

// Reorder the sections within a module template. Body: { sectionIds: [...] }
// in the desired new order. Doesn't need to know which path/module -
// it just reorders the specific section IDs given.
// IMPORTANT: this must be registered BEFORE '/sections/:sectionId'
// below - otherwise Express would match "reorder" as if it were a
// section ID and this route would never be reached.
router.put('/sections/reorder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { sectionIds } = req.body;
  if (!Array.isArray(sectionIds) || sectionIds.length === 0) {
    return res.status(400).json({ error: 'sectionIds must be a non-empty array' });
  }

  for (let i = 0; i < sectionIds.length; i++) {
    await prisma.moduleSectionTemplate.update({
      where: { id: sectionIds[i] },
      data: { order: i + 1 },
    });
  }

  res.json({ reordered: sectionIds.length });
});

// Update a section's title.
router.put('/sections/:sectionId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const existing = await prisma.moduleSectionTemplate.findUnique({ where: { id: req.params.sectionId } });
  if (!existing) {
    return res.status(404).json({ error: 'Section not found' });
  }

  const updated = await prisma.moduleSectionTemplate.update({
    where: { id: req.params.sectionId },
    data: { title },
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

  const { text, content, taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link } = req.body;
  const resolvedText = resolveTaskTitle(text, taskType);
  if (!resolvedText) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link });
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
      text: resolvedText,
      content: content || '',
      taskType: taskType || 'READING',
      assignedTo: assignedTo || 'DEVELOPEE',
      link: ['ACTION_ITEM', 'VIDEO'].includes(taskType) ? (link || null) : null,
      correctAnswer: taskType === 'QUESTION' ? correctAnswer : null,
    },
  });

  if (taskType === 'CHECKLIST') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.checklistItemTemplate.create({
        data: {
          taskTemplateId: task.id,
          order: i + 1,
          text: checklistItems[i].text,
          description: checklistItems[i].description || null,
          link: checklistItems[i].link || null,
        },
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

  const { text, content, taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link } = req.body;
  const resolvedText = resolveTaskTitle(text, taskType);
  if (!resolvedText) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link });
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
      text: resolvedText,
      content: content || '',
      taskType: taskType || 'READING',
      assignedTo: assignedTo || 'DEVELOPEE',
      correctAnswer: taskType === 'QUESTION' ? correctAnswer : null,
      link: ['ACTION_ITEM', 'VIDEO'].includes(taskType) ? (link || null) : null,
    },
  });

  await prisma.checklistItemTemplate.deleteMany({ where: { taskTemplateId: updated.id } });
  await prisma.choiceOptionTemplate.deleteMany({ where: { taskTemplateId: updated.id } });

  if (taskType === 'CHECKLIST') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.checklistItemTemplate.create({
        data: {
          taskTemplateId: updated.id,
          order: i + 1,
          text: checklistItems[i].text,
          description: checklistItems[i].description || null,
          link: checklistItems[i].link || null,
        },
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

// Reorder the tasks within a section. Body: { taskIds: [...] } in the
// desired new order.
router.put('/sections/:sectionId/tasks/reorder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { taskIds } = req.body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: 'taskIds must be a non-empty array' });
  }

  for (let i = 0; i < taskIds.length; i++) {
    await prisma.moduleTaskTemplate.update({
      where: { id: taskIds[i] },
      data: { order: i + 1 },
    });
  }

  res.json({ reordered: taskIds.length });
});

// Remove one task.
router.delete('/tasks/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  await prisma.moduleTaskTemplate.delete({ where: { id: req.params.taskId } });
  res.status(204).send();
});

module.exports = router;
