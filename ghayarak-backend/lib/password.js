const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A single opaque token for password-reset / email-verification links.
// Only the hash is stored — if the database leaked, the tokens in it
// wouldn't be usable, same principle as password storage.
function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { hashPassword, verifyPassword, generateToken, hashToken };
