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
  const { name, city, description, tier = "basic" } = req.body;
  if (!name || !city || !TIERS[tier]) return res.status(400).json({ error: "Missing or invalid fields." });

  const { rows } = await query(
    `insert into shops (owner_id, name, city, description, tier, subscription_expiry)
     values ($1,$2,$3,$4,$5, now() + interval '30 days') returning *`,
    [req.user.id, name, city, description, tier]
  );
  const shop = rows[0];

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

  res.status(201).json({ shop, paymentUrl: invoice.payment_url });
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
