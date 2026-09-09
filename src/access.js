// ============================================================
// ACCESS CONTROL
// One rule, used everywhere: a user can see/act on a plan if
// they're an admin, OR they're explicitly listed as a participant
// on that specific plan. Nothing else grants access - not their
// role, not the org chart, nothing implicit.
// ============================================================
const prisma = require('./db');

// Returns the user's participant role on this plan ("DEVELOPER",
// "DEVELOPEE", "ESCALATION_APPROVER"), or null if they're not on it.
async function getParticipantRole(userId, planId) {
  const participant = await prisma.planParticipant.findUnique({
    where: { planId_userId: { planId, userId } },
  });
  return participant ? participant.participantRole : null;
}

// Checks access and sends a 403 response itself if denied, so routes
// can just do: if (!(await checkPlanAccess(req, res, planId))) return;
async function checkPlanAccess(req, res, planId) {
  if (req.user.isAdmin) return true;

  const role = await getParticipantRole(req.user.userId, planId);
  if (!role) {
    res.status(403).json({ error: 'You do not have access to this plan' });
    return false;
  }
  return true;
}

// Same idea, but for actions only the DEVELOPER on the plan (or an
// admin) should be able to do - e.g. reopening after a meeting.
async function checkIsDeveloperOnPlan(req, res, planId) {
  if (req.user.isAdmin) return true;

  const role = await getParticipantRole(req.user.userId, planId);
  if (role !== 'DEVELOPER') {
    res.status(403).json({ error: 'Only the developer on this plan (or an admin) can do this' });
    return false;
  }
  return true;
}

// Checks that the logged-in user matches the SPECIFIC role a task
// is assigned to (DEVELOPER or DEVELOPEE) - an admin can always act
// as an override, same as everywhere else.
async function checkIsAssignedRole(req, res, planId, assignedTo) {
  if (req.user.isAdmin) return true;

  const role = await getParticipantRole(req.user.userId, planId);
  if (role !== assignedTo) {
    res.status(403).json({
      error: `This task is assigned to the ${assignedTo.toLowerCase()} on this plan, not you`,
    });
    return false;
  }
  return true;
}

// Checks that no assessment on this plan is currently "open" (the
// developee has started this attempt but not yet submitted the
// whole test) - modules stay locked during that window so nobody
// can flip back to module content looking for answers. Admins are
// NOT exempt here on purpose - the lock is about preventing
// cheating during a live test, not about permissions.
async function checkNoActiveAssessmentLock(req, res, planId) {
  if (req.user.isAdmin) return true; // admin keeps the same override it has everywhere else

  const openAssessment = await prisma.assessment.findFirst({
    where: { planId, openedAt: { not: null } },
  });
  if (openAssessment) {
    res.status(423).json({
      error: `Modules are locked while the ${openAssessment.gatePosition === 'AFTER_MODULE_4' ? 'midterm' : 'final'} is in progress - submit the test to unlock them again`,
    });
    return false;
  }
  return true;
}

module.exports = { getParticipantRole, checkPlanAccess, checkIsDeveloperOnPlan, checkIsAssignedRole, checkNoActiveAssessmentLock };
