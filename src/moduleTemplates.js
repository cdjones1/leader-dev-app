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

const VALID_TYPES = ['READING', 'NOTICE', 'WARNING', 'QUESTION', 'CHECKLIST', 'MULTIPLE_CHOICE', 'ACTION_ITEM', 'VIDEO', 'FLASHCARD', 'SECTION_QUIZ', 'COMPARISON_TABLE', 'NUMBERED_STEPS'];

// Notice and Warning tasks are never shown by their title to the
// person viewing the section - the title is purely a label for the
// admin's own list, so it doesn't need to be required for those two.
const TITLE_OPTIONAL_TYPES = ['NOTICE', 'WARNING', 'QUESTION'];

function resolveTaskTitle(text, taskType) {
  if (text && text.trim()) return text.trim();
  if (taskType === 'NOTICE') return 'Info';
  if (taskType === 'WARNING') return 'Important';
  if (taskType === 'QUESTION') return 'Study Question';
  if (taskType === 'MULTIPLE_CHOICE') return 'Multiple Choice';
  return null; // still missing and required
}

function validateTaskShape({ taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link, quizQuestions }) {
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
  if ((taskType === 'CHECKLIST' || taskType === 'FLASHCARD' || taskType === 'COMPARISON_TABLE' || taskType === 'NUMBERED_STEPS') && (!Array.isArray(checklistItems) || checklistItems.length === 0)) {
    const label = taskType === 'FLASHCARD' ? 'A FLASHCARD task needs at least one card'
      : taskType === 'COMPARISON_TABLE' ? 'A COMPARISON_TABLE task needs at least one row'
      : 'A CHECKLIST task needs at least one checklist item';
    return label;
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
  if (taskType === 'SECTION_QUIZ') {
    if (!Array.isArray(quizQuestions) || quizQuestions.length === 0) {
      return 'A SECTION_QUIZ task needs at least one question';
    }
    for (const q of quizQuestions) {
      if (!q.text || !q.text.trim()) {
        return 'Every quiz question needs its own text';
      }
      if (!Array.isArray(q.choiceOptions) || q.choiceOptions.length < 2) {
        return `Quiz question "${q.text}" needs at least 2 options`;
      }
      if (!q.choiceOptions.some((o) => o.isCorrect)) {
        return `Quiz question "${q.text}" needs exactly one option marked correct`;
      }
      if (q.choiceOptions.filter((o) => o.isCorrect).length > 1) {
        return `Quiz question "${q.text}" can only have ONE correct option`;
      }
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
              quizQuestionTemplates: {
                orderBy: { order: 'asc' },
                include: { choiceOptionTemplates: { orderBy: { order: 'asc' } } },
              },
            },
          },
        },
      },
    },
    orderBy: { sequenceOrder: 'asc' },
  });

  res.json(templates);
});

// --------------------------------------------------------------
// COPY a module's full content (every section, task, and all their
// type-specific data) from one path's module slot into another
// path's module slot. By default refuses to overwrite a target that
// already has content - pass replace:true to explicitly allow it.
// The target's own title/description are left untouched; only the
// sections/tasks tree is replaced.
// --------------------------------------------------------------
router.post('/copy', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { sourcePathId, sourceSequenceOrder, targetPathId, targetSequenceOrder, replace } = req.body;
  if (!sourcePathId || !sourceSequenceOrder || !targetPathId || !targetSequenceOrder) {
    return res.status(400).json({ error: 'sourcePathId, sourceSequenceOrder, targetPathId, and targetSequenceOrder are all required' });
  }
  if (sourcePathId === targetPathId && Number(sourceSequenceOrder) === Number(targetSequenceOrder)) {
    return res.status(400).json({ error: 'Source and target are the same module' });
  }

  const sourceTemplate = await prisma.moduleTemplate.findUnique({
    where: { pathId_sequenceOrder: { pathId: sourcePathId, sequenceOrder: Number(sourceSequenceOrder) } },
    include: {
      sectionTemplates: {
        orderBy: { order: 'asc' },
        include: {
          taskTemplates: {
            orderBy: { order: 'asc' },
            include: {
              checklistItemTemplates: { orderBy: { order: 'asc' } },
              choiceOptionTemplates: { orderBy: { order: 'asc' } },
              quizQuestionTemplates: {
                orderBy: { order: 'asc' },
                include: { choiceOptionTemplates: { orderBy: { order: 'asc' } } },
              },
            },
          },
        },
      },
    },
  });
  if (!sourceTemplate) {
    return res.status(404).json({ error: 'Source module not found - make sure it has been saved (given a title) first' });
  }

  const targetPath = await prisma.developmentPath.findUnique({ where: { id: targetPathId } });
  if (!targetPath) {
    return res.status(404).json({ error: 'Target path not found' });
  }

  let targetTemplate = await prisma.moduleTemplate.findUnique({
    where: { pathId_sequenceOrder: { pathId: targetPathId, sequenceOrder: Number(targetSequenceOrder) } },
  });

  if (!targetTemplate) {
    // No template saved yet for this slot - create a bare one so
    // there's somewhere for the copied content to attach to.
    targetTemplate = await prisma.moduleTemplate.create({
      data: {
        pathId: targetPathId,
        sequenceOrder: Number(targetSequenceOrder),
        title: sourceTemplate.title,
        description: sourceTemplate.description,
      },
    });
  } else {
    const existingSectionCount = await prisma.moduleSectionTemplate.count({ where: { moduleTemplateId: targetTemplate.id } });
    if (existingSectionCount > 0 && !replace) {
      return res.status(400).json({
        error: `Module ${targetSequenceOrder} in the target path already has ${existingSectionCount} section(s) of content - pass replace:true to overwrite it`,
        existingSectionCount,
      });
    }
    if (existingSectionCount > 0) {
      await prisma.moduleSectionTemplate.deleteMany({ where: { moduleTemplateId: targetTemplate.id } }); // cascades every task and sub-item
    }
  }

  for (const sectionTemplate of sourceTemplate.sectionTemplates) {
    const newSection = await prisma.moduleSectionTemplate.create({
      data: { moduleTemplateId: targetTemplate.id, order: sectionTemplate.order, title: sectionTemplate.title },
    });

    for (const taskTemplate of sectionTemplate.taskTemplates) {
      const newTask = await prisma.moduleTaskTemplate.create({
        data: {
          sectionTemplateId: newSection.id,
          order: taskTemplate.order,
          text: taskTemplate.text,
          content: taskTemplate.content,
          taskType: taskTemplate.taskType,
          assignedTo: taskTemplate.assignedTo,
          correctAnswer: taskTemplate.correctAnswer,
          link: taskTemplate.link,
          pageReference: taskTemplate.pageReference,
          tableLeftHeader: taskTemplate.tableLeftHeader,
          tableRightHeader: taskTemplate.tableRightHeader,
          tableHeaderColor: taskTemplate.tableHeaderColor,
          tableRowColorA: taskTemplate.tableRowColorA,
          tableRowColorB: taskTemplate.tableRowColorB,
        },
      });

      for (const item of taskTemplate.checklistItemTemplates) {
        await prisma.checklistItemTemplate.create({
          data: { taskTemplateId: newTask.id, order: item.order, text: item.text, description: item.description, link: item.link, quoteText: item.quoteText },
        });
      }

      for (const option of taskTemplate.choiceOptionTemplates) {
        await prisma.choiceOptionTemplate.create({
          data: { taskTemplateId: newTask.id, order: option.order, text: option.text, isCorrect: option.isCorrect },
        });
      }

      for (const qt of taskTemplate.quizQuestionTemplates) {
        const newQuestion = await prisma.sectionQuizQuestionTemplate.create({
          data: { taskTemplateId: newTask.id, order: qt.order, text: qt.text, content: qt.content },
        });
        for (const opt of qt.choiceOptionTemplates) {
          await prisma.sectionQuizChoiceOptionTemplate.create({
            data: { questionTemplateId: newQuestion.id, order: opt.order, text: opt.text, isCorrect: opt.isCorrect },
          });
        }
      }
    }
  }

  res.json({ copied: true, sectionsCount: sourceTemplate.sectionTemplates.length });
});

// Create or update the template for a given sequence position (1-8)
// WITHIN A SPECIFIC PATH. Uses literal "path"/"module" markers in the
// URL (not just two bare wildcard segments) so this can never collide
// with another route, regardless of registration order.
router.put('/path/:pathId/module/:sequenceOrder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId } = req.params;
  const sequenceOrder = parseInt(req.params.sequenceOrder, 10);

  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) {
    return res.status(404).json({ error: 'Path not found' });
  }
  if (sequenceOrder < 1 || sequenceOrder > path.moduleCount) {
    return res.status(400).json({ error: `sequenceOrder must be between 1 and ${path.moduleCount} for this path` });
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

  const { text, content, taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link, pageReference, quizQuestions, tableLeftHeader, tableRightHeader, tableHeaderColor, tableRowColorA, tableRowColorB } = req.body;
  const resolvedText = resolveTaskTitle(text, taskType);
  if (!resolvedText) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link, quizQuestions });
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
      pageReference: taskType === 'QUESTION' ? (pageReference || null) : null,
      tableLeftHeader: taskType === 'COMPARISON_TABLE' ? (tableLeftHeader || null) : null,
      tableRightHeader: taskType === 'COMPARISON_TABLE' ? (tableRightHeader || null) : null,
      tableHeaderColor: taskType === 'COMPARISON_TABLE' ? (tableHeaderColor || null) : null,
      tableRowColorA: taskType === 'COMPARISON_TABLE' ? (tableRowColorA || null) : null,
      tableRowColorB: taskType === 'COMPARISON_TABLE' ? (tableRowColorB || null) : null,
    },
  });

  if (taskType === 'CHECKLIST' || taskType === 'FLASHCARD' || taskType === 'COMPARISON_TABLE' || taskType === 'NUMBERED_STEPS') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.checklistItemTemplate.create({
        data: {
          taskTemplateId: task.id,
          order: i + 1,
          text: checklistItems[i].text,
          description: checklistItems[i].description || null,
          link: checklistItems[i].link || null,
          quoteText: checklistItems[i].quoteText || null,
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

  if (taskType === 'SECTION_QUIZ') {
    for (let i = 0; i < quizQuestions.length; i++) {
      const qq = quizQuestions[i];
      const question = await prisma.sectionQuizQuestionTemplate.create({
        data: { taskTemplateId: task.id, order: i + 1, text: qq.text, content: qq.content || '' },
      });
      for (let j = 0; j < qq.choiceOptions.length; j++) {
        await prisma.sectionQuizChoiceOptionTemplate.create({
          data: {
            questionTemplateId: question.id,
            order: j + 1,
            text: qq.choiceOptions[j].text,
            isCorrect: !!qq.choiceOptions[j].isCorrect,
          },
        });
      }
    }
  }

  res.status(201).json(task);
});

// Update an existing task. Sub-items are fully replaced on every update.
router.put('/tasks/:taskId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { text, content, taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link, pageReference, quizQuestions, tableLeftHeader, tableRightHeader, tableHeaderColor, tableRowColorA, tableRowColorB } = req.body;
  const resolvedText = resolveTaskTitle(text, taskType);
  if (!resolvedText) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateTaskShape({ taskType, assignedTo, correctAnswer, checklistItems, choiceOptions, link, quizQuestions });
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
      pageReference: taskType === 'QUESTION' ? (pageReference || null) : null,
      tableLeftHeader: taskType === 'COMPARISON_TABLE' ? (tableLeftHeader || null) : null,
      tableRightHeader: taskType === 'COMPARISON_TABLE' ? (tableRightHeader || null) : null,
      tableHeaderColor: taskType === 'COMPARISON_TABLE' ? (tableHeaderColor || null) : null,
      tableRowColorA: taskType === 'COMPARISON_TABLE' ? (tableRowColorA || null) : null,
      tableRowColorB: taskType === 'COMPARISON_TABLE' ? (tableRowColorB || null) : null,
      link: ['ACTION_ITEM', 'VIDEO'].includes(taskType) ? (link || null) : null,
    },
  });

  await prisma.checklistItemTemplate.deleteMany({ where: { taskTemplateId: updated.id } });
  await prisma.choiceOptionTemplate.deleteMany({ where: { taskTemplateId: updated.id } });
  await prisma.sectionQuizQuestionTemplate.deleteMany({ where: { taskTemplateId: updated.id } }); // cascades its own choice options

  if (taskType === 'CHECKLIST' || taskType === 'FLASHCARD' || taskType === 'COMPARISON_TABLE' || taskType === 'NUMBERED_STEPS') {
    for (let i = 0; i < checklistItems.length; i++) {
      await prisma.checklistItemTemplate.create({
        data: {
          taskTemplateId: updated.id,
          order: i + 1,
          text: checklistItems[i].text,
          description: checklistItems[i].description || null,
          link: checklistItems[i].link || null,
          quoteText: checklistItems[i].quoteText || null,
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

  if (taskType === 'SECTION_QUIZ') {
    for (let i = 0; i < quizQuestions.length; i++) {
      const qq = quizQuestions[i];
      const question = await prisma.sectionQuizQuestionTemplate.create({
        data: { taskTemplateId: updated.id, order: i + 1, text: qq.text, content: qq.content || '' },
      });
      for (let j = 0; j < qq.choiceOptions.length; j++) {
        await prisma.sectionQuizChoiceOptionTemplate.create({
          data: {
            questionTemplateId: question.id,
            order: j + 1,
            text: qq.choiceOptions[j].text,
            isCorrect: !!qq.choiceOptions[j].isCorrect,
          },
        });
      }
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
