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

router.post('/:id/complete', requireAuth, async (req, res) => {
  const reviewStep = await prisma.reviewStep.findUnique({ where: { id: req.params.id } });
  if (!reviewStep) {
    return res.status(404).json({ error: 'Review step not found' });
  }
  if (!(await checkPlanAccess(req, res, reviewStep.planId))) return;
  if (reviewStep.status !== 'OPEN') {
    return res.status(400).json({ error: `Cannot complete a review step with status ${reviewStep.status}` });
  }

  // Every section attached to this review step needs to actually be
  // finished first - a section can only reach "completed" once every
  // task inside it satisfies its own requirement (Action Items
  // checked, Section Quizzes passed, etc.), so this transitively
  // guarantees every task is done too. Flashcards and Readings never
  // block anything - they're purely study aids.
  const sections = await prisma.moduleSection.findMany({ where: { reviewStepId: reviewStep.id } });
  const unfinishedSections = sections.filter((s) => !s.completed);
  if (unfinishedSections.length > 0) {
    return res.status(400).json({
      error: 'Not every section in this review is complete yet',
      missing: unfinishedSections.map((s) => s.title),
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
          points: qt.points,
          groupTitle: qt.groupTitle,
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
