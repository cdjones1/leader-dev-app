// ============================================================
// ONE-TIME MIGRATION: uppercase every existing Module, Section,
// and Task title across the whole database - both the admin
// TEMPLATES (what you author) and the real per-plan COPIES already
// created for in-progress plans.
//
// This does NOT touch: review gate titles, assessment question
// titles, path names, or any task's own content/body text - only
// the title fields explicitly requested (Module title, Section
// title, Task title).
//
// Run once, deliberately, from the Render Shell tab:
//   node scripts/uppercase-titles.js
//
// This is NOT reversible - the original mixed-case text is
// overwritten. Going forward, new titles saved through the app
// will already come in as uppercase automatically (that part of
// the code was updated separately), so this script should only
// ever need to run once.
// ============================================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Uppercasing titles... (this only touches title fields, nothing else)');

  const results = {};

  // Templates (what admins author)
  results.moduleTemplateTitles = await prisma.$executeRawUnsafe(
    `UPDATE "ModuleTemplate" SET title = UPPER(title)`
  );
  results.sectionTemplateTitles = await prisma.$executeRawUnsafe(
    `UPDATE "ModuleSectionTemplate" SET title = UPPER(title)`
  );
  results.taskTemplateTitles = await prisma.$executeRawUnsafe(
    `UPDATE "ModuleTaskTemplate" SET text = UPPER(text)`
  );

  // Real instances (already-created plans' own copies)
  results.moduleTitles = await prisma.$executeRawUnsafe(
    `UPDATE "Module" SET title = UPPER(title) WHERE title IS NOT NULL`
  );
  results.sectionTitles = await prisma.$executeRawUnsafe(
    `UPDATE "ModuleSection" SET title = UPPER(title)`
  );
  results.taskTitles = await prisma.$executeRawUnsafe(
    `UPDATE "ModuleTask" SET text = UPPER(text)`
  );

  console.log('Done. Rows updated:');
  console.log(results);
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
