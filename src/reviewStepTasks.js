// ============================================================
// REVIEW STEP TASK TEMPLATE ROUTES
// Admin-only content authoring for the midterm/final review step
// content, scoped per path + gate. Copied into real tasks the
// moment a plan's review step opens (see modules.js, where review
// steps get created when a midpoint/final module completes).
//
// Two task types only: FLASHCARD (memorization, pure client-side
// flip, never blocks anything) and ACTION_ITEM (a self-check with
// its own checkbox - all of them must be checked before the review
// step can be marked complete).
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

const VALID_GATES = ['AFTER_MODULE_4', 'AFTER_MODULE_8'];
const VALID_TYPES = ['ACTION_ITEM', 'FLASHCARD'];

// List a path's review-step tasks for one gate (midterm or final).
router.get('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId, gatePosition } = req.query;
  if (!pathId || !gatePosition) {
    return res.status(400).json({ error: 'pathId and gatePosition query parameters are both required' });
  }
  if (!VALID_GATES.includes(gatePosition)) {
    return res.status(400).json({ error: `gatePosition must be one of: ${VALID_GATES.join(', ')}` });
  }

  const tasks = await prisma.reviewStepTaskTemplate.findMany({
    where: { pathId, gatePosition },
    orderBy: { order: 'asc' },
    include: { checklistItemTemplates: { orderBy: { order: 'asc' } } },
  });

  res.json(tasks);
});

// Add a task to a path's midterm or final review step.
router.post('/path/:pathId/gate/:gatePosition', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId, gatePosition } = req.params;
  if (!VALID_GATES.includes(gatePosition)) {
    return res.status(400).json({ error: `gatePosition must be one of: ${VALID_GATES.join(', ')}` });
  }

  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const { text, content, taskType, link, checklistItems } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (taskType && !VALID_TYPES.includes(taskType)) {
    return res.status(400).json({ error: `taskType must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (taskType === 'FLASHCARD' && (!Array.isArray(checklistItems) || checklistItems.length === 0)) {
    return res.status(400).json({ error: 'A FLASHCARD task needs at least one card' });
  }

  const existingCount = await prisma.reviewStepTaskTemplate.count({ where: { pathId, gatePosition } });

  const task = await prisma.reviewStepTaskTemplate.create({
    data: {
      pathId,
      gatePosition,
      order: existingCount + 1,
      text: text.trim(),
      content: content || '',
      taskType: taskType || 'ACTION_ITEM',
      link: taskType === 'ACTION_ITEM' ? (link || null) : null,
    },
  });

  if (taskType === 'FLASHCARD') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.reviewStepChecklistItemTemplate.create({
        data: {
          taskTemplateId: task.id,
          order: i + 1,
          text: checklistItems[i].text,
          description: checklistItems[i].description || null,
        },
      });
    }
  }

  res.status(201).json(task);
});

// Reorder tasks within a path's gate. Body: { taskIds: [...] }
// IMPORTANT: registered BEFORE '/:taskId' below - otherwise Express
// would match "reorder" as if it were a task ID and this route
// would never be reached.
router.put('/reorder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { taskIds } = req.body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: 'taskIds must be a non-empty array' });
  }

  for (let i = 0; i < taskIds.length; i++) {
    await prisma.reviewStepTaskTemplate.update({
      where: { id: taskIds[i] },
      data: { order: i + 1 },
    });
  }

  res.json({ reordered: taskIds.length });
});

router.put('/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { text, content, taskType, link, checklistItems } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (taskType && !VALID_TYPES.includes(taskType)) {
    return res.status(400).json({ error: `taskType must be one of: ${VALID_TYPES.join(', ')}` });
  }
  if (taskType === 'FLASHCARD' && (!Array.isArray(checklistItems) || checklistItems.length === 0)) {
    return res.status(400).json({ error: 'A FLASHCARD task needs at least one card' });
  }

  const existing = await prisma.reviewStepTaskTemplate.findUnique({ where: { id: req.params.taskId } });
  if (!existing) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const updated = await prisma.reviewStepTaskTemplate.update({
    where: { id: req.params.taskId },
    data: {
      text: text.trim(),
      content: content || '',
      taskType: taskType || 'ACTION_ITEM',
      link: taskType === 'ACTION_ITEM' ? (link || null) : null,
    },
  });

  await prisma.reviewStepChecklistItemTemplate.deleteMany({ where: { taskTemplateId: updated.id } });
  if (taskType === 'FLASHCARD') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.reviewStepChecklistItemTemplate.create({
        data: {
          taskTemplateId: updated.id,
          order: i + 1,
          text: checklistItems[i].text,
          description: checklistItems[i].description || null,
        },
      });
    }
  }

  res.json(updated);
});

router.delete('/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  await prisma.reviewStepTaskTemplate.delete({ where: { id: req.params.taskId } });
  res.status(204).send();
});

module.exports = router;
