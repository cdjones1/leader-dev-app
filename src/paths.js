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
// ANALYZE CONTENT - admin only. Instead of sending a whole path in
// one request (which can exceed the output budget for a large
// path), this splits the content into small chunks - one per
// module, one per review gate, one per assessment - and analyzes
// each with its OWN small, reliable request, run in parallel, then
// merges all the issues together. Requires ANTHROPIC_API_KEY to be
// set as an environment variable on the server.
// --------------------------------------------------------------

// Every piece of editable text sent to Claude is tagged inline with
// a [id:<kind>:<id>:<field>] marker. Claude is instructed to echo
// the exact marker for whichever field an issue is in, so a fix can
// later be applied with a precise, targeted database update instead
// of fuzzy text matching against the original content.
function fid(kind, id, field) {
  return `[id:${kind}:${id}:${field}]`;
}

function describeTask(lines, t) {
  lines.push(`    TASK (${t.taskType}) ${fid('task', t.id, 'text')}: ${t.text}`);
  if (t.content) lines.push(`      Content ${fid('task', t.id, 'content')}: ${t.content}`);
  if (t.correctAnswer) lines.push(`      Model answer ${fid('task', t.id, 'correctAnswer')}: ${t.correctAnswer}`);
  for (const opt of t.choiceOptionTemplates || []) {
    lines.push(`      Option${opt.isCorrect ? ' (correct)' : ''} ${fid('choiceOption', opt.id, 'text')}: ${opt.text}`);
  }
  for (const item of t.checklistItemTemplates || []) {
    lines.push(`      Item ${fid('checklistItem', item.id, 'text')}: ${item.text}${item.description ? ` | Description ${fid('checklistItem', item.id, 'description')}: ${item.description}` : ''}`);
  }
  for (const q of t.quizQuestionTemplates || []) {
    lines.push(`      Quiz question ${fid('quizQuestion', q.id, 'text')}: ${q.text}${q.content ? ` | Content ${fid('quizQuestion', q.id, 'content')}: ${q.content}` : ''}`);
    for (const opt of q.choiceOptionTemplates || []) {
      lines.push(`        Option${opt.isCorrect ? ' (correct)' : ''} ${fid('quizChoiceOption', opt.id, 'text')}: ${opt.text}`);
    }
  }
}

// Splits a path's content into small, independently-analyzable
// chunks. Each chunk gets its own label (used to prefix issue
// locations in the merged results) and only non-empty chunks are
// included.
function buildAnalysisChunks(content) {
  const chunks = [];

  for (const m of content.modules) {
    if (m.sectionTemplates.length === 0) continue;
    const lines = [`MODULE ${m.sequenceOrder} ${fid('module', m.id, 'title')}: ${m.title}`];
    if (m.description) lines.push(`Description ${fid('module', m.id, 'description')}: ${m.description}`);
    for (const s of m.sectionTemplates) {
      lines.push(`SECTION ${fid('section', s.id, 'title')}: ${s.title}`);
      for (const t of s.taskTemplates) describeTask(lines, t);
    }
    chunks.push({ label: `Module ${m.sequenceOrder}: ${m.title}`, text: lines.join('\n') });
  }

  for (const gate of content.reviewGates) {
    if (gate.sectionTemplates.length === 0) continue;
    const label = gate.gatePosition === 'AFTER_MODULE_4' ? 'Midterm Review' : 'Final Review';
    const lines = [`${label} ${fid('reviewGate', gate.id, 'title')}: ${gate.title || ''}`];
    if (gate.description) lines.push(`Description ${fid('reviewGate', gate.id, 'description')}: ${gate.description}`);
    for (const s of gate.sectionTemplates) {
      lines.push(`SECTION ${fid('section', s.id, 'title')}: ${s.title}`);
      for (const t of s.taskTemplates) describeTask(lines, t);
    }
    chunks.push({ label, text: lines.join('\n') });
  }

  const midtermQuestions = content.assessmentQuestions.filter((q) => q.gatePosition === 'AFTER_MODULE_4');
  const finalQuestions = content.assessmentQuestions.filter((q) => q.gatePosition === 'AFTER_MODULE_8');
  for (const [label, questions] of [['Midterm Assessment', midtermQuestions], ['Final Assessment', finalQuestions]]) {
    if (questions.length === 0) continue;
    const lines = [];
    for (const q of questions) {
      lines.push(`QUESTION (${q.questionType}, ${q.points} pts${q.groupTitle ? ', group: ' + q.groupTitle : ''}) ${fid('assessmentQuestion', q.id, 'text')}: ${q.text}`);
      if (q.content) lines.push(`  Content ${fid('assessmentQuestion', q.id, 'content')}: ${q.content}`);
      if (q.correctAnswer) lines.push(`  Model answer ${fid('assessmentQuestion', q.id, 'correctAnswer')}: ${q.correctAnswer}`);
      for (const opt of q.choiceOptionTemplates || []) {
        lines.push(`  Option${opt.isCorrect ? ' (correct)' : ''} ${fid('assessmentChoiceOption', opt.id, 'text')}: ${opt.text}`);
      }
    }
    chunks.push({ label, text: lines.join('\n') });
  }

  return chunks;
}

const ANALYSIS_SYSTEM_PROMPT = `You are a careful editor reviewing one section of internal leadership-training curriculum content for a restaurant company. Every piece of text is tagged inline with a marker like [id:task:abc123:text] right before it. Review the content for:
- Spelling errors
- Grammar errors
- Flow / clarity issues (awkward phrasing, confusing wording)
- Factual or logical inconsistencies (e.g. a question's "correct" answer doesn't actually match its own options or content, contradictory statements, broken references)

Respond with ONLY valid JSON, no other text, in this exact shape:
{
  "issues": [
    { "fieldId": "the EXACT [id:...] marker (without brackets) for the specific field the issue is in, e.g. task:abc123:text", "location": "e.g. Section 'Reading' > Task 'Our Mission'", "type": "spelling|grammar|flow|accuracy", "excerpt": "the exact problematic text, kept short", "issue": "what's wrong", "suggestion": "the FULL corrected replacement text for that whole field - not just the fixed word/phrase, the entire field's text with the fix applied, since this may be applied directly as a replacement" }
  ]
}
Every issue MUST include the fieldId of the marker closest to the problem - never omit it, never invent one. If there are no issues, return an empty issues array.`;

// Analyzes ONE chunk of text with its own small, independent
// request. Never throws - on any failure it returns an empty issue
// list plus an error note, so one bad chunk doesn't take down the
// whole analysis.
async function analyzeChunk(chunk) {
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
        max_tokens: 8192,
        // effort must be nested inside output_config, not a bare
        // top-level field - straightforward classification/extraction
        // doesn't need the "high" default's internal reasoning, so
        // this keeps the token budget available for visible output.
        output_config: { effort: 'medium' },
        system: ANALYSIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: chunk.text }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`Anthropic API error analyzing "${chunk.label}":`, response.status, errBody);
      let detail = errBody;
      try { detail = JSON.parse(errBody).error.message; } catch (e) { /* keep raw body if it's not the expected shape */ }
      return { label: chunk.label, issues: [], error: `(${response.status}) ${detail}` };
    }

    const data = await response.json();
    const rawText = data.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

    if (data.stop_reason === 'max_tokens') {
      console.error(`Analysis of "${chunk.label}" was truncated. Raw text so far:`, rawText);
      return { label: chunk.label, issues: [], error: 'This section was too long to analyze in one pass' };
    }

    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      console.error(`No JSON object found analyzing "${chunk.label}":`, rawText);
      return { label: chunk.label, issues: [], error: 'Could not parse the response for this section' };
    }
    const parsed = JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
    return { label: chunk.label, issues: parsed.issues || [], error: null };
  } catch (err) {
    console.error(`Content analysis failed for "${chunk.label}":`, err);
    return { label: chunk.label, issues: [], error: 'Could not reach the content analysis service' };
  }
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

  const chunks = buildAnalysisChunks(content);
  if (chunks.length === 0) {
    return res.status(400).json({ error: 'This path has no content authored yet to analyze' });
  }

  const results = await Promise.all(chunks.map((chunk) => analyzeChunk(chunk)));

  const issues = [];
  const chunkErrors = [];
  for (const result of results) {
    for (const issue of result.issues) {
      issues.push({ ...issue, location: `${result.label} > ${issue.location || ''}` });
    }
    if (result.error) chunkErrors.push(`${result.label}: ${result.error}`);
  }

  const summary = `Analyzed ${chunks.length} section(s) of content and found ${issues.length} issue(s).`;

  res.json({ summary, issues, chunkErrors });
});

// Maps a fieldId's "kind" segment to the Prisma model and which
// fields on it are allowed to be rewritten this way - a safety
// whitelist so an unexpected fieldId can never touch an arbitrary
// column.
const FIELD_KIND_MAP = {
  module: { model: 'moduleTemplate', fields: ['title', 'description'] },
  section: { model: 'moduleSectionTemplate', fields: ['title'] },
  task: { model: 'moduleTaskTemplate', fields: ['text', 'content', 'correctAnswer'] },
  checklistItem: { model: 'checklistItemTemplate', fields: ['text', 'description'] },
  choiceOption: { model: 'choiceOptionTemplate', fields: ['text'] },
  quizQuestion: { model: 'sectionQuizQuestionTemplate', fields: ['text', 'content'] },
  quizChoiceOption: { model: 'sectionQuizChoiceOptionTemplate', fields: ['text'] },
  reviewGate: { model: 'reviewGateTemplate', fields: ['title', 'description'] },
  assessmentQuestion: { model: 'assessmentQuestionTemplate', fields: ['text', 'content', 'correctAnswer'] },
  assessmentChoiceOption: { model: 'assessmentChoiceOptionTemplate', fields: ['text'] },
};

// --------------------------------------------------------------
// APPLY FIX - admin only. Rewrites exactly one field, identified by
// the fieldId a content-analysis issue was tagged with, to the
// given replacement text. Used by both "Accept" (applies the
// suggestion verbatim) and "Edit & Apply" (applies the admin's own
// edited version) on the content-analysis results.
// --------------------------------------------------------------
router.post('/:id/apply-fix', requireAuth, async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { fieldId, newText } = req.body;
  if (!fieldId || typeof newText !== 'string') {
    return res.status(400).json({ error: 'fieldId and newText are required' });
  }
  if (!newText.trim()) {
    return res.status(400).json({ error: 'The replacement text cannot be blank' });
  }

  const parts = fieldId.split(':');
  if (parts.length !== 3) {
    return res.status(400).json({ error: `Malformed fieldId: ${fieldId}` });
  }
  const [kind, recordId, field] = parts;

  const mapping = FIELD_KIND_MAP[kind];
  if (!mapping || !mapping.fields.includes(field)) {
    return res.status(400).json({ error: `Unsupported or unrecognized field: ${fieldId}` });
  }

  try {
    await prisma[mapping.model].update({
      where: { id: recordId },
      data: { [field]: newText },
    });
    res.json({ applied: true });
  } catch (err) {
    console.error('Failed to apply fix:', fieldId, err);
    res.status(404).json({ error: 'Could not find that field to update - the content may have been deleted or changed since the analysis ran' });
  }
});

module.exports = router;
