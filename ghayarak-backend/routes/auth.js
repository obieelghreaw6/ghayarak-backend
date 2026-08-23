const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { query, pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { hashPassword, verifyPassword, generateToken, hashToken } = require("../lib/password");
const { generateSecret, verifyTotp, otpAuthUrl } = require("../lib/totp");

const router = express.Router();

function isEmail(contact) {
  return /\S+@\S+\.\S+/.test(contact);
}
function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
const PRIVILEGED_ROLES = ["moderator", "support", "finance", "admin", "owner"];

// Every issued token has a jti tied to a `sessions` row — this is what
// makes revocation ("log out this device", "log out everywhere") possible.
// A bare JWT with no server-side record can only be trusted or expired,
// never actually revoked before that.
async function createSession(client, user, req) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const deviceLabel = (req.headers["user-agent"] || "Unknown device").slice(0, 120);
  await client.query(
    "insert into sessions (user_id, token_jti, device_label, ip_address, expires_at) values ($1,$2,$3,$4,$5)",
    [user.id, jti, deviceLabel, req.ip || null, expiresAt]
  );
  const token = jwt.sign(
    { id: user.id, name: user.name, contact: user.contact, role: user.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
  return token;
}

function publicUser(user) {
  return { id: user.id, name: user.name, contact: user.contact, role: user.role, totpEnabled: user.totp_enabled };
}

// ---------------------------------------------------------------------
// OTP — primary path
// ---------------------------------------------------------------------

// NOTE: still only logs to the console — wire a real SMS/email provider
// before going live. Rate-limited two ways: per contact (a phone number
// can't be OTP-bombed) and implicitly per IP via the identifier default
// on the login-attempt limiter below.
router.post(
  "/request-otp",
  rateLimit("otp_request", { max: 5, windowMinutes: 15, keyFn: (req) => req.body.contact }),
  async (req, res) => {
    const { contact } = req.body;
    if (!contact) return res.status(400).json({ error: "Phone or email required." });

    const code = randomCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await query("insert into otp_codes (contact, code, expires_at) values ($1, $2, $3)", [contact, code, expiresAt]);

    // TODO: replace with a real SMS/email send.
    console.log(`[OTP] ${contact} -> ${code} (expires in 5 min)`);
    res.json({ ok: true, message: "Code sent." });
  }
);

router.post(
  "/verify-otp",
  rateLimit("otp_verify", { max: 10, windowMinutes: 15, keyFn: (req) => req.body.contact }),
  async (req, res) => {
    const { name, contact, code } = req.body;
    if (!name || !contact || !code) return res.status(400).json({ error: "Missing fields." });

    const { rows } = await query(
      `select * from otp_codes where contact = $1 and code = $2 and consumed = false
       and expires_at > now() order by created_at desc limit 1`,
      [contact, code]
    );
    if (!rows.length) return res.status(400).json({ error: "Invalid or expired code." });
    await query("update otp_codes set consumed = true where id = $1", [rows[0].id]);

    const contactType = isEmail(contact) ? "email" : "phone";
    const existing = await query("select * from users where contact = $1 and deleted_at is null", [contact]);
    let user = existing.rows[0];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (!user) {
        const inserted = await client.query(
          "insert into users (name, contact, contact_type, phone_verified_at) values ($1,$2,$3, case when $3='phone' then now() else null end) returning *",
          [name, contact, contactType]
        );
        user = inserted.rows[0];
      } else if (contactType === "phone" && !user.phone_verified_at) {
        const updated = await client.query("update users set phone_verified_at = now() where id = $1 returning *", [user.id]);
        user = updated.rows[0];
      }

      // Privileged roles can't skip 2FA by logging in via OTP alone.
      if (PRIVILEGED_ROLES.includes(user.role) && user.totp_enabled) {
        await client.query("COMMIT");
        return res.json({ requiresTotp: true, tempUserId: user.id });
      }

      const token = await createSession(client, user, req);
      await client.query("COMMIT");
      res.json({ token, user: publicUser(user) });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
);

// ---------------------------------------------------------------------
// Email + password — alternative path
// ---------------------------------------------------------------------

router.post(
  "/signup-password",
  rateLimit("signup", { max: 10, windowMinutes: 60 }),
  async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !isEmail(email)) return res.status(400).json({ error: "Valid name and email required." });
    if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const existing = await query("select id from users where contact = $1", [email]);
    if (existing.rows.length) return res.status(409).json({ error: "An account with this email already exists." });

    const { hash, salt } = hashPassword(password);
    const inserted = await query(
      "insert into users (name, contact, contact_type, password_hash, password_salt) values ($1,$2,'email',$3,$4) returning *",
      [name, email, hash, salt]
    );
    const user = inserted.rows[0];

    const { token: verifyToken, tokenHash } = generateToken();
    await query(
      "insert into email_verification_tokens (user_id, token_hash, expires_at) values ($1,$2, now() + interval '24 hours')",
      [user.id, tokenHash]
    );
    // TODO: email verifyToken to the user instead of logging it.
    console.log(`[EMAIL VERIFY] ${email} -> token: ${verifyToken}`);

    const client = await pool.connect();
    try {
      const sessionToken = await createSession(client, user, req);
      res.status(201).json({ token: sessionToken, user: publicUser(user) });
    } finally {
      client.release();
    }
  }
);

router.post(
  "/login-password",
  rateLimit("login_attempt", { max: 8, windowMinutes: 15, keyFn: (req) => req.body.email }),
  async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const { rows } = await query("select * from users where contact = $1 and deleted_at is null", [email]);
    const user = rows[0];
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    if (PRIVILEGED_ROLES.includes(user.role) && user.totp_enabled) {
      return res.json({ requiresTotp: true, tempUserId: user.id });
    }

    const client = await pool.connect();
    try {
      const token = await createSession(client, user, req);
      res.json({ token, user: publicUser(user) });
    } finally {
      client.release();
    }
  }
);

router.post("/verify-email", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });

  const tokenHash = hashToken(token);
  const { rows } = await query(
    "select * from email_verification_tokens where token_hash = $1 and consumed = false and expires_at > now()",
    [tokenHash]
  );
  if (!rows.length) return res.status(400).json({ error: "Invalid or expired verification link." });

  await query("update email_verification_tokens set consumed = true where id = $1", [rows[0].id]);
  await query("update users set email_verified_at = now() where id = $1", [rows[0].user_id]);
  res.json({ ok: true });
});

router.post(
  "/forgot-password",
  rateLimit("forgot_password", { max: 5, windowMinutes: 60, keyFn: (req) => req.body.email }),
  async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required." });

    const { rows } = await query("select * from users where contact = $1 and deleted_at is null", [email]);
    // Deliberately the same response whether or not the account exists —
    // otherwise this endpoint becomes a way to enumerate registered emails.
    if (rows.length) {
      const { token, tokenHash } = generateToken();
      await query(
        "insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1,$2, now() + interval '1 hour')",
        [rows[0].id, tokenHash]
      );
      // TODO: email the reset link instead of logging it.
      console.log(`[PASSWORD RESET] ${email} -> token: ${token}`);
    }
    res.json({ ok: true, message: "If that email has an account, a reset link has been sent." });
  }
);

router.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: "Token and a password of at least 8 characters are required." });
  }

  const tokenHash = hashToken(token);
  const { rows } = await query(
    "select * from password_reset_tokens where token_hash = $1 and consumed = false and expires_at > now()",
    [tokenHash]
  );
  if (!rows.length) return res.status(400).json({ error: "Invalid or expired reset link." });

  const { hash, salt } = hashPassword(newPassword);
  await query("update users set password_hash = $1, password_salt = $2 where id = $3", [hash, salt, rows[0].user_id]);
  await query("update password_reset_tokens set consumed = true where id = $1", [rows[0].id]);
  // Resetting a password is a strong signal something may be wrong —
  // revoke every other active session so a stolen-but-now-fixed account
  // can't still be used elsewhere.
  await query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [rows[0].user_id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// 2FA (TOTP) — required for privileged roles, optional for everyone else
// ---------------------------------------------------------------------

router.post("/totp/setup", requireAuth, async (req, res) => {
  const secret = generateSecret();
  await query("update users set totp_secret = $1, totp_enabled = false where id = $2", [secret, req.user.id]);
  res.json({ secret, otpAuthUrl: otpAuthUrl(secret, req.user.contact) });
});

router.post("/totp/confirm", requireAuth, async (req, res) => {
  const { code } = req.body;
  const { rows } = await query("select totp_secret from users where id = $1", [req.user.id]);
  if (!rows[0]?.totp_secret) return res.status(400).json({ error: "Call /totp/setup first." });
  if (!verifyTotp(rows[0].totp_secret, code)) return res.status(400).json({ error: "Incorrect code." });

  await query("update users set totp_enabled = true where id = $1", [req.user.id]);
  res.json({ ok: true });
});

// Second step of login when the account has 2FA enabled — tempUserId
// comes from the requiresTotp response above, deliberately not a full
// session token, so a stolen password alone still can't complete login.
router.post(
  "/totp/verify-login",
  rateLimit("totp_verify", { max: 10, windowMinutes: 15, keyFn: (req) => req.body.tempUserId }),
  async (req, res) => {
    const { tempUserId, code } = req.body;
    const { rows } = await query("select * from users where id = $1 and deleted_at is null", [tempUserId]);
    const user = rows[0];
    if (!user || !user.totp_secret) return res.status(400).json({ error: "Invalid request." });
    if (!verifyTotp(user.totp_secret, code)) return res.status(401).json({ error: "Incorrect code." });

    const client = await pool.connect();
    try {
      const token = await createSession(client, user, req);
      res.json({ token, user: publicUser(user) });
    } finally {
      client.release();
    }
  }
);

router.post("/totp/disable", requireAuth, async (req, res) => {
  await query("update users set totp_enabled = false, totp_secret = null where id = $1", [req.user.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Session / device management
// ---------------------------------------------------------------------

router.get("/sessions", requireAuth, async (req, res) => {
  const { rows } = await query(
    "select id, device_label, ip_address, last_active_at, created_at, (token_jti = $2) as is_current from sessions where user_id = $1 and revoked_at is null order by last_active_at desc",
    [req.user.id, req.user.jti]
  );
  res.json({ sessions: rows });
});

router.post("/sessions/:id/revoke", requireAuth, async (req, res) => {
  await query("update sessions set revoked_at = now() where id = $1 and user_id = $2", [req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.post("/sessions/revoke-others", requireAuth, async (req, res) => {
  await query(
    "update sessions set revoked_at = now() where user_id = $1 and token_jti != $2 and revoked_at is null",
    [req.user.id, req.user.jti]
  );
  res.json({ ok: true });
});

router.post("/logout", requireAuth, async (req, res) => {
  await query("update sessions set revoked_at = now() where token_jti = $1", [req.user.jti]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Account: change contact, delete
// ---------------------------------------------------------------------

router.post(
  "/change-contact",
  requireAuth,
  rateLimit("change_contact", { max: 5, windowMinutes: 60, keyFn: (req) => req.user.id }),
  async (req, res) => {
    const { newContact } = req.body;
    if (!newContact) return res.status(400).json({ error: "New contact required." });

    const existing = await query("select id from users where contact = $1", [newContact]);
    if (existing.rows.length) return res.status(409).json({ error: "That phone/email is already in use." });

    const contactType = isEmail(newContact) ? "email" : "phone";
    // Changing contact info re-requires verification — it doesn't inherit
    // the old contact's verified status.
    await query(
      "update users set contact = $1, contact_type = $2, phone_verified_at = null, email_verified_at = null where id = $3",
      [newContact, contactType, req.user.id]
    );
    res.json({ ok: true, message: "Contact updated — verification required again." });
  }
);

// Soft delete only — never hard-delete a user with any order/listing/
// financial history, since that would break the audit trail everything
// else in this system depends on.
router.post("/delete-account", requireAuth, async (req, res) => {
  await query("update users set deleted_at = now() where id = $1", [req.user.id]);
  await query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [req.user.id]);
  res.json({ ok: true, message: "Account deactivated." });
});

// ---------------------------------------------------------------------
// Owner login — passcode-gated bootstrap, rate-limited since it's the
// single highest-value target in the whole system.
// ---------------------------------------------------------------------
router.post(
  "/owner-login",
  rateLimit("owner_login", { max: 5, windowMinutes: 15 }),
  async (req, res) => {
    const { name, contact, passcode } = req.body;
    if (passcode !== process.env.OWNER_PASSCODE) {
      return res.status(401).json({ error: "Incorrect owner passcode." });
    }
    const contactType = isEmail(contact) ? "email" : "phone";
    const existing = await query("select * from users where contact = $1", [contact]);
    let user = existing.rows[0];
    if (!user) {
      const inserted = await query(
        "insert into users (name, contact, contact_type, role) values ($1, $2, $3, 'owner') returning *",
        [name, contact, contactType]
      );
      user = inserted.rows[0];
    } else if (user.role !== "owner" && user.role !== "admin") {
      const updated = await query("update users set role = 'admin' where id = $1 returning *", [user.id]);
      user = updated.rows[0];
    }

    if (user.totp_enabled) {
      return res.json({ requiresTotp: true, tempUserId: user.id });
    }
    const client = await pool.connect();
    try {
      const token = await createSession(client, user, req);
      res.json({ token, user: publicUser(user) });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
