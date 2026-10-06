// ============================================================
// MODULE COMPLETION
// Everything that happens when a module is completed: it's marked
// complete, then either the next module opens (starting its 5-day
// clock) or - at the midpoint and final modules - the Study and
// Review step opens with its content copied in. Shared by the manual
// "Mark Complete" route AND by finishing a module's last section, so
// both always do exactly the same thing.
// ============================================================
const prisma = require('./db');
const { midpointModule, gateAfterModule } = require('./gates');

const FIVE_DAYS_IN_MS = 5 * 24 * 60 * 60 * 1000;

// Returns { completedModule, reviewStepOpened } or
// { completedModule, nextModuleOpened }, or null if the module was no
// longer OPEN by the time this ran (someone else just completed it).
async function completeModuleRecord(module, actorId) {
  const moduleId = module.id;

  const now = new Date();

  // Claim the completion atomically: only one caller can flip OPEN -> COMPLETED,
  // so a double click (or two people finishing the last sections at the same
  // instant) can never open the next module or the review step twice.
  const claimed = await prisma.module.updateMany({
    where: { id: moduleId, status: 'OPEN' },
    data: { status: 'COMPLETED', completedAt: now },
  });
  if (claimed.count === 0) return null;
  const updated = await prisma.module.findUnique({ where: { id: moduleId } });

  await prisma.moduleEvent.create({
    data: { moduleId, eventType: 'COMPLETED', actorId },
  });

  // The midpoint and final modules lead into a "Study and Review"
  // step before the assessment - not straight to the assessment
  // itself. Uses this plan's OWN moduleCount, so this correctly finds
  // the right gate regardless of how many modules the plan has.
  const plan = await prisma.developmentPlan.findUnique({ where: { id: module.planId } });
  const gatePosition = gateAfterModule(module.sequenceOrder, plan.moduleCount);
  if (gatePosition) {
    const reviewStep = await prisma.reviewStep.create({
      data: { planId: module.planId, gatePosition, status: 'OPEN', openedAt: new Date() },
    });

    // Copy this path's review-gate content (if any) into real
    // sections/tasks for this specific review step - same nested
    // copy pattern plans.js uses for a regular module's sections,
    // just attaching via reviewStepId instead of moduleId. Older
    // plans, or a path with nothing authored yet, just get an empty
    // review step, same as before this feature existed.
    if (plan.pathId) {
      const gate = await prisma.reviewGateTemplate.findUnique({
        where: { pathId_gatePosition: { pathId: plan.pathId, gatePosition } },
        include: {
          sectionTemplates: {
            orderBy: { order: 'asc' },
            include: {
              taskTemplates: {
                orderBy: { order: 'asc' },
                include: {
                  checklistItemTemplates: { orderBy: { order: 'asc' } },
                  choiceOptionTemplates: { orderBy: { order: 'asc' } },
                  quizQuestionTemplates: {
                    orderBy: { order: 'asc' },
                    include: { choiceOptionTemplates: { orderBy: { order: 'asc' } } },
                  },
                },
              },
            },
          },
        },
      });

      if (gate) {
        const flashcardTaskIds = [];
        for (const sectionTemplate of gate.sectionTemplates) {
          const section = await prisma.moduleSection.create({
            data: { reviewStepId: reviewStep.id, order: sectionTemplate.order, title: sectionTemplate.title },
          });

          for (const taskTemplate of sectionTemplate.taskTemplates) {
            const moduleTask = await prisma.moduleTask.create({
              data: {
                sectionId: section.id,
                order: taskTemplate.order,
                text: taskTemplate.text,
                content: taskTemplate.content,
                taskType: taskTemplate.taskType,
                assignedTo: taskTemplate.assignedTo,
                correctAnswer: taskTemplate.correctAnswer,
                link: taskTemplate.link,
                pageReference: taskTemplate.pageReference,
                tableLeftHeader: taskTemplate.tableLeftHeader,
                tableRightHeader: taskTemplate.tableRightHeader,
                tableHeaderColor: taskTemplate.tableHeaderColor,
                tableRowColorA: taskTemplate.tableRowColorA,
                tableRowColorB: taskTemplate.tableRowColorB,
              },
            });

            for (const item of taskTemplate.checklistItemTemplates) {
              await prisma.taskChecklistItem.create({
                data: {
                  moduleTaskId: moduleTask.id,
                  order: item.order,
                  text: item.text,
                  description: item.description,
                  link: item.link,
                  quoteText: item.quoteText,
                },
              });
            }

            for (const option of taskTemplate.choiceOptionTemplates) {
              await prisma.taskChoiceOption.create({
                data: { moduleTaskId: moduleTask.id, order: option.order, text: option.text, isCorrect: option.isCorrect },
              });
            }

            for (const qt of taskTemplate.quizQuestionTemplates) {
              const quizQuestion = await prisma.sectionQuizQuestion.create({
                data: { moduleTaskId: moduleTask.id, order: qt.order, text: qt.text, content: qt.content },
              });
              for (const opt of qt.choiceOptionTemplates) {
                await prisma.sectionQuizChoiceOption.create({
                  data: { questionId: quizQuestion.id, order: opt.order, text: opt.text, isCorrect: opt.isCorrect },
                });
              }
            }

            if (taskTemplate.taskType === 'FLASHCARD') {
              flashcardTaskIds.push(moduleTask.id);
            }
          }
        }

        // Every Flashcard Set task in a review gate automatically pulls
        // in all the flashcards from earlier modules - appended after
        // whatever the admin manually authored, each one tagged with
        // which module it actually came from. Snapshotted once, right
        // now, so it never shifts under someone mid-review even if the
        // source modules' content changes later.
        if (flashcardTaskIds.length > 0) {
          const midpoint = midpointModule(plan.moduleCount);
          // Midterm pulls from modules 1 through the midpoint. Final
          // pulls from the SECOND half only (midpoint+1 through the
          // end) - the material not already covered by the midterm,
          // not a comprehensive re-pull of everything.
          const minSequenceOrder = gatePosition === 'AFTER_MODULE_4' ? 1 : midpoint + 1;
          const maxSequenceOrder = gatePosition === 'AFTER_MODULE_4' ? midpoint : plan.moduleCount;

          const priorModules = await prisma.module.findMany({
            where: { planId: plan.id, sequenceOrder: { gte: minSequenceOrder, lte: maxSequenceOrder } },
            orderBy: { sequenceOrder: 'asc' },
            include: {
              sections: {
                orderBy: { order: 'asc' },
                include: {
                  tasks: {
                    where: { taskType: 'FLASHCARD' },
                    orderBy: { order: 'asc' },
                    include: { checklistItems: { orderBy: { order: 'asc' } } },
                  },
                },
              },
            },
          });

          const aggregatedCards = [];
          for (const priorModule of priorModules) {
            const sourceLabel = `Module ${priorModule.sequenceOrder}${priorModule.title ? ' — ' + priorModule.title : ''}`;
            for (const priorSection of priorModule.sections) {
              for (const priorTask of priorSection.tasks) {
                for (const card of priorTask.checklistItems) {
                  aggregatedCards.push({ text: card.text, description: card.description, sourceLabel });
                }
              }
            }
          }

          if (aggregatedCards.length > 0) {
            for (const flashcardTaskId of flashcardTaskIds) {
              const existingCount = await prisma.taskChecklistItem.count({ where: { moduleTaskId: flashcardTaskId } });
              for (let i = 0; i < aggregatedCards.length; i++) {
                const card = aggregatedCards[i];
                await prisma.taskChecklistItem.create({
                  data: {
                    moduleTaskId: flashcardTaskId,
                    order: existingCount + i + 1,
                    text: card.text,
                    description: card.description,
                    sourceLabel: card.sourceLabel,
                  },
                });
              }
            }
          }
        }
      }
    }

    return { completedModule: updated, reviewStepOpened: reviewStep };
  }

  // Find and open the next module in this plan, if there is one
  const nextModule = await prisma.module.findFirst({
    where: { planId: module.planId, sequenceOrder: module.sequenceOrder + 1 },
  });

  if (nextModule) {
    const nextDueAt = new Date(now.getTime() + FIVE_DAYS_IN_MS);
    await prisma.module.update({
      where: { id: nextModule.id },
      data: { status: 'OPEN', openedAt: now, dueAt: nextDueAt },
    });
    await prisma.moduleEvent.create({
      data: { moduleId: nextModule.id, eventType: 'OPENED', actorId: null }, // null = triggered by the system, not a person
    });
  }

  return { completedModule: updated, nextModuleOpened: !!nextModule };
}

module.exports = { completeModuleRecord };
