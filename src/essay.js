// ============================================================
// OPTIONAL ESSAY
// A path can carry one optional essay. It opens on each plan when
// Part 2 begins (the developee passes the midterm and the first
// Part 2 module opens), stays open through the rest of the course,
// and NEVER blocks a module, the Final, or finishing the plan.
// The prompt is copied onto the plan when it opens, so later edits
// to the path don't change an essay someone is already writing.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkPlanAccess, checkIsAssignedRole, checkIsDeveloperOnPlan } = require('./access');
const { midpointModule } = require('./gates');

const router = express.Router();

const MAX_ESSAY_CHARS = 30000;
const MAX_FEEDBACK_CHARS = 5000;
const MAX_PROMPT_CHARS = 5000;
const MAX_MIN_WORDS = 5000;

function countWords(text) {
  return (typeof text === 'string' ? text : '').trim().split(/\s+/).filter(Boolean).length;
}

function requireAdmin(req, res) {
  if (!req.user.isAdmin) { res.status(403).json({ error: 'Admin access required' }); return false; }
  return true;
}

// Opens the essay on a plan if its path has one. Safe to call any
// number of times - it never creates a second essay. Never throws:
// the essay is optional, so a problem here must not break the flow
// that called it.
async function openEssayIfConfigured(plan) {
  try {
    if (!plan || !plan.pathId) return null;
    const existing = await prisma.planEssay.findUnique({ where: { planId: plan.id } });
    if (existing) return existing;
    const template = await prisma.essayTemplate.findUnique({ where: { pathId: plan.pathId } });
    if (!template) return null;
    return await prisma.planEssay.create({
      data: { planId: plan.id, title: template.title, prompt: template.prompt, minWords: template.minWords },
    });
  } catch (err) {
    console.error('openEssayIfConfigured failed (essay is optional, continuing):', err);
    return null;
  }
}

// ---------------- ADMIN: the path's essay template ----------------
router.get('/template', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { pathId } = req.query;
  if (!pathId) return res.status(400).json({ error: 'pathId is required' });
  const template = await prisma.essayTemplate.findUnique({ where: { pathId } });
  res.json({ template: template || null });
});

router.put('/template', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { pathId } = req.query;
  if (!pathId) return res.status(400).json({ error: 'pathId is required' });
  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) return res.status(404).json({ error: 'Path not found' });

  const title = typeof req.body.title === 'string' ? req.body.title.trim().toUpperCase() : '';
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
  let minWords = req.body.minWords === '' || req.body.minWords == null ? 0 : Number(req.body.minWords);
  if (!title || title.length > 200) return res.status(400).json({ error: 'A title (up to 200 characters) is required' });
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ error: `The essay prompt is required (up to ${MAX_PROMPT_CHARS} characters)` });
  if (!Number.isInteger(minWords) || minWords < 0 || minWords > MAX_MIN_WORDS) {
    return res.status(400).json({ error: `Minimum words must be a whole number from 0 to ${MAX_MIN_WORDS}` });
  }

  const template = await prisma.essayTemplate.upsert({
    where: { pathId },
    update: { title, prompt, minWords },
    create: { pathId, title, prompt, minWords },
  });
  res.json({ template });
});

router.delete('/template', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { pathId } = req.query;
  if (!pathId) return res.status(400).json({ error: 'pathId is required' });
  await prisma.essayTemplate.deleteMany({ where: { pathId } });
  res.json({ template: null });
});

// ---------------- DEVELOPEE: draft + submit ----------------
async function loadEssay(req, res) {
  const plan = await prisma.developmentPlan.findUnique({ where: { id: req.params.planId } });
  if (!plan) { res.status(404).json({ error: 'Plan not found' }); return null; }
  if (!(await checkPlanAccess(req, res, plan.id))) return null;
  const essay = await prisma.planEssay.findUnique({ where: { planId: plan.id } });
  if (!essay) { res.status(404).json({ error: 'This plan has no essay' }); return null; }
  return { plan, essay };
}

router.put('/plan/:planId/draft', requireAuth, async (req, res) => {
  const found = await loadEssay(req, res); if (!found) return;
  const { plan, essay } = found;
  if (!(await checkIsAssignedRole(req, res, plan.id, 'DEVELOPEE'))) return;
  if (essay.submittedAt) return res.status(400).json({ error: 'This essay was already submitted and is locked' });
  const text = req.body.text;
  if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  if (text.length > MAX_ESSAY_CHARS) return res.status(400).json({ error: `Essays can be up to ${MAX_ESSAY_CHARS} characters` });
  await prisma.planEssay.update({ where: { id: essay.id }, data: { draft: text } });
  res.json({ saved: true, words: countWords(text) });
});

router.post('/plan/:planId/submit', requireAuth, async (req, res) => {
  const found = await loadEssay(req, res); if (!found) return;
  const { plan, essay } = found;
  if (!(await checkIsAssignedRole(req, res, plan.id, 'DEVELOPEE'))) return;
  if (essay.submittedAt) return res.status(400).json({ error: 'This essay was already submitted' });
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Write your essay before submitting' });
  if (text.length > MAX_ESSAY_CHARS) return res.status(400).json({ error: `Essays can be up to ${MAX_ESSAY_CHARS} characters` });
  const words = countWords(text);
  if (words < essay.minWords) {
    return res.status(400).json({ error: `This essay needs at least ${essay.minWords} words. You have ${words}.` });
  }
  // Claim the submit atomically so a double-click can't submit twice.
  const claimed = await prisma.planEssay.updateMany({
    where: { id: essay.id, submittedAt: null },
    data: { submittedText: text, draft: text, submittedAt: new Date() },
  });
  if (claimed.count === 0) return res.status(400).json({ error: 'This essay was already submitted' });
  res.json({ submitted: true, words });
});

// ---------------- DEVELOPER / ADMIN: feedback ----------------
router.post('/plan/:planId/feedback', requireAuth, async (req, res) => {
  const found = await loadEssay(req, res); if (!found) return;
  const { plan, essay } = found;
  if (!(await checkIsDeveloperOnPlan(req, res, plan.id))) return;
  if (!essay.submittedAt) return res.status(400).json({ error: 'The essay has not been submitted yet' });
  const feedback = typeof req.body.feedback === 'string' ? req.body.feedback.trim() : '';
  if (!feedback) return res.status(400).json({ error: 'Write a comment first' });
  if (feedback.length > MAX_FEEDBACK_CHARS) return res.status(400).json({ error: `Comments can be up to ${MAX_FEEDBACK_CHARS} characters` });
  const me = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { name: true } });
  const updated = await prisma.planEssay.update({
    where: { id: essay.id },
    data: { feedback, feedbackAt: new Date(), feedbackByName: me ? me.name : null },
  });
  res.json({ essay: updated });
});

// ---------------- DEVELOPER / ADMIN: add to a plan already in Part 2 ----------------
router.post('/plan/:planId/add', requireAuth, async (req, res) => {
  const plan = await prisma.developmentPlan.findUnique({ where: { id: req.params.planId } });
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!(await checkPlanAccess(req, res, plan.id))) return;
  if (!(await checkIsDeveloperOnPlan(req, res, plan.id))) return;
  if (plan.status !== 'IN_PROGRESS') return res.status(400).json({ error: 'This plan is already complete' });
  const firstPart2 = await prisma.module.findFirst({
    where: { planId: plan.id, sequenceOrder: midpointModule(plan.moduleCount) + 1 },
  });
  if (!firstPart2 || firstPart2.status === 'NOT_STARTED') {
    return res.status(400).json({ error: 'The essay opens automatically when Part 2 begins' });
  }
  const essay = await openEssayIfConfigured(plan);
  if (!essay) return res.status(404).json({ error: 'This path does not have an essay set up' });
  res.json({ essay });
});

module.exports = router;
module.exports.openEssayIfConfigured = openEssayIfConfigured;
module.exports.countWords = countWords;
