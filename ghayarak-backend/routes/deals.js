const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { createInvoice } = require("../payments/dpay");

const router = express.Router();
const PROTECTION_PCT = 0.05;

// Buyer starts a Protected Deal on a listing.
router.post("/", requireAuth, async (req, res) => {
  const { listingId } = req.body;
  const { rows } = await query("select * from listings where id = $1 and status = 'active'", [listingId]);
  if (!rows.length) return res.status(404).json({ error: "Listing not found or no longer active." });
  const listing = rows[0];
  if (!listing.protected_deal) return res.status(400).json({ error: "This listing isn't offered as a Protected Deal." });
  if (listing.seller_id === req.user.id) return res.status(400).json({ error: "You can't buy your own listing." });

  const protectionFee = Math.round(listing.price * PROTECTION_PCT * 100) / 100;
  const total = Number(listing.price) + protectionFee;

  const deal = await query(
    `insert into deals (listing_id, buyer_id, seller_id, amount, protection_fee, escrow_status)
     values ($1,$2,$3,$4,$5,'pending') returning *`,
    [listingId, req.user.id, listing.seller_id, listing.price, protectionFee]
  );

  const invoice = await createInvoice({
    amount: total,
    description: `Ghayarak protected deal — ${listing.title}`,
    customerContact: req.user.contact,
    metadata: { type: "protected_deal", dealId: deal.rows[0].id },
  });
  await query("update deals set dpay_invoice_id = $1 where id = $2", [invoice.id, deal.rows[0].id]);
  await query(
    "insert into payments (dpay_invoice_id, kind, ref_id, amount, status) values ($1,'protected_deal',$2,$3,'pending')",
    [invoice.id, deal.rows[0].id, total]
  );

  res.status(201).json({ deal: deal.rows[0], paymentUrl: invoice.payment_url });
});

// Buyer confirms the part matched the listing — release escrow to seller.
// In production this triggers an actual payout via DPAY payout API or bank
// transfer; that call is intentionally left as a TODO since it depends on
// which payout method you set up with DPAY.
router.post("/:id/confirm-pickup", requireAuth, async (req, res) => {
  const { rows } = await query("select * from deals where id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Deal not found." });
  const deal = rows[0];
  if (deal.buyer_id !== req.user.id) return res.status(403).json({ error: "Only the buyer can confirm pickup." });
  if (deal.escrow_status !== "held") return res.status(400).json({ error: `Deal is '${deal.escrow_status}', can't release.` });

  const updated = await query(
    "update deals set escrow_status = 'released', released_at = now() where id = $1 returning *",
    [req.params.id]
  );
  // TODO: call DPAY payout / bank transfer to seller for (amount - protection_fee cut kept by platform).

  res.json({ deal: updated.rows[0] });
});

// Buyer disputes — for the prototype this is a manual admin-reviewed refund.
router.post("/:id/dispute", requireAuth, async (req, res) => {
  const { rows } = await query("select * from deals where id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Deal not found." });
  if (rows[0].buyer_id !== req.user.id) return res.status(403).json({ error: "Only the buyer can dispute." });

  // Flag for admin review rather than auto-refunding — protects against abuse.
  await query("update deals set escrow_status = 'pending' where id = $1", [req.params.id]);
  res.json({ ok: true, message: "Dispute recorded. An admin will review and refund if warranted." });
});

module.exports = router;
