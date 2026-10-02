// ============================================================
// DEVELOPMENT PATH ROUTES
// A path is a distinct named curriculum (e.g. "Front of House
// Senior Team Member") with its own separate set of 8 modules.
// Admin-only to manage; needed by anyone starting a plan.
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

// List all paths - any logged-in user can see the list (needed
// when starting a plan), but only admins can create/edit/delete.
router.get('/', requireAuth, async (req, res) => {
  const paths = await prisma.developmentPath.findMany({
    orderBy: { createdAt: 'asc' },
  });
  res.json(paths);
});

router.post('/', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name, description, moduleCount, goalDays, maxDays } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const count = moduleCount ? parseInt(moduleCount, 10) : 8;
  if (!Number.isInteger(count) || count < 1) {
    return res.status(400).json({ error: 'moduleCount must be a positive whole number' });
  }

  const goal = goalDays ? parseInt(goalDays, 10) : 30;
  const max = maxDays ? parseInt(maxDays, 10) : 40;
  if (!Number.isInteger(goal) || goal < 1) {
    return res.status(400).json({ error: 'goalDays must be a positive whole number' });
  }
  if (!Number.isInteger(max) || max < 1) {
    return res.status(400).json({ error: 'maxDays must be a positive whole number' });
  }
  if (max < goal) {
    return res.status(400).json({ error: 'maxDays must be greater than or equal to goalDays' });
  }

  const existing = await prisma.developmentPath.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return res.status(409).json({ error: 'A path with that name already exists' });
  }

  const path = await prisma.developmentPath.create({
    data: { name: name.trim(), description: description || '', moduleCount: count, goalDays: goal, maxDays: max },
  });

  res.status(201).json(path);
});

router.put('/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const existing = await prisma.developmentPath.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const updated = await prisma.developmentPath.update({
    where: { id: req.params.id },
    data: { name: name.trim(), description: description || '' },
  });

  res.json(updated);
});

// Deleting a path cascades to its own module templates (and their
// sections/tasks), but NEVER touches plans already created from it -
// those keep their own copied content and the pathName snapshot,
// regardless of what happens to the path definition afterward.
router.delete('/:id', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const existing = await prisma.developmentPath.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    return res.status(404).json({ error: 'Path not found' });
  }

  await prisma.developmentPath.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// --------------------------------------------------------------
// FULL READ-ONLY PREVIEW of everything authored for a path - every
// module's sections/tasks, both review gates, and both assessments'
// questions, all in one payload. Gated by canPreviewPaths (or
// admin) - checked fresh from the database on every request, NOT
// from the JWT, so a revoked permission takes effect immediately
// rather than waiting for the token to expire.
// --------------------------------------------------------------
// Fetches the full content tree for a path - every module's
// sections/tasks, both review gates, and both assessments'
// questions. Shared by the preview route and the content-analysis
// route below, so there's only one place that defines this shape.
async function fetchFullPathContent(pathId) {
  const path = await prisma.developmentPath.findUnique({ where: { id: pathId } });
  if (!path) return null;

  const taskInclude = {
    orderBy: { order: 'asc' },
    include: {
      checklistItemTemplates: { orderBy: { order: 'asc' } },
      choiceOptionTemplates: { orderBy: { order: 'asc' } },
      quizQuestionTemplates: {
        orderBy: { order: 'asc' },
        include: { choiceOptionTemplates: { orderBy: { order: 'asc' } } },
      },
    },
  };

  const modules = await prisma.moduleTemplate.findMany({
    where: { pathId: path.id },
    orderBy: { sequenceOrder: 'asc' },
    include: {
      sectionTemplates: {
        orderBy: { order: 'asc' },
        include: { taskTemplates: taskInclude },
      },
    },
  });

  const reviewGates = await prisma.reviewGateTemplate.findMany({
    where: { pathId: path.id },
    include: {
      sectionTemplates: {
        orderBy: { order: 'asc' },
        include: { taskTemplates: taskInclude },
      },
    },
  });

  const assessmentQuestions = await prisma.assessmentQuestionTemplate.findMany({
    where: { pathId: path.id },
    orderBy: { order: 'asc' },
    include: { choiceOptionTemplates: { orderBy: { order: 'asc' } } },
  });

  return { path, modules, reviewGates, assessmentQuestions };
}

router.get('/:id/preview', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  if (!user.isAdmin && !user.canPreviewPaths) {
    return res.status(403).json({ error: 'You do not have permission to preview paths - ask an admin to grant it' });
  }

  const content = await fetchFullPathContent(req.params.id);
  if (!content) {
    return res.status(404).json({ error: 'Path not found' });
  }

  res.json(content);
});

// --------------------------------------------------------------
// ANALYZE CONTENT - admin only. Sends the whole path's authored
// text to Claude and asks it to flag spelling, grammar, flow, and
// factual/logical-consistency issues. Requires ANTHROPIC_API_KEY
// to be set as an environment variable on the server.
// --------------------------------------------------------------
function flattenContentToText(content) {
  const lines = [];
  lines.push(`PATH: ${content.path.name}`);
  if (content.path.description) lines.push(`Path description: ${content.path.description}`);

  const describeTask = (t) => {
    lines.push(`    TASK (${t.taskType}): ${t.text}`);
    if (t.content) lines.push(`      Content: ${t.content}`);
    if (t.correctAnswer) lines.push(`      Model answer: ${t.correctAnswer}`);
    for (const opt of t.choiceOptionTemplates || []) {
      lines.push(`      Option${opt.isCorrect ? ' (correct)' : ''}: ${opt.text}`);
    }
    for (const item of t.checklistItemTemplates || []) {
      lines.push(`      Item: ${item.text}${item.description ? ' — ' + item.description : ''}`);
    }
    for (const q of t.quizQuestionTemplates || []) {
      lines.push(`      Quiz question: ${q.text}${q.content ? ' — ' + q.content : ''}`);
      for (const opt of q.choiceOptionTemplates || []) {
        lines.push(`        Option${opt.isCorrect ? ' (correct)' : ''}: ${opt.text}`);
      }
    }
  };

  for (const m of content.modules) {
    lines.push(`MODULE ${m.sequenceOrder}: ${m.title}`);
    if (m.description) lines.push(`  Description: ${m.description}`);
    for (const s of m.sectionTemplates) {
      lines.push(`  SECTION: ${s.title}`);
      for (const t of s.taskTemplates) describeTask(t);
    }
  }

  for (const gate of content.reviewGates) {
    const label = gate.gatePosition === 'AFTER_MODULE_4' ? 'MIDTERM REVIEW' : 'FINAL REVIEW';
    lines.push(`${label}: ${gate.title || ''}`);
    if (gate.description) lines.push(`  Description: ${gate.description}`);
    for (const s of gate.sectionTemplates) {
      lines.push(`  SECTION: ${s.title}`);
      for (const t of s.taskTemplates) describeTask(t);
    }
  }

  const midtermQuestions = content.assessmentQuestions.filter((q) => q.gatePosition === 'AFTER_MODULE_4');
  const finalQuestions = content.assessmentQuestions.filter((q) => q.gatePosition === 'AFTER_MODULE_8');
  for (const [label, questions] of [['MIDTERM ASSESSMENT', midtermQuestions], ['FINAL ASSESSMENT', finalQuestions]]) {
    if (questions.length === 0) continue;
    lines.push(label + ':');
    for (const q of questions) {
      lines.push(`  QUESTION (${q.questionType}, ${q.points} pts${q.groupTitle ? ', group: ' + q.groupTitle : ''}): ${q.text}`);
      if (q.content) lines.push(`    Content: ${q.content}`);
      if (q.correctAnswer) lines.push(`    Model answer: ${q.correctAnswer}`);
      for (const opt of q.choiceOptionTemplates || []) {
        lines.push(`    Option${opt.isCorrect ? ' (correct)' : ''}: ${opt.text}`);
      }
    }
  }

  return lines.join('\n');
}

router.post('/:id/analyze-content', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server - add it as an environment variable and redeploy' });
  }

  const content = await fetchFullPathContent(req.params.id);
  if (!content) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const contentText = flattenContentToText(content);
  if (!contentText.trim() || content.modules.every((m) => m.sectionTemplates.length === 0)) {
    return res.status(400).json({ error: 'This path has no content authored yet to analyze' });
  }

  const systemPrompt = `You are a careful editor reviewing internal leadership-training curriculum content for a restaurant company. You will be given the full text of one training path (modules, sections, tasks, review content, and assessment questions). Review it for:
- Spelling errors
- Grammar errors
- Flow / clarity issues (awkward phrasing, confusing wording)
- Factual or logical inconsistencies (e.g. a question's "correct" answer doesn't actually match its own options or content, contradictory statements, broken references)

Respond with ONLY valid JSON, no other text, in this exact shape:
{
  "summary": "one or two sentence overall assessment",
  "issues": [
    { "location": "e.g. Module 3 > Section 'Reading' > Task 'Our Mission'", "type": "spelling|grammar|flow|accuracy", "excerpt": "the exact problematic text, kept short", "issue": "what's wrong", "suggestion": "a specific fix" }
  ]
}
If there are no issues of a given type, simply don't include any of that type. If the content is completely clean, return an empty issues array.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: contentText }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'The content analysis service returned an error - check server logs for details' });
    }

    const data = await response.json();
    const rawText = data.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

    let parsed;
    try {
      const cleaned = rawText.replace(/^```json\s*|```\s*$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse analysis response:', rawText);
      return res.status(502).json({ error: 'Could not parse the analysis response - try again' });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Content analysis failed:', err);
    res.status(502).json({ error: 'Could not reach the content analysis service' });
  }
});

module.exports = router;
