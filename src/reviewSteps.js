// ============================================================
// REVIEW STEP ROUTES
// "Study and Review" - sits between a 4-module block and its
// assessment. Opens automatically when module 4 or 8 completes.
// Completing it is what actually creates the assessment - so the
// assessment doesn't even exist yet until review is done.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess } = require('./access');

const router = express.Router();

// View a review step's tasks (flashcards + action items).
router.get('/:id/tasks', requireAuth, async (req, res) => {
  const reviewStep = await prisma.reviewStep.findUnique({ where: { id: req.params.id } });
  if (!reviewStep) {
    return res.status(404).json({ error: 'Review step not found' });
  }
  if (!(await checkPlanAccess(req, res, reviewStep.planId))) return;

  const tasks = await prisma.reviewStepTask.findMany({
    where: { reviewStepId: reviewStep.id },
    orderBy: { order: 'asc' },
    include: { checklistItems: { orderBy: { order: 'asc' } } },
  });

  res.json(tasks);
});

// Toggle an ACTION_ITEM's checked state. Open to any plan
// participant (or admin) - review steps aren't split by
// developer/developee the way sections are.
router.post('/tasks/:taskId/toggle', requireAuth, async (req, res) => {
  const task = await prisma.reviewStepTask.findUnique({
    where: { id: req.params.taskId },
    include: { reviewStep: true },
  });
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  if (!(await checkPlanAccess(req, res, task.reviewStep.planId))) return;
  if (task.taskType !== 'ACTION_ITEM') {
    return res.status(400).json({ error: 'Only action-item tasks can be toggled directly' });
  }

  const updated = await prisma.reviewStepTask.update({
    where: { id: task.id },
    data: { completed: !task.completed, completedAt: !task.completed ? new Date() : null },
  });

  res.json(updated);
});

router.post('/:id/complete', requireAuth, async (req, res) => {
  const reviewStep = await prisma.reviewStep.findUnique({ where: { id: req.params.id } });
  if (!reviewStep) {
    return res.status(404).json({ error: 'Review step not found' });
  }
  if (!(await checkPlanAccess(req, res, reviewStep.planId))) return;
  if (reviewStep.status !== 'OPEN') {
    return res.status(400).json({ error: `Cannot complete a review step with status ${reviewStep.status}` });
  }

  // Every self-check (ACTION_ITEM) item needs to be checked off
  // before review can be marked complete - same rule sections
  // already use. Flashcards never block anything, they're purely a
  // study aid.
  const actionItems = await prisma.reviewStepTask.findMany({
    where: { reviewStepId: reviewStep.id, taskType: 'ACTION_ITEM' },
  });
  const unchecked = actionItems.filter((t) => !t.completed);
  if (unchecked.length > 0) {
    return res.status(400).json({
      error: 'Not every self-check item is checked off yet',
      missing: unchecked.map((t) => t.text),
    });
  }

  const updated = await prisma.reviewStep.update({
    where: { id: reviewStep.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  // Completing review is what creates the actual assessment - it
  // didn't exist until now. Its questions are copied from whichever
  // path this plan was built from, for this specific gate - if the
  // plan has no path (older plans) or the path has no questions
  // authored yet, the assessment just starts with none.
  const assessment = await prisma.assessment.create({
    data: { planId: reviewStep.planId, gatePosition: reviewStep.gatePosition, status: 'PENDING' },
  });

  const plan = await prisma.developmentPlan.findUnique({ where: { id: reviewStep.planId } });
  if (plan.pathId) {
    const questionTemplates = await prisma.assessmentQuestionTemplate.findMany({
      where: { pathId: plan.pathId, gatePosition: reviewStep.gatePosition },
      orderBy: { order: 'asc' },
    });
    for (const qt of questionTemplates) {
      const question = await prisma.assessmentQuestion.create({
        data: {
          assessmentId: assessment.id,
          order: qt.order,
          text: qt.text,
          content: qt.content,
          questionType: qt.questionType,
          correctAnswer: qt.correctAnswer,
          pageReference: qt.pageReference,
        },
      });
      if (qt.questionType === 'MULTIPLE_CHOICE') {
        const optionTemplates = await prisma.assessmentChoiceOptionTemplate.findMany({
          where: { questionTemplateId: qt.id },
          orderBy: { order: 'asc' },
        });
        for (const opt of optionTemplates) {
          await prisma.assessmentChoiceOption.create({
            data: { questionId: question.id, order: opt.order, text: opt.text, isCorrect: opt.isCorrect },
          });
        }
      }
    }
  }

  res.json({ reviewStep: updated, assessmentCreated: assessment });
});

module.exports = router;
