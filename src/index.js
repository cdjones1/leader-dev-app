require('dotenv').config();
const express = require('express');
const prisma = require('./db');
const authRoutes = require('./auth');
const moduleRoutes = require('./modules');
const assessmentRoutes = require('./assessments');
const { router: adminRoutes } = require('./admin');
const planRoutes = require('./plans');
const pairingRoutes = require('./pairings');
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
app.use('/admin', adminRoutes);
app.use('/plans', planRoutes);
app.use('/pairings', pairingRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startScheduler(); // begin checking for overdue modules every 5 minutes
});
