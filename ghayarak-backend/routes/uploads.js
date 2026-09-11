const express = require("express");
const multer = require("multer");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { cloudinary } = require("../lib/cloudinary");

const router = express.Router();

// iPhones save camera photos as HEIC/HEIF by default, not JPEG — without
// allowing these, a photo picked straight from Camera Roll gets silently
// rejected here. Cloudinary transcodes them to a normal web format
// automatically (same fetch_format: "auto" setting already used below),
// so there's no need to convert anything before it reaches Cloudinary.
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB — generous for a phone photo, not so large someone on a weak connection is stuck forever
const MAX_FILES_PER_REQUEST = 10;
const ALLOWED_PURPOSES = ["listing", "request", "offer", "shop_logo", "shop_cover", "dispute", "profile"];

// Memory storage, not disk — Railway's filesystem is ephemeral, and the
// file only needs to exist in memory long enough to stream it to
// Cloudinary, never actually saved locally.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WebP, or HEIC images are allowed."));
    }
    cb(null, true);
  },
});

function uploadBufferToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    // Deliberately no quality/fetch_format here — passing those as
    // upload-time options was causing a genuine Cloudinary signature
    // bug (the SDK folded them into an implicit "transformation" string
    // that didn't match what was actually signed). Optimization happens
    // at delivery time instead, via displayUrl()/thumbnailUrl() below —
    // the exact same safe approach the thumbnail already used
    // successfully, just now applied to the main image too.
    const stream = cloudinary.uploader.upload_stream(
      { folder: `ghayarak/${folder}` },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// Cloudinary picks the best format/quality automatically (e.g. serving
// WebP/AVIF to browsers that support it) — applied here, at delivery
// time via a URL parameter, not at upload time.
function displayUrl(publicId) {
  return cloudinary.url(publicId, { quality: "auto", fetch_format: "auto" });
}

// A thumbnail doesn't need a second upload — Cloudinary can transform any
// existing image on the fly via URL parameters, so this just builds that
// URL from the same public_id.
function thumbnailUrl(publicId) {
  return cloudinary.url(publicId, { width: 300, height: 300, crop: "fill", quality: "auto", fetch_format: "auto" });
}

// POST /uploads — multipart, field name "images", accepts multiple files
// at once. purpose is required so the folder and later validation both
// know what kind of image this is.
router.post(
  "/",
  requireAuth,
  rateLimit("image_upload", { max: 60, windowMinutes: 60, keyFn: (req) => req.user.id }),
  upload.array("images", MAX_FILES_PER_REQUEST),
  async (req, res) => {
    const { purpose } = req.body;
    if (!ALLOWED_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "Invalid or missing purpose." });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "At least one image is required." });
    }

    const results = [];
    for (const file of req.files) {
      // Uploaded one at a time (not Promise.all) so a failure partway
      // through still leaves the successful ones usable, and the error
      // clearly identifies which file failed.
      try {
        const cloudinaryResult = await uploadBufferToCloudinary(file.buffer, purpose);
        const { rows } = await query(
          `insert into uploads (public_id, url, thumbnail_url, uploader_id, purpose)
           values ($1,$2,$3,$4,$5) returning *`,
          [cloudinaryResult.public_id, displayUrl(cloudinaryResult.public_id), thumbnailUrl(cloudinaryResult.public_id), req.user.id, purpose]
        );
        const row = rows[0];
        results.push({ id: row.id, publicId: row.public_id, url: row.url, thumbnailUrl: row.thumbnail_url });
      } catch (e) {
        console.error(`Upload failed for ${file.originalname}`, e);
        return res.status(results.length > 0 ? 207 : 500).json({
          error: `"${file.originalname}" failed to upload. ${results.length > 0 ? "Earlier files in this batch did upload successfully." : ""}`,
          uploaded: results,
        });
      }
    }

    res.status(201).json({ uploads: results });
  }
);

// Safe deletion: only the person who uploaded an image can delete it.
// Removes it from Cloudinary itself, not just the tracking row — leaving
// orphaned files in storage after "deletion" would be a real, if
// invisible, bug.
router.delete("/:id", requireAuth, async (req, res) => {
  const { rows } = await query("select * from uploads where id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Upload not found." });
  if (rows[0].uploader_id !== req.user.id) return res.status(403).json({ error: "Not your upload." });

  try {
    await cloudinary.uploader.destroy(rows[0].public_id);
  } catch (e) {
    console.error("Cloudinary deletion failed — DB row removed anyway to avoid a stuck 'can't delete' state", e);
  }
  await query("delete from uploads where id = $1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
