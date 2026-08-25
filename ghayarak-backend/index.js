require("dotenv").config();
require("./lib/patchAsyncRoutes"); // must run before any routes/*.js is required
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const authRoutes = require("./routes/auth");
const listingRoutes = require("./routes/listings");
const shopRoutes = require("./routes/shops");
const dealRoutes = require("./routes/deals");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const webhookRoutes = require("./routes/webhooks");
const reviewRoutes = require("./routes/reviews");
const messageRoutes = require("./routes/messages");
const notificationRoutes = require("./routes/notifications");
const financeRoutes = require("./routes/finance");
const adRoutes = require("./routes/ads");
const requestRoutes = require("./routes/requests");

const app = express();
app.use(cors());

// Webhook route needs the raw body for HMAC signature verification,
// so it's mounted with express.raw() BEFORE the global json() parser.
app.use("/webhooks", express.raw({ type: "application/json" }), webhookRoutes);

app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/listings", listingRoutes);
app.use("/shops", shopRoutes);
app.use("/deals", dealRoutes);
app.use("/orders", orderRoutes);
app.use("/admin", adminRoutes);
// reviewRoutes defines its own full paths (/orders/:id/reviews,
// /users/:id/reviews) since a review sits conceptually between those two
// resources rather than under either one — mounted at root so those paths
// resolve as written, falling through from orderRoutes since neither
// router claims a conflicting route.
app.use("/", reviewRoutes);
app.use("/", messageRoutes);
app.use("/notifications", notificationRoutes);
app.use("/", financeRoutes);
app.use("/ads", adRoutes);
app.use("/requests", requestRoutes);

app.use((err, req, res, next) => {
  // A correlation ID goes to the client so a real support conversation can
  // reference "error REQ-xxxx" without ever seeing the actual stack trace —
  // that stays server-side only, in the log line right below.
  const errorId = crypto.randomUUID();
  console.error(`[${errorId}]`, req.method, req.originalUrl, err);
  res.status(err.status || 500).json({ error: "Something went wrong. Please try again.", errorId });
});

const PORT = process.env.PORT || 4000;

// Run migrations before accepting any traffic — see migrate.js for why
// this is safe to do on every single boot, not just the first one.
const { runMigrations } = require("./migrate");
runMigrations()
  .then(() => {
    app.listen(PORT, () => console.log(`Ghayarak API listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("Server failed to start due to migration failure:", err);
    process.exit(1);
  });
