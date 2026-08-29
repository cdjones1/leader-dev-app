// ============================================================
// AUTH ROUTES
// Handles: creating a user (register) and logging in (login).
// ============================================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// --------------------------------------------------------------
// REGISTER — creates a new user.
// SECURITY RULE: only an admin can create new users, with one
// exception - if literally no users exist yet, registration is
// open (otherwise nobody could ever create the very first admin).
// Once at least one user exists, every future registration must
// come from a logged-in admin.
// --------------------------------------------------------------
router.post('/register', async (req, res) => {
  const { name, email, password, role, isAdmin } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password, and role are required' });
  }

  const userCount = await prisma.user.count();

  if (userCount > 0) {
    // Not the first user - an admin must be making this request.
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Only a logged-in admin can register new users' });
    }
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
      if (!decoded.isAdmin) {
        return res.status(403).json({ error: 'Only an admin can register new users' });
      }
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired login token' });
    }
  }
  // else: userCount === 0, this is the bootstrap case - allowed through freely.

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  // Encrypt the password before storing it. "10" is the encryption strength -
  // higher is more secure but slower. 10 is a solid default.
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: { name, email, passwordHash, role, isAdmin: !!isAdmin },
  });

  // Never send the password hash back in a response.
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// --------------------------------------------------------------
// LOGIN — checks email/password, returns a token if correct.
// --------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Create a token that proves who this user is on future requests.
  // It expires after 8 hours, so they'll need to log in again after that.
  const token = jwt.sign(
    { userId: user.id, role: user.role, isAdmin: user.isAdmin },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, isAdmin: user.isAdmin },
  });
});

module.exports = router;
