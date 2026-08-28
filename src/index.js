require('dotenv').config();
const express = require('express');
const prisma = require('./db');
const authRoutes = require('./auth');
const moduleRoutes = require('./modules');
const assessmentRoutes = require('./assessments');
const testRoutes = require('./testRoutes');
const { router: adminRoutes } = require('./admin');
const requireAuth = require('./requireAuth');
const { startScheduler } = require('./scheduler');

const app = express();
app.use(express.json()); // lets the app read JSON sent in requests
app.use(express.static('public')); // serves the login page and dashboard

// Public routes - no login required
app.use('/auth', authRoutes);

// Module and assessment routes - require login (checked inside each file)
app.use('/modules', moduleRoutes);
app.use('/assessments', assessmentRoutes);
app.use('/test', testRoutes);
app.use('/admin', adminRoutes);

// --------------------------------------------------------------
// EXAMPLE PROTECTED ROUTE
// Proves the whole chain works: token required, and access
// depends on whether you're an admin (per our access-control design).
// --------------------------------------------------------------
app.get('/pairings', requireAuth, async (req, res) => {
  if (req.user.isAdmin) {
    // Admins see everything
    const pairings = await prisma.developerPairing.findMany({
      include: { developer: true, developee: true },
    });
    return res.json(pairings);
  }

  // Everyone else only sees pairings they're personally part of
  const pairings = await prisma.developerPairing.findMany({
    where: {
      OR: [{ developerId: req.user.userId }, { developeeId: req.user.userId }],
    },
    include: { developer: true, developee: true },
  });
  res.json(pairings);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startScheduler(); // begin checking for overdue modules every 5 minutes
});
