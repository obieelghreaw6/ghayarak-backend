const { query } = require("../db");

/**
 * rateLimit("otp_request", { max: 3, windowMinutes: 15 })
 *
 * Limits by IP by default; pass `keyFn` to limit by something else (e.g.
 * the contact being OTP'd, so one phone number can't be spammed from many
 * IPs, and one IP can't spam many phone numbers).
 */
function rateLimit(action, { max, windowMinutes, keyFn } = {}) {
  return async (req, res, next) => {
    try {
      const identifier = keyFn ? keyFn(req) : (req.ip || req.headers["x-forwarded-for"] || "unknown");
      if (!identifier) return next();

      const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
      const { rows } = await query(
        "select count(*) from rate_limit_events where identifier = $1 and action = $2 and created_at >= $3",
        [identifier, action, windowStart]
      );
      const count = Number(rows[0].count);

      if (count >= max) {
        return res.status(429).json({
          error: "Too many attempts. Try again in a few minutes.",
          retryAfterMinutes: windowMinutes,
        });
      }

      await query("insert into rate_limit_events (identifier, action) values ($1, $2)", [identifier, action]);
      next();
    } catch (e) {
      // Rate limiting failing open (allowing the request through) is the
      // safer failure mode than accidentally locking every user out
      // because the rate_limit_events table had a transient issue.
      console.error("Rate limit check failed, allowing request through", e);
      next();
    }
  };
}

module.exports = { rateLimit };
