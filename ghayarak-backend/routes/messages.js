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

// Listing-scoped thread — for pre-purchase questions, before an order
// exists. A popular listing can get questions from several different
// buyers at once, so this is a real conversation between two specific
// people (buyer <-> seller), not just "everything tied to this listing" —
// otherwise a seller's view would show every buyer's messages merged
// together with no way to tell the threads apart.
router.get("/listings/:listingId/messages", requireAuth, async (req, res) => {
  const listing = await query("select seller_id from listings where id = $1", [req.params.listingId]);
  if (!listing.rows.length) return res.status(404).json({ error: "Listing not found." });
  const sellerId = listing.rows[0].seller_id;
  const isSeller = req.user.id === sellerId;
  const otherPartyId = isSeller ? req.query.withUserId : sellerId;
  if (isSeller && !otherPartyId) {
    return res.status(400).json({ error: "withUserId is required when viewing your own listing's messages." });
  }

  const { rows } = await query(
    `select * from messages where listing_id = $1
     and ((sender_id = $2 and recipient_id = $3) or (sender_id = $3 and recipient_id = $2))
     order by created_at asc`,
    [req.params.listingId, req.user.id, otherPartyId]
  );
  res.json({ messages: rows });
});

// A seller REPLYING needs to say which buyer they're replying to
// (recipientId) — there's no single implicit "the other party" the way
// there is for a buyer, who is always talking to the seller.
// Seller-only: who has messaged them about this listing, so they have
// something to pick from before opening a specific thread with
// ?withUserId=... above.
router.get("/listings/:listingId/conversations", requireAuth, async (req, res) => {
  const listing = await query("select seller_id from listings where id = $1", [req.params.listingId]);
  if (!listing.rows.length) return res.status(404).json({ error: "Listing not found." });
  if (listing.rows[0].seller_id !== req.user.id) return res.status(403).json({ error: "Only the seller can see this." });

  const { rows } = await query(
    `select distinct on (other_user_id) other_user_id, u.name as other_user_name, m.body as last_body, m.created_at as last_at
     from (
       select case when sender_id = $2 then recipient_id else sender_id end as other_user_id, body, created_at
       from messages where listing_id = $1 and (sender_id = $2 or recipient_id = $2)
     ) m
     join users u on u.id = m.other_user_id
     order by other_user_id, m.created_at desc`,
    [req.params.listingId, req.user.id]
  );
  res.json({ conversations: rows });
});

router.post("/listings/:listingId/messages", requireAuth, rateLimit("message_send", { max: 30, windowMinutes: 10, keyFn: (req) => req.user.id }), async (req, res) => {
  const { body, recipientId } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: "Message body required." });

  const listing = await query("select * from listings where id = $1", [req.params.listingId]);
  if (!listing.rows.length) return res.status(404).json({ error: "Listing not found." });
  const l = listing.rows[0];

  const isSeller = req.user.id === l.seller_id;
  const finalRecipientId = isSeller ? recipientId : l.seller_id;
  if (!finalRecipientId) return res.status(400).json({ error: "recipientId is required when replying as the seller." });
  if (finalRecipientId === req.user.id) return res.status(400).json({ error: "You can't message yourself." });

  const { rows } = await query(
    "insert into messages (listing_id, sender_id, recipient_id, body) values ($1,$2,$3,$4) returning *",
    [req.params.listingId, req.user.id, finalRecipientId, body.trim()]
  );
  await notify(finalRecipientId, "new_message", "New message", body.trim().slice(0, 120), "listing", req.params.listingId);
  res.status(201).json({ message: rows[0] });
});

// Request-scoped thread — replaces the old "reveal a raw phone number
// after accepting an offer, with nothing to do next" flow. Same
// multi-party shape as listings: a request has one requester but can get
// offers (and therefore separate conversations) from several different
// sellers, so this needs the same "which specific other party"
// disambiguation.
router.get("/requests/:requestId/messages", requireAuth, async (req, res) => {
  const request = await query("select requester_id from part_requests where id = $1", [req.params.requestId]);
  if (!request.rows.length) return res.status(404).json({ error: "Request not found." });
  const requesterId = request.rows[0].requester_id;
  const isRequester = req.user.id === requesterId;
  const otherPartyId = isRequester ? req.query.withUserId : requesterId;
  if (isRequester && !otherPartyId) {
    return res.status(400).json({ error: "withUserId is required when viewing your own request's messages." });
  }

  const { rows } = await query(
    `select * from messages where request_id = $1
     and ((sender_id = $2 and recipient_id = $3) or (sender_id = $3 and recipient_id = $2))
     order by created_at asc`,
    [req.params.requestId, req.user.id, otherPartyId]
  );
  res.json({ messages: rows });
});

// Requester-only: which sellers have messaged them about this request
// (e.g. to discuss an offer), so they have something to pick from before
// opening one specific thread with ?withUserId=... above.
router.get("/requests/:requestId/conversations", requireAuth, async (req, res) => {
  const request = await query("select requester_id from part_requests where id = $1", [req.params.requestId]);
  if (!request.rows.length) return res.status(404).json({ error: "Request not found." });
  if (request.rows[0].requester_id !== req.user.id) return res.status(403).json({ error: "Only the requester can see this." });

  const { rows } = await query(
    `select distinct on (other_user_id) other_user_id, u.name as other_user_name, m.body as last_body, m.created_at as last_at
     from (
       select case when sender_id = $2 then recipient_id else sender_id end as other_user_id, body, created_at
       from messages where request_id = $1 and (sender_id = $2 or recipient_id = $2)
     ) m
     join users u on u.id = m.other_user_id
     order by other_user_id, m.created_at desc`,
    [req.params.requestId, req.user.id]
  );
  res.json({ conversations: rows });
});

// A request has exactly one requester, so a seller messaging always
// implicitly means "the requester" — recipientId is only needed when the
// requester is the one sending, since they might be talking to several
// different sellers who each made an offer.
router.post("/requests/:requestId/messages", requireAuth, rateLimit("message_send", { max: 30, windowMinutes: 10, keyFn: (req) => req.user.id }), async (req, res) => {
  const { body, recipientId } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: "Message body required." });

  const request = await query("select * from part_requests where id = $1", [req.params.requestId]);
  if (!request.rows.length) return res.status(404).json({ error: "Request not found." });
  const r = request.rows[0];

  const isRequester = req.user.id === r.requester_id;
  const finalRecipientId = isRequester ? recipientId : r.requester_id;
  if (!finalRecipientId) return res.status(400).json({ error: "recipientId is required when messaging as the requester." });
  if (finalRecipientId === req.user.id) return res.status(400).json({ error: "You can't message yourself." });

  const { rows } = await query(
    "insert into messages (request_id, sender_id, recipient_id, body) values ($1,$2,$3,$4) returning *",
    [req.params.requestId, req.user.id, finalRecipientId, body.trim()]
  );
  await notify(finalRecipientId, "new_message", "New message", body.trim().slice(0, 120), "request", req.params.requestId);
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
