// ============================================================
// POST-FINAL STAGES
// Two real-world, hands-on checkpoints that happen after the final
// assessment passes, before the plan is considered complete:
//   1. Skill Demonstration Training - one developer-checked box
//   2. On-Shift Reps - each item needs a set number of reps. The
//      developee logs each rep (date + what they learned), then a
//      leader signs it off with a drawn signature + printed name
//      (no login needed). Only signed-off reps count.
// Both gracefully no-op if a path never had them authored - the
// plan just completes immediately, exactly as it did before this
// feature existed.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkIsDeveloperOnPlan, checkIsAssignedRole, checkPlanAccess, getParticipantRole } = require('./access');
const { parseRequiredReps, isValidRepDate, validateSignerName, isValidSignatureImage, isCategoryPassed, isStageDone, MAX_REQUIRED_REPS } = require('./repRules');

const router = express.Router();

function requireAdmin(req, res) {
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

// --------------------------------------------------------------
// ADMIN AUTHORING - Skill Demo title/description and On-Shift Rep
// categories (each with how many reps it needs), scoped per path.
// --------------------------------------------------------------

router.get('/templates', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { pathId } = req.query;
  if (!pathId) {
    return res.status(400).json({ error: 'pathId query parameter is required' });
  }

  const skillDemo = await prisma.skillDemoTemplate.findUnique({ where: { pathId } });
  const categories = await prisma.onShiftRepCategoryTemplate.findMany({
    where: { pathId },
    orderBy: { order: 'asc' },
  });

  res.json({ skillDemo, categories });
});

router.put('/templates/skill-demo', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { pathId } = req.query;
  if (!pathId) {
    return res.status(400).json({ error: 'pathId query parameter is required' });
  }

  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const { title, description } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const template = await prisma.skillDemoTemplate.upsert({
    where: { pathId },
    update: { title: title.trim(), description: description || '' },
    create: { pathId, title: title.trim(), description: description || '' },
  });

  res.json(template);
});

router.post('/templates/categories', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { pathId } = req.query;
  if (!pathId) {
    return res.status(400).json({ error: 'pathId query parameter is required' });
  }

  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const { name, requiredReps } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const reps = parseRequiredReps(requiredReps);
  if (reps === null) {
    return res.status(400).json({ error: `Reps needed must be a whole number from 1 to ${MAX_REQUIRED_REPS}` });
  }

  const existingCount = await prisma.onShiftRepCategoryTemplate.count({ where: { pathId } });
  const category = await prisma.onShiftRepCategoryTemplate.create({
    data: { pathId, order: existingCount + 1, name: name.trim(), requiredReps: reps },
  });

  res.status(201).json(category);
});

// IMPORTANT: registered BEFORE '/templates/categories/:id' below -
// otherwise Express would match "reorder" as if it were a category
// ID and this route would never be reached.
router.put('/templates/categories/reorder', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { categoryIds } = req.body;
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
    return res.status(400).json({ error: 'categoryIds must be a non-empty array' });
  }

  for (let i = 0; i < categoryIds.length; i++) {
    await prisma.onShiftRepCategoryTemplate.update({
      where: { id: categoryIds[i] },
      data: { order: i + 1 },
    });
  }

  res.json({ reordered: categoryIds.length });
});

router.put('/templates/categories/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, requiredReps } = req.body;

  const data = {};
  if (name !== undefined) {
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name cannot be blank' });
    }
    data.name = name.trim();
  }
  if (requiredReps !== undefined) {
    const reps = parseRequiredReps(requiredReps);
    if (reps === null) {
      return res.status(400).json({ error: `Reps needed must be a whole number from 1 to ${MAX_REQUIRED_REPS}` });
    }
    data.requiredReps = reps;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Send a name and/or requiredReps to update' });
  }

  const existing = await prisma.onShiftRepCategoryTemplate.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Category not found' });
  }

  const updated = await prisma.onShiftRepCategoryTemplate.update({
    where: { id: req.params.id },
    data,
  });

  res.json(updated);
});

router.delete('/templates/categories/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await prisma.onShiftRepCategoryTemplate.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// --------------------------------------------------------------
// Sequencing: what opens after the final assessment passes
// --------------------------------------------------------------

// Called right after the final assessment passes. Tries Skill Demo
// first; if the path never authored one, falls through to On-Shift
// Reps; if that's empty too, the plan just completes - same as
// before this feature existed.
async function openSkillDemoOrSkip(plan) {
  if (plan.pathId) {
    const template = await prisma.skillDemoTemplate.findUnique({ where: { pathId: plan.pathId } });
    if (template) {
      const skillDemo = await prisma.skillDemo.create({
        data: { planId: plan.id, title: template.title, description: template.description },
      });
      return { action: 'skill_demo_opened', skillDemoId: skillDemo.id };
    }
  }
  return openOnShiftRepsOrComplete(plan);
}

// Called once Skill Demo completes (or is skipped). Same
// graceful-skip logic for On-Shift Reps.
async function openOnShiftRepsOrComplete(plan) {
  if (plan.pathId) {
    const categoryTemplates = await prisma.onShiftRepCategoryTemplate.findMany({
      where: { pathId: plan.pathId },
      orderBy: { order: 'asc' },
    });
    if (categoryTemplates.length > 0) {
      const stage = await prisma.onShiftRepsStage.create({ data: { planId: plan.id } });
      for (const ct of categoryTemplates) {
        await prisma.onShiftRepCategory.create({
          data: { stageId: stage.id, order: ct.order, name: ct.name, requiredReps: ct.requiredReps },
        });
      }
      return { action: 'on_shift_reps_opened', stageId: stage.id };
    }
  }
  await prisma.developmentPlan.update({ where: { id: plan.id }, data: { status: 'COMPLETE' } });
  return { action: 'plan_marked_complete' };
}

// --------------------------------------------------------------
// MARK Skill Demo complete - developer only. Advances to
// On-Shift Reps (or completes the plan) immediately after.
// --------------------------------------------------------------
router.post('/skill-demo/:id/complete', requireAuth, async (req, res) => {
  const skillDemo = await prisma.skillDemo.findUnique({ where: { id: req.params.id } });
  if (!skillDemo) {
    return res.status(404).json({ error: 'Skill demo not found' });
  }
  if (!(await checkIsDeveloperOnPlan(req, res, skillDemo.planId))) return;
  if (skillDemo.status !== 'OPEN') {
    return res.status(400).json({ error: `Cannot complete a skill demo with status ${skillDemo.status}` });
  }

  const updated = await prisma.skillDemo.update({
    where: { id: skillDemo.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });

  const plan = await prisma.developmentPlan.findUnique({ where: { id: skillDemo.planId } });
  const nextStepResult = await openOnShiftRepsOrComplete(plan);

  res.json({ skillDemo: updated, nextStep: nextStepResult });
});

// --------------------------------------------------------------
// ON-SHIFT REPS
// --------------------------------------------------------------

// Re-derives a category's cached "passed" flag from its reps.
async function syncCategoryPassed(categoryId) {
  const category = await prisma.onShiftRepCategory.findUnique({
    where: { id: categoryId },
    include: { reps: true },
  });
  const passed = isCategoryPassed(category);
  if (passed !== category.passed) {
    await prisma.onShiftRepCategory.update({
      where: { id: categoryId },
      data: { passed, passedAt: passed ? new Date() : null },
    });
  }
}

// Completes the stage - and the whole plan - once every item has
// passed. Returns true if it just completed.
async function completeStageIfDone(stageId) {
  const stage = await prisma.onShiftRepsStage.findUnique({
    where: { id: stageId },
    include: { categories: true },
  });
  if (stage.status !== 'OPEN' || !isStageDone(stage.categories)) return false;

  await prisma.onShiftRepsStage.update({
    where: { id: stageId },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  await prisma.developmentPlan.update({ where: { id: stage.planId }, data: { status: 'COMPLETE' } });
  return true;
}

// The DEVELOPEE logs a rep: the date they completed it and what they
// learned. It doesn't count toward the item until someone signs it off.
router.post('/on-shift-reps/categories/:id/reps', requireAuth, async (req, res) => {
  const category = await prisma.onShiftRepCategory.findUnique({
    where: { id: req.params.id },
    include: { stage: true, reps: true },
  });
  if (!category) {
    return res.status(404).json({ error: 'Item not found' });
  }
  if (!(await checkIsAssignedRole(req, res, category.stage.planId, 'DEVELOPEE'))) return;
  if (category.stage.status !== 'OPEN') {
    return res.status(400).json({ error: 'On-Shift Reps is already complete' });
  }

  const { completedOn, learned } = req.body;
  if (!isValidRepDate(completedOn)) {
    return res.status(400).json({ error: 'Pick a valid date for when you completed this rep (today or earlier)' });
  }
  if (typeof learned !== 'string' || !learned.trim()) {
    return res.status(400).json({ error: 'Write what you learned from this rep' });
  }
  if (learned.length > 3000) {
    return res.status(400).json({ error: 'Keep "what you learned" under 3000 characters' });
  }
  if (category.reps.length >= category.requiredReps) {
    return res.status(400).json({ error: `All ${category.requiredReps} rep(s) for this item are already logged - delete an unsigned one first if you need to redo it` });
  }

  const rep = await prisma.onShiftRep.create({
    data: { categoryId: category.id, completedOn, learned: learned.trim() },
  });

  res.status(201).json(rep);
});

// Delete a rep. The developee can delete one that hasn't been signed
// off yet (to fix a mistake). Since a signature isn't tied to a login,
// the plan's developer (or an admin) can remove ANY rep - including a
// signed one they don't trust.
router.delete('/on-shift-reps/reps/:id', requireAuth, async (req, res) => {
  const rep = await prisma.onShiftRep.findUnique({
    where: { id: req.params.id },
    include: { category: { include: { stage: true } } },
  });
  if (!rep) {
    return res.status(404).json({ error: 'Rep not found' });
  }
  const stage = rep.category.stage;
  if (stage.status !== 'OPEN') {
    return res.status(400).json({ error: 'On-Shift Reps is already complete' });
  }

  if (!req.user.isAdmin) {
    const role = await getParticipantRole(req.user.userId, stage.planId);
    if (role === 'DEVELOPEE') {
      if (rep.signedOffAt) {
        return res.status(400).json({ error: 'A signed-off rep can only be removed by the developer or an admin' });
      }
    } else if (role !== 'DEVELOPER') {
      return res.status(403).json({ error: 'Only people on this plan (or an admin) can delete a rep' });
    }
  }

  await prisma.onShiftRep.delete({ where: { id: rep.id } });
  await syncCategoryPassed(rep.categoryId);

  res.json({ deleted: true });
});

// A leader signs off a logged rep with a drawn signature plus their
// printed name. The leader doesn't need an account - the developee
// hands over their device - so anyone on the plan (or an admin) can
// submit it. Like a paper sign-off sheet, it records what was written.
router.post('/on-shift-reps/reps/:id/sign-off', requireAuth, async (req, res) => {
  const rep = await prisma.onShiftRep.findUnique({
    where: { id: req.params.id },
    include: { category: { include: { stage: true } } },
  });
  if (!rep) {
    return res.status(404).json({ error: 'Rep not found' });
  }
  const stage = rep.category.stage;
  if (!(await checkPlanAccess(req, res, stage.planId))) return;
  if (stage.status !== 'OPEN') {
    return res.status(400).json({ error: 'On-Shift Reps is already complete' });
  }
  if (rep.signedOffAt) {
    return res.status(400).json({ error: 'This rep has already been signed off' });
  }

  const { signerName, signature } = req.body || {};
  const plan = await prisma.developmentPlan.findUnique({
    where: { id: stage.planId },
    include: { pairing: { include: { developee: true } } },
  });
  const nameCheck = validateSignerName(signerName, plan.pairing.developee.name);
  if (!nameCheck.ok) {
    return res.status(400).json({ error: nameCheck.reason });
  }
  if (!isValidSignatureImage(signature)) {
    return res.status(400).json({ error: 'The leader needs to sign in the box before signing off' });
  }

  await prisma.onShiftRep.update({
    where: { id: rep.id },
    data: { signedOffAt: new Date(), signedOffByName: nameCheck.name, signatureImage: signature },
  });
  await syncCategoryPassed(rep.categoryId);
  const stageCompleted = await completeStageIfDone(stage.id);

  res.json({ signedOff: true, stageCompleted });
});

module.exports = router;
module.exports.openSkillDemoOrSkip = openSkillDemoOrSkip;
module.exports.openOnShiftRepsOrComplete = openOnShiftRepsOrComplete;
