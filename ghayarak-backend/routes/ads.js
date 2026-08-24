const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Public — the home screen (and eventually search results) calls this to
// display whatever's currently paid-for and live. No auth needed to view
// ads, same as browsing listings.
router.get("/active", async (req, res) => {
  const { placement } = req.query;
  const conditions = ["status = 'active'", "starts_at <= now()", "ends_at >= now()"];
  const params = [];
  if (placement) { params.push(placement); conditions.push(`placement = $${params.length}`); }
  const { rows } = await query(
    `select id, headline, subtext, link_url, placement, ends_at from ad_banners where ${conditions.join(" and ")} order by created_at desc`,
    params
  );
  res.json({ ads: rows });
});

// Everything below here is staff-only — creating an ad banner is
// recording that a real advertiser genuinely paid, which is exactly the
// kind of action that needs the same care as marking a settlement paid.
router.use(requireAuth, requireRole("finance", "admin", "owner"));

router.get("/", async (req, res) => {
  const { rows } = await query("select * from ad_banners order by created_at desc");
  res.json({ ads: rows });
});

router.post("/", async (req, res) => {
  const { advertiserName, advertiserContact, headline, subtext, linkUrl, placement, amountPaid, startsAt, endsAt } = req.body;
  if (!advertiserName || !headline || !startsAt || !endsAt) {
    return res.status(400).json({ error: "Advertiser name, headline, start date, and end date are required." });
  }
  const { rows } = await query(
    `insert into ad_banners
      (advertiser_name, advertiser_contact, headline, subtext, link_url, placement, amount_paid, starts_at, ends_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [advertiserName, advertiserContact || null, headline, subtext || null, linkUrl || null,
     placement || "home_banner", amountPaid || null, startsAt, endsAt, req.user.id]
  );
  res.status(201).json({ ad: rows[0] });
});

router.post("/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!["active", "expired", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  const { rows } = await query("update ad_banners set status = $1 where id = $2 returning *", [status, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Ad not found." });
  res.json({ ad: rows[0] });
});

module.exports = router;
