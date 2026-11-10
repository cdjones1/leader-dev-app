// ============================================================
// AUTH ROUTES
// Handles: creating a user (register) and logging in (login).
// ============================================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('./db');
const requireAuth = require('./requireAuth');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// Google sign-in is switched on by setting GOOGLE_CLIENT_ID in Render.
// Until it is set, everyone keeps signing in with a password, so
// deploying this code can never lock anyone out by itself.
const googleClientId = () => process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client();

function issueToken(user) {
  const token = jwt.sign(
    { userId: user.id, role: user.role, isAdmin: user.isAdmin },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, isAdmin: user.isAdmin } };
}

// Tells the login page whether to show the Google button.
router.get('/config', (req, res) => {
  const id = googleClientId();
  res.json({ googleEnabled: !!id, googleClientId: id });
});

// --------------------------------------------------------------
// GOOGLE SIGN-IN - the browser sends the signed ID token Google gave
// it. We verify it with Google, then sign in whichever user has that
// (verified) Gmail address. Nobody is auto-created: an admin must
// have added the address first.
// --------------------------------------------------------------
router.post('/google', async (req, res) => {
  try {
    const clientId = googleClientId();
    if (!clientId) return res.status(503).json({ error: 'Google sign-in is not set up yet' });
    const { credential } = req.body || {};
    if (typeof credential !== 'string' || !credential) {
      return res.status(400).json({ error: 'Missing Google credential' });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch (err) {
      return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
    }
    if (!payload || !payload.email || payload.email_verified !== true) {
      return res.status(401).json({ error: 'That Google account has no verified email address.' });
    }

    const email = payload.email.trim();
    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!user) {
      return res.status(403).json({ error: `${email} has not been added yet. Ask your leader to add this Gmail address.` });
    }
    res.json(issueToken(user));
  } catch (err) {
    console.error('google sign-in error:', err);
    res.status(500).json({ error: 'Could not sign in with Google' });
  }
});

// --------------------------------------------------------------
// REGISTER — creates a new user.
// SECURITY RULE: only an admin can create new users, with one
// exception - if literally no users exist yet, registration is
// open (otherwise nobody could ever create the very first admin).
// Once at least one user exists, every future registration must
// come from a logged-in admin.
// --------------------------------------------------------------
router.post('/register', async (req, res) => {
  const { name, email, role, isAdmin } = req.body;
  let { password } = req.body;

  if (!name || !email || !role) {
    return res.status(400).json({ error: 'name, email, and role are required' });
  }
  if (isAdmin && !password) {
    return res.status(400).json({ error: 'Admins need a password (it is their backup sign-in)' });
  }
  // People who sign in with Google never use a password, so give them an
  // unguessable random one instead of leaving the field empty.
  if (!password) password = crypto.randomBytes(24).toString('hex');

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

  const existing = await prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } } });
  if (existing) {
    return res.status(409).json({ error: 'A user with that email already exists' });
  }

  // Encrypt the password before storing it. "10" is the encryption strength -
  // higher is more secure but slower. 10 is a solid default.
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: { name, email: email.trim(), passwordHash, role, isAdmin: !!isAdmin },
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

  const user = await prisma.user.findFirst({ where: { email: { equals: String(email).trim(), mode: 'insensitive' } } });
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Once Google sign-in is on, passwords only work for admins (their backup).
  if (googleClientId() && !user.isAdmin) {
    return res.status(403).json({ error: 'Please use "Sign in with Google" with the Gmail address your leader added.' });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  res.json(issueToken(user));
});

// --------------------------------------------------------------
// CHANGE PASSWORD — a signed-in user changes their OWN password.
// Requires the current password so a stranger at an unlocked
// computer can't take over the account.
// --------------------------------------------------------------
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    if (newPassword.length > 200) {
      return res.status(400).json({ error: 'New password is too long' });
    }
    // Always look the user up fresh from the database.
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(403).json({ error: 'Current password is incorrect' });

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from your current password' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    res.json({ message: 'Password changed' });
  } catch (err) {
    console.error('change-password error:', err);
    res.status(500).json({ error: 'Could not change password' });
  }
});

module.exports = router;
