// ============================================================
// SECTION QUIZ ROUTES
// A graded set of multiple-choice questions at the end of a
// section - needs 90% correct to pass. Fully auto-graded (no
// developer review needed, unlike assessment short-answer
// questions), so submitting the whole quiz and "grading" it happen
// in one atomic action.
//
// Same 3-strike escalation as the midterm/final assessments:
//   attempt 1 fails -> IN_PROGRESS (retry allowed)
//   attempt 2 fails -> LOCKED_NEEDS_MEETING (developer must meet, then reopen)
//   attempt 3 fails -> LOCKED_FINAL (needs admin, not the developer)
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess, checkIsDeveloperOnPlan, checkIsAssignedRole } = require('./access');

const router = express.Router();

const PASS_THRESHOLD = 0.9; // 90%

async function getTaskWithPlanId(taskId) {
  const task = await prisma.moduleTask.findUnique({
    where: { id: taskId },
    include: { section: { include: { module: true } } },
  });
  if (!task) return null;
  return { task, planId: task.section.module.planId };
}

// View the quiz's questions, for the CURRENT attempt. Once this
// attempt has been submitted, correctness reveals immediately
// (auto-graded, no reason to hold it back).
router.get('/tasks/:taskId/quiz', requireAuth, async (req, res) => {
  const found = await getTaskWithPlanId(req.params.taskId);
  if (!found) return res.status(404).json({ error: 'Task not found' });
  const { task, planId } = found;
  if (!(await checkPlanAccess(req, res, planId))) return;
  if (task.taskType !== 'SECTION_QUIZ') {
    return res.status(400).json({ error: 'This task is not a SECTION_QUIZ' });
  }

  const attemptNumber = task.quizAttemptCount + 1;
  const questions = await prisma.sectionQuizQuestion.findMany({
    where: { moduleTaskId: task.id },
    orderBy: { order: 'asc' },
    include: {
      responses: { where: { attemptNumber } },
      choiceOptions: { orderBy: { order: 'asc' } },
    },
  });

  const shaped = questions.map((q) => {
    const response = q.responses[0] || null;
    const revealed = !!response;
    return {
      id: q.id,
      order: q.order,
      text: q.text,
      content: q.content,
      choiceOptions: q.choiceOptions.map((o) => (revealed ? o : { id: o.id, order: o.order, text: o.text })),
      selectedOptionId: response ? response.selectedOptionId : undefined,
      isCorrect: response ? response.isCorrect : undefined,
    };
  });

  res.json({
    attemptNumber,
    quizStatus: task.quizStatus,
    quizAttemptCount: task.quizAttemptCount,
    questions: shaped,
  });
});

// Submit the WHOLE quiz at once, for the CURRENT attempt. Only the
// developee takes it. Computes the score immediately and decides
// what happens next using the same 3-strike rule the assessments use.
router.post('/tasks/:taskId/submit-quiz', requireAuth, async (req, res) => {
  const found = await getTaskWithPlanId(req.params.taskId);
  if (!found) return res.status(404).json({ error: 'Task not found' });
  const { task, planId } = found;
  if (!(await checkPlanAccess(req, res, planId))) return;
  if (!(await checkIsAssignedRole(req, res, planId, 'DEVELOPEE'))) return;
  if (task.taskType !== 'SECTION_QUIZ') {
    return res.status(400).json({ error: 'This task is not a SECTION_QUIZ' });
  }
  if (!['PENDING', 'IN_PROGRESS'].includes(task.quizStatus)) {
    return res.status(400).json({ error: `Cannot submit while the quiz status is ${task.quizStatus}` });
  }

  const attemptNumber = task.quizAttemptCount + 1;
  const alreadySubmitted = await prisma.sectionQuizResponse.findFirst({
    where: { attemptNumber, question: { moduleTaskId: task.id } },
  });
  if (alreadySubmitted) {
    return res.status(400).json({ error: 'This quiz was already submitted for this attempt - it cannot be changed' });
  }

  const questions = await prisma.sectionQuizQuestion.findMany({
    where: { moduleTaskId: task.id },
    include: { choiceOptions: true },
  });

  const { responses } = req.body;
  if (!Array.isArray(responses)) {
    return res.status(400).json({ error: 'responses must be an array' });
  }
  const responseByQuestionId = {};
  for (const r of responses) responseByQuestionId[r.questionId] = r;

  const missing = questions.filter((q) => !responseByQuestionId[q.id] || !responseByQuestionId[q.id].optionId);
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Every question needs an answer before the quiz can be submitted',
      missing: missing.map((q) => q.text),
    });
  }

  // Lock every answer in and compute correctness as we go.
  let correctCount = 0;
  const results = [];
  for (const q of questions) {
    const r = responseByQuestionId[q.id];
    const chosenOption = q.choiceOptions.find((o) => o.id === r.optionId);
    if (!chosenOption) {
      return res.status(400).json({ error: `optionId for "${q.text}" does not match one of its choices` });
    }
    if (chosenOption.isCorrect) correctCount++;
    await prisma.sectionQuizResponse.create({
      data: { questionId: q.id, attemptNumber, selectedOptionId: r.optionId, isCorrect: chosenOption.isCorrect },
    });
    results.push({ questionId: q.id, isCorrect: chosenOption.isCorrect });
  }

  const scorePercent = questions.length > 0 ? (correctCount / questions.length) * 100 : 100;
  const passed = scorePercent / 100 >= PASS_THRESHOLD;

  // --------------------------------------------------------------
  // Same escalation rule the midterm/final assessments use.
  // --------------------------------------------------------------
  let newStatus;
  if (passed) {
    newStatus = 'PASSED';
  } else if (attemptNumber === 1) {
    newStatus = 'IN_PROGRESS'; // attempt 2 allowed
  } else if (attemptNumber === 2) {
    newStatus = 'LOCKED_NEEDS_MEETING'; // developer must meet with developee, then reopen
  } else {
    newStatus = 'LOCKED_FINAL'; // 3rd attempt failed - needs admin, not developer
  }

  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: { quizStatus: newStatus, quizAttemptCount: attemptNumber },
  });

  res.json({
    scorePercent: Math.round(scorePercent),
    correctCount,
    totalQuestions: questions.length,
    passed,
    quizStatus: updated.quizStatus,
    results,
  });
});

// DEVELOPER REOPEN — only valid from LOCKED_NEEDS_MEETING, after the
// required follow-up meeting has happened. Allows attempt 3.
router.post('/tasks/:taskId/reopen-after-meeting', requireAuth, async (req, res) => {
  const found = await getTaskWithPlanId(req.params.taskId);
  if (!found) return res.status(404).json({ error: 'Task not found' });
  const { task, planId } = found;
  if (!(await checkIsDeveloperOnPlan(req, res, planId))) return;
  if (task.quizStatus !== 'LOCKED_NEEDS_MEETING') {
    return res.status(400).json({ error: `Can only reopen from LOCKED_NEEDS_MEETING, current status is ${task.quizStatus}` });
  }

  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: { quizStatus: 'IN_PROGRESS' },
  });

  res.json(updated);
});

// ADMIN REOPEN FOR RETRY — grants exactly one more attempt from
// LOCKED_FINAL, without automatically passing it.
router.post('/tasks/:taskId/admin-reopen-for-retry', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can reopen a LOCKED_FINAL quiz' });
  }
  const found = await getTaskWithPlanId(req.params.taskId);
  if (!found) return res.status(404).json({ error: 'Task not found' });
  const { task } = found;
  if (task.quizStatus !== 'LOCKED_FINAL') {
    return res.status(400).json({ error: `Can only reopen from LOCKED_FINAL, current status is ${task.quizStatus}` });
  }

  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: { quizStatus: 'IN_PROGRESS' }, // quizAttemptCount is NOT reset - the next submission continues the real count
  });

  res.json(updated);
});

// ADMIN RESOLUTION — only valid from LOCKED_FINAL. Overrides to PASSED.
router.post('/tasks/:taskId/admin-override-pass', requireAuth, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Only an admin can resolve a LOCKED_FINAL quiz' });
  }
  const found = await getTaskWithPlanId(req.params.taskId);
  if (!found) return res.status(404).json({ error: 'Task not found' });
  const { task } = found;
  if (task.quizStatus !== 'LOCKED_FINAL') {
    return res.status(400).json({ error: `Can only override from LOCKED_FINAL, current status is ${task.quizStatus}` });
  }

  const updated = await prisma.moduleTask.update({
    where: { id: task.id },
    data: { quizStatus: 'PASSED' },
  });

  res.json(updated);
});

module.exports = router;
