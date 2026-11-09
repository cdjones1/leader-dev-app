// ============================================================
// MODULE COPY + PART 2 HOLD HELPERS
// - loadModuleTemplate / fillModuleFromTemplate: the one place that
//   copies a path's module template (sections, tasks, checklist
//   items, choices, quiz questions) into a real plan module. Used
//   when a plan is created AND when Part 2 is released.
// - isPart2Held: a path can hold back the modules after the midterm
//   until the admin releases them.
// ============================================================
const prisma = require('./db');
const { midpointModule } = require('./gates');

function loadModuleTemplate(pathId, sequenceOrder) {
  return prisma.moduleTemplate.findUnique({
    where: { pathId_sequenceOrder: { pathId, sequenceOrder } },
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
}

async function fillModuleFromTemplate(moduleId, template) {
  for (const sectionTemplate of template.sectionTemplates) {
    const section = await prisma.moduleSection.create({
      data: { moduleId, order: sectionTemplate.order, title: sectionTemplate.title },
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
    }
  }
}

// True when this plan's path is holding Part 2 (the modules after the
// midterm). Plans with no path are never held.
async function isPart2Held(plan) {
  if (!plan || !plan.pathId) return false;
  const path = await prisma.developmentPath.findUnique({ where: { id: plan.pathId }, select: { holdPart2: true } });
  return !!(path && path.holdPart2);
}

module.exports = { loadModuleTemplate, fillModuleFromTemplate, isPart2Held, midpointModule };
