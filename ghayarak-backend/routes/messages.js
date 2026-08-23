const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");

const router = express.Router();
const staffRoles = ["moderator", "support", "admin", "owner"];

async function notify(userId, type, title, body, refType, refId) {
  await query(
    "insert into notifications (user_id, type, title, body, ref_type, ref_id) values ($1,$2,$3,$4,$5,$6)",
    [userId, type, title, body, refType, refId]
  );
}

// Order-scoped thread.
router.get("/orders/:orderId/messages", requireAuth, async (req, res) => {
  const order = await query("select * from orders where id = $1", [req.params.orderId]);
  if (!order.rows.length) return res.status(404).json({ error: "Order not found." });
  const o = order.rows[0];
  if (![o.buyer_id, o.seller_id].includes(req.user.id) && !staffRoles.includes(req.user.role)) {
    return res.status(403).json({ error: "Not your order." });
  }
  const { rows } = await query("select * from messages where order_id = $1 order by created_at asc", [req.params.orderId]);
  res.json({ messages: rows });
});

router.post("/orders/:orderId/messages", requireAuth, rateLimit("message_send", { max: 30, windowMinutes: 10, keyFn: (req) => req.user.id }), async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: "Message body required." });

  const order = await query("select * from orders where id = $1", [req.params.orderId]);
  if (!order.rows.length) return res.status(404).json({ error: "Order not found." });
  const o = order.rows[0];
  if (![o.buyer_id, o.seller_id].includes(req.user.id)) return res.status(403).json({ error: "Not your order." });

  const recipientId = req.user.id === o.buyer_id ? o.seller_id : o.buyer_id;
  const { rows } = await query(
    "insert into messages (order_id, sender_id, recipient_id, body) values ($1,$2,$3,$4) returning *",
    [req.params.orderId, req.user.id, recipientId, body.trim()]
  );
  await notify(recipientId, "new_message", "New message", body.trim().slice(0, 120), "order", req.params.orderId);
  res.status(201).json({ message: rows[0] });
});

// Listing-scoped thread — for pre-purchase questions, before an order exists.
router.get("/listings/:listingId/messages", requireAuth, async (req, res) => {
  const { rows } = await query(
    `select * from messages where listing_id = $1 and (sender_id = $2 or recipient_id = $2) order by created_at asc`,
    [req.params.listingId, req.user.id]
  );
  res.json({ messages: rows });
});

router.post("/listings/:listingId/messages", requireAuth, rateLimit("message_send", { max: 30, windowMinutes: 10, keyFn: (req) => req.user.id }), async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: "Message body required." });

  const listing = await query("select * from listings where id = $1", [req.params.listingId]);
  if (!listing.rows.length) return res.status(404).json({ error: "Listing not found." });
  const l = listing.rows[0];
  if (l.seller_id === req.user.id) return res.status(400).json({ error: "You can't message yourself about your own listing." });

  const { rows } = await query(
    "insert into messages (listing_id, sender_id, recipient_id, body) values ($1,$2,$3,$4) returning *",
    [req.params.listingId, req.user.id, l.seller_id, body.trim()]
  );
  await notify(l.seller_id, "new_message", "New message", body.trim().slice(0, 120), "listing", req.params.listingId);
  res.status(201).json({ message: rows[0] });
});

router.post("/messages/:id/read", requireAuth, async (req, res) => {
  const { rows } = await query(
    "update messages set read_at = now() where id = $1 and recipient_id = $2 and read_at is null returning *",
    [req.params.id, req.user.id]
  );
  res.json({ message: rows[0] || null });
});

module.exports = router;
