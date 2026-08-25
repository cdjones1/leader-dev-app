// ============================================================
// This "middleware" runs before any protected route.
// It checks: did this request include a valid login token?
// If yes, it attaches the user's info to req.user and continues.
// If no, it stops the request with a 401 (Unauthorized) error.
// ============================================================
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization; // expected format: "Bearer <token>"

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing login token' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, role, isAdmin }
    next(); // continue to the actual route
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired login token' });
  }
}

module.exports = requireAuth;
