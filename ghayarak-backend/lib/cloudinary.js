// The Cloudinary SDK automatically reads and configures itself from the
// CLOUDINARY_URL environment variable — nothing to pass in manually here.
// If that variable isn't set (Cloudinary not configured yet), every
// upload call will fail with a clear error rather than something
// confusing, since cloudinary.config() below will just have empty values.
const cloudinary = require("cloudinary").v2;

module.exports = { cloudinary };
