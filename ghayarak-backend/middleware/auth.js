const jwt = require("jsonwebtoken");
const { query } = require("../db");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in required." });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Session expired, please sign in again." });
  }

  // A valid JWT signature is necessary but not sufficient — it could have
  // been logged out, revoked via "log out all devices", or invalidated by
  // a password reset. Without this check, revocation would be entirely
  // theater: the token stays usable until its 30-day expiry regardless of
  // what the user did in the meantime.
  //
  // This also re-checks the user's live status on every request, not just
  // at login — banning or suspending someone doesn't revoke their existing
  // sessions, so without this a banned user with a still-valid token could
  // keep acting on the platform until their token happened to expire.
  try {
    const { rows } = await query(
      `select s.id from sessions s
       join users u on u.id = s.user_id
       where s.token_jti = $1 and s.revoked_at is null and s.expires_at > now()
         and u.status = 'approved' and u.deleted_at is null`,
      [payload.jti]
    );
    if (!rows.length) return res.status(401).json({ error: "Session expired, please sign in again." });

    query("update sessions set last_active_at = now() where token_jti = $1", [payload.jti]).catch(() => {});
  } catch (e) {
    console.error("Session check failed", e);
    return res.status(401).json({ error: "Session expired, please sign in again." });
  }

  req.user = payload;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You don't have access to this." });
    }
    next();
  };
}

// For public endpoints that behave differently for the owner/staff than
// for everyone else (e.g. a pending listing should still be visible to
// its own seller) — populates req.user if a valid, non-revoked token is
// present, but never rejects the request if it's absent or invalid.
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query(
      "select id from sessions where token_jti = $1 and revoked_at is null and expires_at > now()",
      [payload.jti]
    );
    if (rows.length) req.user = payload;
  } catch {
    // Invalid/expired token on an optional-auth route just means "treat as anonymous."
  }
  next();
}

module.exports = { requireAuth, requireRole, optionalAuth };
