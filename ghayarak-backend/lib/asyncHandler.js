// Express 4 does not forward a rejected promise from an `async (req, res) =>`
// handler to error-handling middleware — it just hangs or crashes the
// process on an unhandled rejection. Wrap every async handler with this so
// a thrown error always reaches the centralized error handler in index.js
// and comes back to the client as a clean, generic message instead of a
// raw stack trace or a dropped connection.
//
// Usage: router.post("/:id/accept", requireAuth, asyncHandler(async (req, res) => { ... }));
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
