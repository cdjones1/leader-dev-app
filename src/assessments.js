// ============================================================
// ASSESSMENT ROUTES
// Handles grading the midterm (after module 4) and final (after
// module 8) assessments, including the 3-attempt rule:
//   attempt 1 fails -> attempt 2 allowed automatically
//   attempt 2 fails -> LOCKED_NEEDS_MEETING (developer must meet, then reopen)
//   attempt 3 fails -> LOCKED_FINAL (needs admin, not the developer)
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess, checkIsDeveloperOnPlan, checkIsAssignedRole, getParticipantRole } = require('./access');

const router = express.Router();

// --------------------------------------------------------------
// VIEW an assessment's questions, for the CURRENT attempt.
//
// SHORT_ANSWER: the developee's own submitted answer echoes back
// once submitted (so they can review what they wrote), but the
// model answer is only ever shown to the developer/admin - never
// the developee, regardless of grading status.
//
// MULTIPLE_CHOICE: the developee's own pick echoes back once
// submitted too, but whether it was CORRECT stays hidden from
// EVERYONE - including the developer - until this attempt has
// actually been graded. The whole test is held back together and
// only reveals once the developer finalizes the overall grade.
// --------------------------------------------------------------
router.get('/:id/questions', requireAuth, async (req, res) => {
  let assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkPlanAccess(req, res, assessment.planId))) return;

  const role = req.user.isAdmin ? 'ADMIN' : await getParticipantRole(req.user.userId, assessment.planId);
  const canSeeShortAnswerModel = role === 'ADMIN' || role === 'DEVELOPER';

  // The developee viewing this (while it's actually gradeable, i.e.
  // an attempt is really underway) is what "opens" it - modules lock
  // from this moment until the whole test is submitted.
  if (role === 'DEVELOPEE' && !assessment.openedAt && ['PENDING', 'IN_PROGRESS'].includes(assessment.status)) {
    assessment = await prisma.assessment.update({ where: { id: assessment.id }, data: { openedAt: new Date() } });
  }

  const attemptNumber = assessment.attemptCount + 1;

  // "Graded" means an attempt row already exists for this attempt
  // number - attempts are only ever created at grading time, so this
  // is exactly the signal that the developer has finished grading it.
  const gradedAttempt = await prisma.assessmentAttempt.findFirst({
    where: { assessmentId: assessment.id, attemptNumber },
  });
  const isGraded = !!gradedAttempt;

  const questions = await prisma.assessmentQuestion.findMany({
    where: { assessmentId: assessment.id },
    orderBy: { order: 'asc' },
    include: {
      responses: { where: { attemptNumber } },
      choiceOptions: { orderBy: { order: 'asc' } },
    },
  });

  const shaped = questions.map((q) => {
    const response = q.responses[0] || null;
    const base = {
      id: q.id,
      order: q.order,
      text: q.text,
      content: q.content,
      pageReference: q.pageReference,
      questionType: q.questionType,
    };

    if (q.questionType === 'MULTIPLE_CHOICE') {
      if (response) {
        base.selectedOptionId = response.selectedOptionId;
      }
      // Correctness never shows until the whole test is graded -
      // options themselves are safe to show either way (no isCorrect
      // leaked), just without isCorrect until graded.
      base.choiceOptions = q.choiceOptions.map((o) => (isGraded ? o : { id: o.id, order: o.order, text: o.text }));
      if (isGraded && response) {
        base.isCorrect = response.isCorrect;
      }
      return base;
    }

    // SHORT_ANSWER
    if (response) {
      base.submittedAnswer = response.submittedAnswer;
      base.submittedAt = response.submittedAt;
    }
    if (canSeeShortAnswerModel) {
      base.correctAnswer = q.correctAnswer;
    }
    return base;
  });

  res.json({ attemptNumber, isGraded, questions: shaped });
});

// --------------------------------------------------------------
// SUBMIT THE WHOLE TEST at once, for the CURRENT attempt. Only the
// developee does this. Every question needs an answer in the same
// submission - there's no partial/incremental submission anymore.
// Locks in permanently for this attempt; a later retry (a new
// attempt number) gets a fresh, separate set of answers.
//
// Body: { responses: [{ questionId, answer }, { questionId, optionId }, ...] }
// --------------------------------------------------------------
router.post('/:id/submit-test', requireAuth, async (req, res) => {
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkPlanAccess(req, res, assessment.planId))) return;
  if (!(await checkIsAssignedRole(req, res, assessment.planId, 'DEVELOPEE'))) return;
  if (!['PENDING', 'IN_PROGRESS'].includes(assessment.status)) {
    return res.status(400).json({ error: `Cannot submit while the assessment status is ${assessment.status}` });
  }

  const attemptNumber = assessment.attemptCount + 1;
  const alreadySubmitted = await prisma.assessmentQuestionResponse.findFirst({
    where: { attemptNumber, question: { assessmentId: assessment.id } },
  });
  if (alreadySubmitted) {
    return res.status(400).json({ error: 'This test was already submitted for this attempt - it cannot be changed' });
  }

  const questions = await prisma.assessmentQuestion.findMany({
    where: { assessmentId: assessment.id },
    include: { choiceOptions: true },
  });

  const { responses } = req.body;
  if (!Array.isArray(responses)) {
    return res.status(400).json({ error: 'responses must be an array' });
  }
  const responseByQuestionId = {};
  for (const r of responses) responseByQuestionId[r.questionId] = r;

  const missing = questions.filter((q) => {
    const r = responseByQuestionId[q.id];
    if (!r) return true;
    if (q.questionType === 'MULTIPLE_CHOICE') return !r.optionId;
    return !r.answer || !r.answer.trim();
  });
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Every question needs an answer before the test can be submitted',
      missing: missing.map((q) => q.text),
    });
  }

  // Everything checks out - lock all of it in together.
  for (const q of questions) {
    const r = responseByQuestionId[q.id];
    if (q.questionType === 'MULTIPLE_CHOICE') {
      const chosenOption = q.choiceOptions.find((o) => o.id === r.optionId);
      if (!chosenOption) {
        return res.status(400).json({ error: `optionId for "${q.text}" does not match one of its choices` });
      }
      await prisma.assessmentQuestionResponse.create({
        data: { questionId: q.id, attemptNumber, selectedOptionId: r.optionId, isCorrect: chosenOption.isCorrect },
      });
    } else {
      await prisma.assessmentQuestionResponse.create({
        data: { questionId: q.id, attemptNumber, submittedAnswer: r.answer },
      });
    }
  }

  // Submitting the whole test is what unlocks modules again - the
  // window that started when they opened it is now closed,
  // regardless of when the developer actually gets around to
  // grading it.
  await prisma.assessment.update({ where: { id: assessment.id }, data: { openedAt: null } });

  res.json({ submitted: questions.length });
});

// --------------------------------------------------------------
// GRADE an assessment attempt.
// Body: { overallResult: "PASS" or "FAIL", itemScores: [{ moduleId, score, comments }, ...] }
// --------------------------------------------------------------
router.post('/:id/grade', requireAuth, async (req, res) => {
  const assessmentId = req.params.id;
  const { overallResult, itemScores } = req.body;

  if (!['PASS', 'FAIL'].includes(overallResult)) {
    return res.status(400).json({ error: 'overallResult must be PASS or FAIL' });
  }
  if (!Array.isArray(itemScores) || itemScores.length === 0) {
    return res.status(400).json({ error: 'itemScores must be a non-empty array' });
  }

  const assessment = await prisma.assessment.findUnique({ where: { id: assessmentId } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkIsDeveloperOnPlan(req, res, assessment.planId))) return;
  if (!['PENDING', 'IN_PROGRESS'].includes(assessment.status)) {
    return res.status(400).json({
      error: `Cannot grade an assessment with status ${assessment.status}`,
    });
  }

  const attemptNumber = assessment.attemptCount + 1;

  // Every question authored for this assessment needs an answer
  // locked in for THIS attempt before it can be graded - otherwise
  // the developer would be grading blind on whatever's missing.
  const questions = await prisma.assessmentQuestion.findMany({
    where: { assessmentId },
    include: { responses: { where: { attemptNumber } } },
  });
  const unanswered = questions.filter((q) => q.responses.length === 0);
  if (unanswered.length > 0) {
    return res.status(400).json({
      error: 'Not every question has an answer yet for this attempt',
      missing: unanswered.map((q) => q.text),
    });
  }

  const attempt = await prisma.assessmentAttempt.create({
    data: {
      assessmentId,
      attemptNumber,
      overallResult,
      gradedBy: req.user.userId,
      itemScores: {
        create: itemScores.map((s) => ({
          moduleId: s.moduleId,
          score: s.score,
          comments: s.comments || null,
        })),
      },
    },
    include: { itemScores: true },
  });

  // --------------------------------------------------------------
  // This is the core decision: what happens to the ASSESSMENT
  // based on this attempt's result and which attempt number it was.
  // --------------------------------------------------------------
  let newStatus;
  if (overallResult === 'PASS') {
    newStatus = 'PASSED';
  } else if (attemptNumber === 1) {
    newStatus = 'IN_PROGRESS'; // attempt 2 allowed
  } else if (attemptNumber === 2) {
    newStatus = 'LOCKED_NEEDS_MEETING'; // developer must meet with developee, then reopen
  } else {
    newStatus = 'LOCKED_FINAL'; // 3rd attempt failed - needs admin, not developer
  }

  const updatedAssessment = await prisma.assessment.update({
    where: { id: assessmentId },
    data: { status: newStatus, attemptCount: attemptNumber },
  });

  // If this passed, unlock what comes next: module 5 (for the midterm)
  // or mark the whole plan complete (for the final).
  let nextStepResult = null;
  if (newStatus === 'PASSED') {
    nextStepResult = await unlockNextStep(assessment);
  }

  res.json({ attempt, assessment: updatedAssessment, nextStep: nextStepResult });
});

// --------------------------------------------------------------
// Helper: when an assessment passes, open the next module (midterm)
// or mark the plan complete (final).
// --------------------------------------------------------------
async function unlockNextStep(assessment) {
  if (assessment.gatePosition === 'AFTER_MODULE_4') {
    const FIVE_DAYS_IN_MS = 5 * 24 * 60 * 60 * 1000;
    const now = new Date();
    const module5 = await prisma.module.findFirst({
      where: { planId: assessment.planId, sequenceOrder: 5 },
    });
    if (module5) {
      await prisma.module.update({
        where: { id: module5.id },
        data: { status: 'OPEN', openedAt: now, dueAt: new Date(now.getTime() + FIVE_DAYS_IN_MS) },
      });
      await prisma.moduleEvent.create({
        data: { moduleId: module5.id, eventType: 'OPENED', actorId: null },
      });
      return { action: 'opened_module_5', moduleId: module5.id };
    }
  } else if (assessment.gatePosition === 'AFTER_MODULE_8') {
    await prisma.developmentPlan.update({
      where: { id: assessment.planId },
      data: { status: 'COMPLETE' },
    });
    return { action: 'plan_marked_complete' };
  }
  return null;
}

// --------------------------------------------------------------
// DEVELOPER REOPEN — only valid from LOCKED_NEEDS_MEETING, after
// the required follow-up meeting has happened. Allows attempt 3.
// --------------------------------------------------------------
router.post('/:id/reopen-after-meeting', requireAuth, async (req, res) => {
  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkIsDeveloperOnPlan(req, res, assessment.planId))) return;
  if (assessment.status !== 'LOCKED_NEEDS_MEETING') {
    return res.status(400).json({
      error: `Can only reopen from LOCKED_NEEDS_MEETING, current status is ${assessment.status}`,
    });
  }

  const updated = await prisma.assessment.update({
    where: { id: assessment.id },
    data: { status: 'IN_PROGRESS' },
  });

  res.json(updated);
});

// --------------------------------------------------------------
// ADMIN REOPEN FOR RETRY — grants exactly one more attempt from
// LOCKED_FINAL, without automatically passing it. If that attempt
// also fails, the existing 3-attempt logic naturally sends it right
// back to LOCKED_FINAL - admin decides again from there.
// --------------------------------------------------------------
router.post('/:id/admin-reopen-for-retry', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can reopen a LOCKED_FINAL assessment' });
  }

  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (assessment.status !== 'LOCKED_FINAL') {
    return res.status(400).json({
      error: `Can only reopen from LOCKED_FINAL, current status is ${assessment.status}`,
    });
  }

  const updated = await prisma.assessment.update({
    where: { id: assessment.id },
    data: { status: 'IN_PROGRESS' }, // attemptCount is NOT reset - the next grade continues the real count
  });

  res.json(updated);
});

// --------------------------------------------------------------
// ADMIN RESOLUTION — only valid from LOCKED_FINAL. For now this
// gives admin one option: override to PASS and unlock the next step.
// (We flagged this as an open decision earlier - easy to add more
// options here later, e.g. ending the pairing instead.)
// --------------------------------------------------------------
router.post('/:id/admin-override-pass', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can resolve a LOCKED_FINAL assessment' });
  }

  const assessment = await prisma.assessment.findUnique({ where: { id: req.params.id } });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (assessment.status !== 'LOCKED_FINAL') {
    return res.status(400).json({
      error: `Can only override from LOCKED_FINAL, current status is ${assessment.status}`,
    });
  }

  const updated = await prisma.assessment.update({
    where: { id: assessment.id },
    data: { status: 'PASSED' },
  });

  const nextStepResult = await unlockNextStep(updated);

  res.json({ assessment: updated, nextStep: nextStepResult });
});

// --------------------------------------------------------------
// VIEW an assessment's full history
// --------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res) => {
  const assessment = await prisma.assessment.findUnique({
    where: { id: req.params.id },
    include: { attempts: { include: { itemScores: true }, orderBy: { attemptNumber: 'asc' } } },
  });
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }
  if (!(await checkPlanAccess(req, res, assessment.planId))) return;
  res.json(assessment);
});

module.exports = router;
