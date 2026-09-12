// The Cloudinary SDK automatically reads and configures itself from the
// CLOUDINARY_URL environment variable — nothing to pass in manually here.
// If that variable isn't set (Cloudinary not configured yet), every
// upload call will fail with a clear error rather than something
// confusing, since cloudinary.config() below will just have empty values.
const cloudinary = require("cloudinary").v2;

// Temporary diagnostic: confirms exactly what the SDK actually parsed
// from CLOUDINARY_URL, without ever logging the secret itself — only
// whether it's present, and its length, which is enough to tell "empty"
// apart from "wrong" without exposing the value in logs. Also checks the
// container's own clock directly — Cloudinary's signed-upload scheme
// rejects requests whose timestamp is too far from its own server time,
// so a skewed container clock would cause exactly the "Invalid
// Signature" error being chased right now, even with fully correct
// credentials.
const cfg = cloudinary.config();
console.log("Cloudinary config check:", {
  cloud_name: cfg.cloud_name || "(missing)",
  api_key: cfg.api_key || "(missing)",
  api_secret_present: !!cfg.api_secret,
  api_secret_length: cfg.api_secret ? cfg.api_secret.length : 0,
});
console.log("Server clock check:", {
  unix_seconds: Math.floor(Date.now() / 1000),
  iso: new Date().toISOString(),
});

module.exports = { cloudinary };
