// ============================================================
// ASSESSMENT QUESTION TEMPLATE ROUTES
// Admin-only content authoring for the midterm/final assessment
// questions, scoped per path + gate. Copied into real questions
// the moment a plan's review step completes (see reviewSteps.js).
//
// Two question types:
//   SHORT_ANSWER - the developer grades it manually; the model
//     answer is never shown to the developee, only to the
//     developer/admin while grading.
//   MULTIPLE_CHOICE - auto-graded immediately on submission, since
//     it's objectively checkable - no developer review needed.
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
const VALID_TYPES = ['SHORT_ANSWER', 'MULTIPLE_CHOICE'];

function validateShape({ questionType, correctAnswer, choiceOptions, points }) {
  if (questionType && !VALID_TYPES.includes(questionType)) {
    return `questionType must be one of: ${VALID_TYPES.join(', ')}`;
  }
  if (points !== undefined && points !== null && (Number.isNaN(Number(points)) || Number(points) <= 0)) {
    return 'points must be a positive number';
  }
  // SHORT_ANSWER intentionally has NO model answer - the developer
  // grades purely on their own judgment of the raw submitted answer,
  // with no reference "correct" text to compare it against.
  if (questionType === 'MULTIPLE_CHOICE') {
    if (!Array.isArray(choiceOptions) || choiceOptions.length < 2) {
      return 'A MULTIPLE_CHOICE question needs at least 2 options';
    }
    if (!choiceOptions.some((o) => o.isCorrect)) {
      return 'A MULTIPLE_CHOICE question needs exactly one option marked correct';
    }
    if (choiceOptions.filter((o) => o.isCorrect).length > 1) {
      return 'A MULTIPLE_CHOICE question can only have ONE correct option';
    }
  }
  return null;
}

// List a path's questions for one gate (midterm or final).
router.get('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { pathId, gatePosition } = req.query;
  if (!pathId || !gatePosition) {
    return res.status(400).json({ error: 'pathId and gatePosition query parameters are both required' });
  }
  if (!VALID_GATES.includes(gatePosition)) {
    return res.status(400).json({ error: `gatePosition must be one of: ${VALID_GATES.join(', ')}` });
  }

  const questions = await prisma.assessmentQuestionTemplate.findMany({
    where: { pathId, gatePosition },
    orderBy: { order: 'asc' },
    include: { choiceOptionTemplates: { orderBy: { order: 'asc' } } },
  });

  res.json(questions);
});

// Add a question to a path's midterm or final assessment.
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

  const { text, content, questionType, correctAnswer, choiceOptions, pageReference, points, groupTitle } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateShape({ questionType, correctAnswer, choiceOptions, points });
  if (shapeError) {
    return res.status(400).json({ error: shapeError });
  }

  const existingCount = await prisma.assessmentQuestionTemplate.count({ where: { pathId, gatePosition } });

  const question = await prisma.assessmentQuestionTemplate.create({
    data: {
      pathId,
      gatePosition,
      order: existingCount + 1,
      text: text.trim(),
      content: content || '',
      questionType: questionType || 'SHORT_ANSWER',
      correctAnswer: questionType === 'MULTIPLE_CHOICE' ? null : (correctAnswer ? correctAnswer.trim() : null),
      pageReference: pageReference || null,
      points: points ? Number(points) : 1,
      groupTitle: groupTitle ? groupTitle.trim() : null,
    },
  });

  if (questionType === 'MULTIPLE_CHOICE') {
    for (let i = 0; i < choiceOptions.length; i++) {
      await prisma.assessmentChoiceOptionTemplate.create({
        data: {
          questionTemplateId: question.id,
          order: i + 1,
          text: choiceOptions[i].text,
          isCorrect: !!choiceOptions[i].isCorrect,
        },
      });
    }
  }

  res.status(201).json(question);
});

// Reorder questions within a path's gate. Body: { questionIds: [...] }
// IMPORTANT: registered BEFORE '/:questionId' below - otherwise
// Express would match "reorder" as if it were a question ID and
// this route would never be reached.
router.put('/reorder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { questionIds } = req.body;
  if (!Array.isArray(questionIds) || questionIds.length === 0) {
    return res.status(400).json({ error: 'questionIds must be a non-empty array' });
  }

  for (let i = 0; i < questionIds.length; i++) {
    await prisma.assessmentQuestionTemplate.update({
      where: { id: questionIds[i] },
      data: { order: i + 1 },
    });
  }

  res.json({ reordered: questionIds.length });
});

router.put('/:questionId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { text, content, questionType, correctAnswer, choiceOptions, pageReference, points, groupTitle } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const shapeError = validateShape({ questionType, correctAnswer, choiceOptions, points });
  if (shapeError) {
    return res.status(400).json({ error: shapeError });
  }

  const existing = await prisma.assessmentQuestionTemplate.findUnique({ where: { id: req.params.questionId } });
  if (!existing) {
    return res.status(404).json({ error: 'Question not found' });
  }

  const updated = await prisma.assessmentQuestionTemplate.update({
    where: { id: req.params.questionId },
    data: {
      text: text.trim(),
      content: content || '',
      questionType: questionType || 'SHORT_ANSWER',
      correctAnswer: questionType === 'MULTIPLE_CHOICE' ? null : (correctAnswer ? correctAnswer.trim() : null),
      pageReference: pageReference || null,
      points: points ? Number(points) : 1,
      groupTitle: groupTitle ? groupTitle.trim() : null,
    },
  });

  // Sub-options are fully replaced on every update, same pattern as
  // module task checklist/choice editing.
  await prisma.assessmentChoiceOptionTemplate.deleteMany({ where: { questionTemplateId: updated.id } });
  if (questionType === 'MULTIPLE_CHOICE') {
    for (let i = 0; i < choiceOptions.length; i++) {
      await prisma.assessmentChoiceOptionTemplate.create({
        data: {
          questionTemplateId: updated.id,
          order: i + 1,
          text: choiceOptions[i].text,
          isCorrect: !!choiceOptions[i].isCorrect,
        },
      });
    }
  }

  res.json(updated);
});

router.delete('/:questionId', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  await prisma.assessmentQuestionTemplate.delete({ where: { id: req.params.questionId } });
  res.status(204).send();
});

module.exports = router;
