const express = require("express");
const { pool, query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { createInvoice } = require("../payments/dpay");

const router = express.Router();

const COMMISSION_PCT = 5.0;
const DELIVERY_FLAT = 50;
const PROTECTION_PCT = 0.05;
const OPEN_STATUSES = ["pending", "accepted", "preparing", "ready_for_pickup", "out_for_delivery", "collected", "delivered"];

async function logStatus(client, orderId, fromStatus, toStatus, changedBy, note) {
  await client.query(
    "insert into order_status_history (order_id, from_status, to_status, changed_by, note) values ($1,$2,$3,$4,$5)",
    [orderId, fromStatus, toStatus, changedBy, note || null]
  );
}

async function notify(client, userId, type, title, body, refId) {
  await client.query(
    "insert into notifications (user_id, type, title, body, ref_type, ref_id) values ($1,$2,$3,$4,'order',$5)",
    [userId, type, title, body, refId]
  );
}

async function getOrderOr404(req, res) {
  const { rows } = await query("select * from orders where id = $1", [req.params.id]);
  if (!rows.length) { res.status(404).json({ error: "Order not found." }); return null; }
  return rows[0];
}

// Short, human-enterable code a seller can type in without fumbling —
// no ambiguous characters (0/O, 1/I/l excluded), uppercase only.
function generateReservationCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `GHY-${code}`;
}

// Shared by both the normal buyer-confirms-receipt flow and the shop
// reserve-and-redeem flow — same financial trigger point (snapshot the
// commission, open a settlement, invoice the seller) regardless of which
// path got the order there. actorId is whoever's action completed it
// (the buyer confirming, or the seller redeeming a code), for the status
// history log.
async function completeOrder(order, actorId) {
  const client = await pool.connect();
  let order_result, commissionRow, settlementRow;
  try {
    await client.query("BEGIN");
    order_result = await client.query("update orders set status = 'completed', completed_at = now() where id = $1 returning *", [order.id]);
    await logStatus(client, order.id, order.status, "completed", actorId, null);

    await client.query("update listings set status = 'sold', reserved_order_id = null where id = $1", [order.listing_id]);

    const commission = await client.query(
      `insert into seller_commissions (order_id, seller_id, gross_sale_amount, commission_pct, commission_amount)
       values ($1,$2,$3,$4,$5) returning *`,
      [order.id, order.seller_id, order.part_price, order.commission_pct, order.commission_amount]
    );
    commissionRow = commission.rows[0];

    const settlement = await client.query(
      `insert into settlements (order_id, seller_commission_id, seller_id, shop_id, commission_amount, status)
       values ($1,$2,$3,$4,$5,'owed') returning *`,
      [order.id, commissionRow.id, order.seller_id, order.shop_id, commissionRow.commission_amount]
    );
    settlementRow = settlement.rows[0];

    await notify(client, order.seller_id, "order_completed", "Order completed — commission due", order.id, order.id);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // Invoice the seller for their commission. Kept outside the
  // transaction: a DPAY outage shouldn't roll back the completion or the
  // settlement record — it should just leave the settlement at 'owed' for
  // manual follow-up (see GET /admin/settlements).
  try {
    const seller = await query("select * from users where id = $1", [order.seller_id]);
    const invoice = await createInvoice({
      amount: settlementRow.commission_amount,
      description: `Ghayarak commission — order ${order.id}`,
      customerContact: seller.rows[0].contact,
      metadata: { type: "commission", settlementId: settlementRow.id },
    });
    await query("update settlements set status = 'invoiced', dpay_invoice_id = $1 where id = $2", [invoice.id, settlementRow.id]);
    await query(
      "insert into payments (dpay_invoice_id, kind, ref_id, amount, status) values ($1,'commission',$2,$3,'pending')",
      [invoice.id, settlementRow.id, settlementRow.commission_amount]
    );
  } catch (e) {
    console.error("Commission invoice failed — settlement remains 'owed' for manual collection", e);
  }

  return { order: order_result.rows[0], settlement: settlementRow };
}

// GET /orders?role=buyer|seller — "My orders" or "My sales". Joins in
// both party names and the listing title, since the UI displays these
// directly — without this join, the frontend would only have opaque IDs
// to show for "who's the buyer/seller."
router.get("/", requireAuth, async (req, res) => {
  const { role = "buyer" } = req.query;
  const column = role === "seller" ? "seller_id" : "buyer_id";
  const { rows } = await query(
    `select o.*, l.title as listing_title, b.name as buyer_name, b.contact as buyer_contact,
            s.name as seller_name, s.contact as seller_contact
     from orders o
     join listings l on l.id = o.listing_id
     join users b on b.id = o.buyer_id
     join users s on s.id = o.seller_id
     where o.${column} = $1 order by o.created_at desc`,
    [req.user.id]
  );
  res.json({ orders: rows });
});

const STAFF_ROLES = ["moderator", "support", "finance", "admin", "owner"];

// Must come before GET /:id below — otherwise "lookup-by-code" would be
// swallowed as an :id value. Lets a seller find the right order just
// from the code the customer shows them in person, without already
// knowing which order it belongs to.
router.get("/lookup-by-code/:code", requireAuth, async (req, res) => {
  const { rows } = await query(
    `select o.*, l.title as listing_title, b.name as buyer_name
     from orders o join listings l on l.id = o.listing_id join users b on b.id = o.buyer_id
     where o.reservation_code = $1`,
    [req.params.code.trim().toUpperCase()]
  );
  if (!rows.length) return res.status(404).json({ error: "No reservation found with that code." });
  const order = rows[0];
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: "This reservation belongs to a different seller." });
  res.json({ order });
});

router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await query(
    `select o.*, l.title as listing_title, b.name as buyer_name, b.contact as buyer_contact,
            s.name as seller_name, s.contact as seller_contact
     from orders o
     join listings l on l.id = o.listing_id
     join users b on b.id = o.buyer_id
     join users s on s.id = o.seller_id
     where o.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Order not found." });
  const order = rows[0];
  if (![order.buyer_id, order.seller_id].includes(req.user.id) && !STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "Not your order." });
  }
  const [history, disputes, protection, refunds, bankConfirmations] = await Promise.all([
    query("select * from order_status_history where order_id = $1 order by created_at asc", [req.params.id]),
    query("select * from disputes where order_id = $1 order by created_at desc", [req.params.id]),
    query("select * from buyer_protection where order_id = $1", [req.params.id]),
    query("select * from refunds where order_id = $1 order by created_at desc", [req.params.id]),
    query("select * from bank_transfer_confirmations where order_id = $1 order by created_at desc", [req.params.id]),
  ]);
  res.json({
    order, history: history.rows, disputes: disputes.rows, protection: protection.rows[0] || null,
    refunds: refunds.rows, bankTransferConfirmations: bankConfirmations.rows,
  });
});

// Buyer places an order. This does not charge anyone — Ghayarak never
// touches the payment. It records the order and snapshots pricing so
// later listing-price changes can't retroactively alter what was agreed.
router.post("/", requireAuth, async (req, res) => {
  const { listingId, paymentMethod, paymentMethodDetail, deliveryMethod, includeProtection, deliveryAddress, deliveryNotes } = req.body;

  if (!["cash", "lypay", "card", "bank", "other", "reserve_at_shop"].includes(paymentMethod)) {
    return res.status(400).json({ error: "Invalid payment method." });
  }
  if (paymentMethod === "other" && !paymentMethodDetail?.trim()) {
    return res.status(400).json({ error: "Specify what payment method 'other' means." });
  }
  if (paymentMethod === "reserve_at_shop" && deliveryMethod !== "pickup") {
    return res.status(400).json({ error: "Reserve & Pay at Shop is pickup-only." });
  }
  if (deliveryMethod === "delivery" && !deliveryAddress?.trim()) {
    return res.status(400).json({ error: "Delivery address is required for delivery orders." });
  }
  const paymentCategory = paymentMethod === "cash" || paymentMethod === "reserve_at_shop" ? "cash" : "electronic";

  const { rows } = await query(
    `select l.*, u.status as seller_status, s.status as shop_status
     from listings l join users u on u.id = l.seller_id left join shops s on s.id = l.shop_id
     where l.id = $1 and l.status = 'active' and l.moderation_status = 'approved'`,
    [listingId]
  );
  if (!rows.length) return res.status(404).json({ error: "Listing not found or not available." });
  const { seller_status, shop_status, ...listing } = rows[0];
  // A suspended/banned seller's listing shouldn't be orderable via a
  // direct API call just because it's still technically 'active' in the
  // listings table — this is the same enforcement as the search-hiding
  // fix, applied at the one place that actually matters financially.
  if (seller_status !== "approved" || (listing.shop_id && shop_status !== "approved")) {
    return res.status(404).json({ error: "Listing not found or not available." });
  }
  if (listing.seller_id === req.user.id) return res.status(400).json({ error: "You can't buy your own listing." });

  // App-level check first (cheap, gives a fast friendly response in the
  // common case). This alone is NOT sufficient against a real double-tap
  // or network retry — see the unique index on orders(listing_id, buyer_id)
  // in the schema, which is what actually prevents the race below.
  const existing = await query(
    `select id from orders where listing_id = $1 and buyer_id = $2 and status = any($3)`,
    [listingId, req.user.id, OPEN_STATUSES]
  );
  if (existing.rows.length) {
    return res.status(409).json({ error: "You already have an open order on this listing.", orderId: existing.rows[0].id });
  }

  const deliveryFee = deliveryMethod === "delivery" ? DELIVERY_FLAT : 0;
  const protectionFee = includeProtection && listing.protected_deal ? Math.round(listing.price * PROTECTION_PCT * 100) / 100 : 0;
  const commissionAmount = Math.round(listing.price * (COMMISSION_PCT / 100) * 100) / 100;
  // Rough placeholder estimate until real courier integration exists —
  // pickup has no transit time, delivery gets a flat 2-day estimate.
  const estimatedDeliveryAt = deliveryMethod === "delivery" ? new Date(Date.now() + 2 * 86400000) : null;
  const reservationCode = paymentMethod === "reserve_at_shop" ? generateReservationCode() : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query(
      `insert into orders
        (listing_id, buyer_id, seller_id, shop_id, part_price, delivery_fee, protection_fee,
         commission_pct, commission_amount, payment_method, payment_category, payment_method_detail, delivery_method,
         delivery_address, delivery_notes, estimated_delivery_at, reservation_code)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
      [listingId, req.user.id, listing.seller_id, listing.shop_id, listing.price, deliveryFee, protectionFee,
       COMMISSION_PCT, commissionAmount, paymentMethod, paymentCategory, paymentMethodDetail || null, deliveryMethod,
       deliveryAddress || null, deliveryNotes || null, estimatedDeliveryAt, reservationCode]
    );
    const o = order.rows[0];
    await client.query(
      "insert into order_items (order_id, listing_id, quantity, unit_price, line_commission) values ($1,$2,1,$3,$4)",
      [o.id, listingId, listing.price, commissionAmount]
    );
    await logStatus(client, o.id, null, "pending", req.user.id, "Order placed");
    if (protectionFee > 0) {
      await client.query("insert into buyer_protection (order_id, fee_amount) values ($1,$2)", [o.id, protectionFee]);
    }
    await notify(client, listing.seller_id, "new_order", "New order", `Order ${o.id} for ${listing.title}`, o.id);
    await client.query("COMMIT");
    res.status(201).json({ order: o });
  } catch (e) {
    await client.query("ROLLBACK");
    // Postgres error code 23505 = unique_violation. This is the double-tap
    // / network-retry race actually getting caught — turn it into the same
    // friendly 409 the app-level check above returns, instead of a raw 500.
    if (e.code === "23505") {
      // The reservation code collision is a genuinely different situation
      // from a duplicate order — vanishingly rare (1-in-a-billion-ish
      // character space) but distinguished by constraint name so the
      // error message is actually accurate rather than assuming the more
      // common case.
      if (e.constraint === "idx_orders_reservation_code") {
        return res.status(409).json({ error: "Couldn't generate a unique reservation code — please try again." });
      }
      const dup = await query(
        `select id from orders where listing_id = $1 and buyer_id = $2 and status = any($3) order by created_at desc limit 1`,
        [listingId, req.user.id, OPEN_STATUSES]
      );
      return res.status(409).json({ error: "You already have an open order on this listing.", orderId: dup.rows[0]?.id });
    }
    throw e;
  } finally {
    client.release();
  }
});

// Seller accepts a pending order. Reserves the listing for this buyer and
// auto-declines any other still-pending orders on the same listing.
router.post("/:id/accept", requireAuth, async (req, res) => {
  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: "Only the seller can accept this order." });
  if (order.status !== "pending") return res.status(400).json({ error: `Order is '${order.status}', can't accept.` });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query("update orders set status = 'accepted', accepted_at = now() where id = $1 returning *", [req.params.id]);
    await logStatus(client, req.params.id, "pending", "accepted", req.user.id, null);

    await client.query("update listings set status = 'reserved', reserved_order_id = $1 where id = $2", [req.params.id, order.listing_id]);

    const siblings = await client.query(
      "select id from orders where listing_id = $1 and status = 'pending' and id <> $2",
      [order.listing_id, req.params.id]
    );
    for (const s of siblings.rows) {
      await client.query(
        "update orders set status = 'cancelled', cancelled_at = now(), cancelled_by = 'seller', cancel_reason = 'listing_reserved_elsewhere' where id = $1",
        [s.id]
      );
      await logStatus(client, s.id, "pending", "cancelled", req.user.id, "Listing reserved for a different buyer");
    }

    await client.query("COMMIT");
    res.json({ order: updated.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// Buyer cancels (only while pending) or seller declines/cancels (pending
// or accepted, e.g. out of stock). Releases the listing reservation if
// this order was the one holding it.
router.post("/:id/cancel", requireAuth, async (req, res) => {
  const order = await getOrderOr404(req, res);
  if (!order) return;

  const isBuyer = order.buyer_id === req.user.id;
  const isSeller = order.seller_id === req.user.id;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: "Not your order." });
  if (isBuyer && order.status !== "pending") return res.status(400).json({ error: "Buyers can only cancel a pending order." });
  if (isSeller && !["pending", "accepted", "preparing"].includes(order.status)) return res.status(400).json({ error: `Order is '${order.status}', can't cancel.` });

  const actor = isSeller ? "seller" : "buyer";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      "update orders set status = 'cancelled', cancelled_at = now(), cancelled_by = $1, cancel_reason = $2 where id = $3 returning *",
      [actor, req.body.reason || null, req.params.id]
    );
    await logStatus(client, req.params.id, order.status, "cancelled", req.user.id, req.body.reason || null);
    const notifyTarget = actor === "seller" ? order.buyer_id : order.seller_id;
    await notify(client, notifyTarget, "order_cancelled", "Order cancelled", order.id, order.id);

    const listing = await client.query("select * from listings where id = $1", [order.listing_id]);
    if (listing.rows.length && listing.rows[0].reserved_order_id === req.params.id) {
      await client.query("update listings set status = 'active', reserved_order_id = null where id = $1", [order.listing_id]);
    }

    await client.query("COMMIT");
    res.json({ order: updated.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// --- Fulfilment sequence -------------------------------------------------
// pickup:   accepted -> preparing -> ready_for_pickup -> collected -> completed
// delivery: accepted -> preparing -> out_for_delivery -> delivered -> completed

router.post("/:id/prepare", requireAuth, async (req, res) => {
  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: "Only the seller can update this order." });
  if (order.status !== "accepted") return res.status(400).json({ error: `Order is '${order.status}', can't move to preparing.` });

  const updated = await query("update orders set status = 'preparing' where id = $1 returning *", [req.params.id]);
  await logStatus(pool, req.params.id, "accepted", "preparing", req.user.id, null);
  await notify(pool, order.buyer_id, "order_preparing", "Seller is preparing your order", order.id, order.id);
  res.json({ order: updated.rows[0] });
});

// One "dispatch" action that resolves to the right next status depending
// on how this specific order is being fulfilled.
router.post("/:id/dispatch", requireAuth, async (req, res) => {
  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: "Only the seller can update this order." });
  if (order.status !== "preparing") return res.status(400).json({ error: `Order is '${order.status}', can't dispatch.` });

  const nextStatus = order.delivery_method === "pickup" ? "ready_for_pickup" : "out_for_delivery";
  const updated = await query("update orders set status = $1 where id = $2 returning *", [nextStatus, req.params.id]);
  await logStatus(pool, req.params.id, "preparing", nextStatus, req.user.id, null);
  await notify(
    pool, order.buyer_id,
    nextStatus === "ready_for_pickup" ? "order_dispatched" : "order_dispatched",
    nextStatus === "ready_for_pickup" ? "Ready for pickup" : "Order dispatched",
    order.id, order.id
  );
  res.json({ order: updated.rows[0] });
});

// Seller confirms the part physically left their hands — collected in
// person, or handed to delivery. Buyer still has to confirm on their end
// (see /confirm) before this becomes financially final.
router.post("/:id/fulfil", requireAuth, async (req, res) => {
  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: "Only the seller can update this order." });

  const expectedFrom = order.delivery_method === "pickup" ? "ready_for_pickup" : "out_for_delivery";
  const nextStatus = order.delivery_method === "pickup" ? "collected" : "delivered";
  if (order.status !== expectedFrom) return res.status(400).json({ error: `Order is '${order.status}', can't mark ${nextStatus}.` });

  const updated = await query("update orders set status = $1, delivered_at = now() where id = $2 returning *", [nextStatus, req.params.id]);
  await logStatus(pool, req.params.id, expectedFrom, nextStatus, req.user.id, null);
  await notify(pool, order.buyer_id, "order_delivered", nextStatus === "collected" ? "Marked as collected" : "Marked as delivered", order.id, order.id);
  res.json({ order: updated.rows[0] });
});

// Buyer confirms receipt. This is the trigger point for everything
// financial: it snapshots an immutable seller_commissions row, opens a
// settlement to collect it, marks the listing sold, and invoices the
// seller via DPAY for their commission (never the buyer).
router.post("/:id/confirm", requireAuth, async (req, res) => {
  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: "Only the buyer can confirm receipt." });
  if (!["delivered", "collected"].includes(order.status)) return res.status(400).json({ error: `Order is '${order.status}', can't confirm.` });

  const result = await completeOrder(order, req.user.id);
  res.json(result);
});

// Reserve & Pay at Shop: the seller redeems the buyer's code in person,
// at the moment of handover, instead of the buyer separately confirming
// receipt afterward — the code check itself IS the confirmation, since
// both parties are physically present for the handover and cash payment.
// Completes the order directly from 'pending', skipping the normal
// multi-stage accept/prepare/dispatch lifecycle that doesn't apply here.
router.post("/:id/redeem-code", requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: "Reservation code is required." });

  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.seller_id !== req.user.id) return res.status(403).json({ error: "Only the seller can redeem this code." });
  if (order.payment_method !== "reserve_at_shop") return res.status(400).json({ error: "This order isn't a shop reservation." });
  if (!["pending", "accepted"].includes(order.status)) return res.status(400).json({ error: `Order is '${order.status}', can't redeem.` });
  if (order.reservation_code !== code.trim().toUpperCase()) return res.status(400).json({ error: "That code doesn't match this order." });

  const result = await completeOrder(order, req.user.id);
  res.json(result);
});

router.post("/:id/dispute", requireAuth, async (req, res) => {
  const { reason, description } = req.body;
  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: "Only the buyer can report a problem." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("update orders set status = 'disputed' where id = $1", [req.params.id]);
    await logStatus(client, req.params.id, order.status, "disputed", req.user.id, reason);

    const dispute = await client.query(
      "insert into disputes (order_id, reporter_id, reason, description) values ($1,$2,$3,$4) returning *",
      [req.params.id, req.user.id, reason, description]
    );
    await client.query(
      "insert into dispute_events (dispute_id, actor_id, event_type, detail) values ($1,$2,'opened',$3)",
      [dispute.rows[0].id, req.user.id, description]
    );

    const protection = await client.query("select * from buyer_protection where order_id = $1", [req.params.id]);
    if (protection.rows.length) {
      await client.query("update buyer_protection set status = 'claimed', claim_dispute_id = $1 where order_id = $2", [dispute.rows[0].id, req.params.id]);
    }

    await notify(client, order.seller_id, "dispute_update", "A buyer reported a problem with an order", order.id, order.id);
    await client.query("COMMIT");
    res.status(201).json({ dispute: dispute.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

// Buyer submits proof of a manual bank transfer. This does not itself
// confirm anything — an admin verifies it against the real bank statement
// via POST /admin/bank-transfers/:id/verify. Only one pending confirmation
// per order (enforced by a partial unique index) so resubmitting doesn't
// create duplicates for an admin to sort through.
router.post("/:id/bank-transfer-confirmation", requireAuth, async (req, res) => {
  const { referenceText } = req.body;
  if (!referenceText?.trim()) return res.status(400).json({ error: "Reference text is required." });

  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (order.buyer_id !== req.user.id) return res.status(403).json({ error: "Only the buyer can submit this." });
  if (order.payment_method !== "bank") return res.status(400).json({ error: "This order isn't a bank-transfer payment." });

  const existing = await query("select id from bank_transfer_confirmations where order_id = $1 and status = 'pending'", [req.params.id]);
  if (existing.rows.length) return res.status(409).json({ error: "A confirmation is already pending review for this order." });

  const { rows } = await query(
    "insert into bank_transfer_confirmations (order_id, submitted_by, reference_text) values ($1,$2,$3) returning *",
    [req.params.id, req.user.id, referenceText.trim()]
  );
  res.status(201).json({ confirmation: rows[0] });
});

// Refund request — either party can request one (buyer wants money back,
// seller acknowledges they need to return it). This does not move money;
// per Model A, Ghayarak never held it. It creates the record an admin
// works through via /admin/refunds/:id/{approve,process,complete,reject}.
router.post("/:id/refund-request", requireAuth, async (req, res) => {
  const { amount, reason } = req.body;
  const order = await getOrderOr404(req, res);
  if (!order) return;
  if (![order.buyer_id, order.seller_id].includes(req.user.id)) return res.status(403).json({ error: "Not your order." });
  if (!amount || amount <= 0) return res.status(400).json({ error: "A positive refund amount is required." });
  if (!reason?.trim()) return res.status(400).json({ error: "A reason is required." });

  const { rows } = await query(
    "insert into refunds (order_id, amount, reason, requested_by) values ($1,$2,$3,$4) returning *",
    [req.params.id, amount, reason.trim(), req.user.id]
  );
  const otherParty = req.user.id === order.buyer_id ? order.seller_id : order.buyer_id;
  await notify(pool, otherParty, "dispute_update", `Refund requested on order ${order.id}`, order.id);
  res.status(201).json({ refund: rows[0] });
});

module.exports = router;
