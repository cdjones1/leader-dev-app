// ============================================================
// POST-FINAL STAGES
// Two real-world, hands-on checkpoints that happen after the final
// assessment passes, before the plan is considered complete:
//   1. Skill Demonstration Training - one developer-checked box
//   2. On-Shift Reps - developer scores a pass for each category
// Both gracefully no-op if a path never had them authored - the
// plan just completes immediately, exactly as it did before this
// feature existed.
// ============================================================
const express = require('express');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const { checkIsDeveloperOnPlan } = require('./access');

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
// categories, scoped per path.
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

  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const existingCount = await prisma.onShiftRepCategoryTemplate.count({ where: { pathId } });
  const category = await prisma.onShiftRepCategoryTemplate.create({
    data: { pathId, order: existingCount + 1, name: name.trim() },
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
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const existing = await prisma.onShiftRepCategoryTemplate.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Category not found' });
  }

  const updated = await prisma.onShiftRepCategoryTemplate.update({
    where: { id: req.params.id },
    data: { name: name.trim() },
  });

  res.json(updated);
});

router.delete('/templates/categories/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await prisma.onShiftRepCategoryTemplate.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

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
          data: { stageId: stage.id, order: ct.order, name: ct.name },
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
// TOGGLE one On-Shift Reps category's passed state - developer
// only. The moment every category in the stage is passed, the
// stage (and the whole plan) completes automatically.
// --------------------------------------------------------------
router.post('/on-shift-reps/categories/:id/toggle', requireAuth, async (req, res) => {
  const category = await prisma.onShiftRepCategory.findUnique({
    where: { id: req.params.id },
    include: { stage: true },
  });
  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }
  const stage = category.stage;
  if (!(await checkIsDeveloperOnPlan(req, res, stage.planId))) return;
  if (stage.status !== 'OPEN') {
    return res.status(400).json({ error: `Cannot change categories on a stage with status ${stage.status}` });
  }

  const updatedCategory = await prisma.onShiftRepCategory.update({
    where: { id: category.id },
    data: { passed: !category.passed, passedAt: !category.passed ? new Date() : null },
  });

  const allCategories = await prisma.onShiftRepCategory.findMany({ where: { stageId: stage.id } });
  const allPassed = allCategories.every((c) => c.passed);

  let stageCompleted = false;
  if (allPassed) {
    await prisma.onShiftRepsStage.update({
      where: { id: stage.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await prisma.developmentPlan.update({ where: { id: stage.planId }, data: { status: 'COMPLETE' } });
    stageCompleted = true;
  }

  res.json({ category: updatedCategory, stageCompleted });
});

module.exports = router;
module.exports.openSkillDemoOrSkip = openSkillDemoOrSkip;
module.exports.openOnShiftRepsOrComplete = openOnShiftRepsOrComplete;
