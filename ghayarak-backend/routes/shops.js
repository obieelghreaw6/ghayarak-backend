const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { createInvoice } = require("../payments/dpay");

const router = express.Router();

const TIERS = {
  basic: { price: 50, listings: 20 },
  pro: { price: 150, listings: 100 },
  elite: { price: 350, listings: 999 },
};

// The logged-in user's own shop, if they have one — used throughout the
// frontend (posting a listing as a shop, Seller Center, the account
// screen) to know whether "myShop" exists at all.
// Public — every approved shop, used to show shop affiliation badges on
// listing cards throughout the app (not a full storefront browse page).
router.get("/", async (req, res) => {
  const { rows } = await query(
    `select id, name, city, description, business_type, tier, verified, whatsapp,
            address, opening_hours, delivery_available, created_at
     from shops where status = 'approved' order by created_at desc`
  );
  res.json({ shops: rows });
});

router.get("/mine", requireAuth, async (req, res) => {
  const { rows } = await query("select * from shops where owner_id = $1", [req.user.id]);
  res.json({ shop: rows[0] || null });
});

router.get("/:id", async (req, res) => {
  // Explicit column list, not select * — a shop row also carries
  // status_reason (internal moderation notes) and owner_id, neither of
  // which belongs on a public storefront page.
  const { rows } = await query(
    `select id, name, city, description, business_type, tier, verified, whatsapp,
            address, opening_hours, delivery_available, created_at
     from shops where id = $1 and status = 'approved'`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Shop not found." });
  const listings = await query(
    "select * from listings where shop_id = $1 and status = 'active' and moderation_status = 'approved' order by created_at desc",
    [req.params.id]
  );
  res.json({ shop: rows[0], listings: listings.rows });
});

router.post("/", requireAuth, rateLimit("shop_create", { max: 5, windowMinutes: 60, keyFn: (req) => req.user.id }), async (req, res) => {
  const { name, city, description, tier = "basic", businessType, whatsapp, address, openingHours, deliveryAvailable } = req.body;
  if (!name || !city || !TIERS[tier]) return res.status(400).json({ error: "Missing or invalid fields." });

  const { rows } = await query(
    `insert into shops (owner_id, name, city, description, tier, business_type, whatsapp, address, opening_hours, delivery_available, subscription_expiry)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '30 days') returning *`,
    [req.user.id, name, city, description, tier, businessType || "shop", whatsapp || null, address || null, openingHours || null, !!deliveryAvailable]
  );
  const shop = rows[0];

  // The shop itself is real and created either way — payment is
  // best-effort, same pattern as commission invoicing in orders.js.
  // There's no live DPAY account connected yet, so this call is expected
  // to fail right now; that shouldn't block someone from actually having
  // a shop while payment gets sorted out manually.
  let paymentUrl = null;
  try {
    const invoice = await createInvoice({
      amount: TIERS[tier].price,
      description: `Ghayarak ${tier} subscription — ${shop.id}`,
      customerContact: req.user.contact,
      metadata: { type: "subscription", shopId: shop.id, tier },
    });
    await query(
      "insert into payments (dpay_invoice_id, kind, ref_id, amount, status) values ($1,'subscription',$2,$3,'pending')",
      [invoice.id, shop.id, TIERS[tier].price]
    );
    paymentUrl = invoice.payment_url;
  } catch (e) {
    console.error("Subscription invoice failed — shop created, payment needs manual follow-up", e);
  }

  res.status(201).json({ shop, paymentUrl });
});

// Renew or change tier for an existing shop.
router.post("/:id/subscribe", requireAuth, async (req, res) => {
  const { tier } = req.body;
  if (!TIERS[tier]) return res.status(400).json({ error: "Invalid tier." });

  const { rows } = await query("select * from shops where id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Shop not found." });
  if (rows[0].owner_id !== req.user.id) return res.status(403).json({ error: "Not your shop." });

  const invoice = await createInvoice({
    amount: TIERS[tier].price,
    description: `Ghayarak ${tier} subscription renewal — ${req.params.id}`,
    customerContact: req.user.contact,
    metadata: { type: "subscription", shopId: req.params.id, tier },
  });
  await query(
    "insert into payments (dpay_invoice_id, kind, ref_id, amount, status) values ($1,'subscription',$2,$3,'pending')",
    [invoice.id, req.params.id, TIERS[tier].price]
  );
  res.json({ paymentUrl: invoice.payment_url });
});

module.exports = router;
