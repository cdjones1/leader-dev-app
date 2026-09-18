// ============================================================
// REVIEW GATE TEMPLATE ROUTES
// The admin-authored container for a path's midterm/final review
// content. Sections and tasks attached to a review gate use the
// EXACT SAME routes as regular module sections/tasks (see
// moduleTemplates.js's /sections/... and /tasks/... routes) - those
// operate on section/task IDs directly and don't care whether the
// section's parent is a module or a review gate. Only three things
// are genuinely specific to review gates: creating/updating the
// gate itself, adding the FIRST section to it, and listing it.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { midpointModule } = require('./gates');

const router = express.Router();

function requireAdmin(req, res) {
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

const VALID_GATES = ['AFTER_MODULE_4', 'AFTER_MODULE_8'];

// List a path's two review gates (midterm + final), each with their
// sections and tasks, same shape as the module-templates list route.
router.get('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId } = req.query;
  if (!pathId) {
    return res.status(400).json({ error: 'pathId query parameter is required' });
  }

  const gates = await prisma.reviewGateTemplate.findMany({
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
  });

  res.json(gates);
});

// --------------------------------------------------------------
// COPY a review gate's full content (every section, task, and all
// their type-specific data) from one path's midterm/final review
// into another path's midterm/final review. By default refuses to
// overwrite a target that already has content - pass replace:true
// to explicitly allow it. The target gate's own title/description
// are left untouched; only the sections/tasks tree is replaced.
// --------------------------------------------------------------
router.post('/copy', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { sourcePathId, sourceGatePosition, targetPathId, targetGatePosition, replace } = req.body;
  if (!sourcePathId || !sourceGatePosition || !targetPathId || !targetGatePosition) {
    return res.status(400).json({ error: 'sourcePathId, sourceGatePosition, targetPathId, and targetGatePosition are all required' });
  }
  if (!VALID_GATES.includes(sourceGatePosition) || !VALID_GATES.includes(targetGatePosition)) {
    return res.status(400).json({ error: `gatePosition must be one of: ${VALID_GATES.join(', ')}` });
  }
  if (sourcePathId === targetPathId && sourceGatePosition === targetGatePosition) {
    return res.status(400).json({ error: 'Source and target are the same review gate' });
  }

  const sourceGate = await prisma.reviewGateTemplate.findUnique({
    where: { pathId_gatePosition: { pathId: sourcePathId, gatePosition: sourceGatePosition } },
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
  if (!sourceGate) {
    return res.status(404).json({ error: 'Source review gate not found - make sure it has been saved (given a title) first' });
  }

  const targetPath = await prisma.developmentPath.findUnique({ where: { id: targetPathId } });
  if (!targetPath) {
    return res.status(404).json({ error: 'Target path not found' });
  }

  let targetGate = await prisma.reviewGateTemplate.findUnique({
    where: { pathId_gatePosition: { pathId: targetPathId, gatePosition: targetGatePosition } },
  });

  if (!targetGate) {
    targetGate = await prisma.reviewGateTemplate.create({
      data: { pathId: targetPathId, gatePosition: targetGatePosition, title: sourceGate.title, description: sourceGate.description },
    });
  } else {
    const existingSectionCount = await prisma.moduleSectionTemplate.count({ where: { reviewGateTemplateId: targetGate.id } });
    if (existingSectionCount > 0 && !replace) {
      return res.status(400).json({
        error: `The target review already has ${existingSectionCount} section(s) of content - pass replace:true to overwrite it`,
        existingSectionCount,
      });
    }
    if (existingSectionCount > 0) {
      await prisma.moduleSectionTemplate.deleteMany({ where: { reviewGateTemplateId: targetGate.id } }); // cascades every task and sub-item
    }
  }

  for (const sectionTemplate of sourceGate.sectionTemplates) {
    const newSection = await prisma.moduleSectionTemplate.create({
      data: { reviewGateTemplateId: targetGate.id, order: sectionTemplate.order, title: sectionTemplate.title },
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
        },
      });

      for (const item of taskTemplate.checklistItemTemplates) {
        await prisma.checklistItemTemplate.create({
          data: { taskTemplateId: newTask.id, order: item.order, text: item.text, description: item.description, link: item.link },
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

  res.json({ copied: true, sectionsCount: sourceGate.sectionTemplates.length });
});

// Create or update the gate itself (title/description).
router.put('/path/:pathId/gate/:gatePosition', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId, gatePosition } = req.params;
  if (!VALID_GATES.includes(gatePosition)) {
    return res.status(400).json({ error: `gatePosition must be one of: ${VALID_GATES.join(', ')}` });
  }

  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const { title, description } = req.body;

  const gate = await prisma.reviewGateTemplate.upsert({
    where: { pathId_gatePosition: { pathId, gatePosition } },
    update: { title: title || '', description: description || '' },
    create: { pathId, gatePosition, title: title || '', description: description || '' },
  });

  res.json(gate);
});

// Add a section to a review gate (subsequent tasks/sub-items on that
// section go through the normal /module-templates/sections/... and
// /module-templates/tasks/... routes, same as module sections).
router.post('/path/:pathId/gate/:gatePosition/sections', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId, gatePosition } = req.params;
  const { title } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const gate = await prisma.reviewGateTemplate.findUnique({
    where: { pathId_gatePosition: { pathId, gatePosition } },
  });
  if (!gate) {
    return res.status(404).json({ error: 'No review gate exists yet for this path/position - create it first with PUT' });
  }

  const existingCount = await prisma.moduleSectionTemplate.count({ where: { reviewGateTemplateId: gate.id } });

  const section = await prisma.moduleSectionTemplate.create({
    data: {
      reviewGateTemplateId: gate.id,
      order: existingCount + 1,
      title,
    },
  });

  res.status(201).json(section);
});

// Live preview of which flashcards would automatically get pulled in
// from earlier modules for this path/gate, computed from the
// TEMPLATES (since no real plan exists yet during authoring) - the
// exact same module range logic used for real aggregation when a
// review step actually opens (see modules.js).
router.get('/preview-flashcards', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId, gatePosition } = req.query;
  if (!pathId || !gatePosition) {
    return res.status(400).json({ error: 'pathId and gatePosition query parameters are both required' });
  }

  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const midpoint = midpointModule(path.moduleCount);
  // Midterm pulls from modules 1 through the midpoint. Final pulls
  // from the SECOND half only (midpoint+1 through the end) - the
  // material not already covered by the midterm, not a comprehensive
  // re-pull of everything. Must match modules.js's real logic exactly.
  const minSequenceOrder = gatePosition === 'AFTER_MODULE_4' ? 1 : midpoint + 1;
  const maxSequenceOrder = gatePosition === 'AFTER_MODULE_4' ? midpoint : path.moduleCount;

  const priorModuleTemplates = await prisma.moduleTemplate.findMany({
    where: { pathId, sequenceOrder: { gte: minSequenceOrder, lte: maxSequenceOrder } },
    orderBy: { sequenceOrder: 'asc' },
    include: {
      sectionTemplates: {
        orderBy: { order: 'asc' },
        include: {
          taskTemplates: {
            where: { taskType: 'FLASHCARD' },
            orderBy: { order: 'asc' },
            include: { checklistItemTemplates: { orderBy: { order: 'asc' } } },
          },
        },
      },
    },
  });

  const cards = [];
  for (const mt of priorModuleTemplates) {
    const sourceLabel = `Module ${mt.sequenceOrder}${mt.title ? ' — ' + mt.title : ''}`;
    for (const st of mt.sectionTemplates) {
      for (const tt of st.taskTemplates) {
        for (const item of tt.checklistItemTemplates) {
          cards.push({ text: item.text, description: item.description, sourceLabel });
        }
      }
    }
  }

  res.json({ minSequenceOrder, maxSequenceOrder, cards });
});

module.exports = router;
