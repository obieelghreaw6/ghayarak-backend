const express = require("express");
const { query } = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { createInvoice } = require("../payments/dpay");

const router = express.Router();
const BOOST_FEE = 15;
const BOOST_DAYS = 7;

// GET /listings/mine — every listing the current user owns, regardless
// of moderation status. Must come before the /:id route below (Express
// matches routes in order — "mine" would otherwise be parsed as an id).
router.get("/mine", requireAuth, async (req, res) => {
  const { rows } = await query(
    "select * from listings where seller_id = $1 order by created_at desc",
    [req.user.id]
  );
  res.json({ listings: rows });
});

// GET /listings?category=&city=&q=&page=
router.get("/", async (req, res) => {
  const { category, city, q, page = 1 } = req.query;
  const limit = 24;
  const offset = (Number(page) - 1) * limit;

  // moderation_status = 'approved' is not optional here — without it, a
  // listing sitting in the admin queue (or one an admin rejected) would
  // still show up in public search, which defeats the whole point of
  // having a moderation queue in the first place.
  //
  // The seller/shop status join closes the gap flagged in the last
  // security pass: suspending or banning a seller previously had no
  // effect on whether their listings kept showing up in search. A
  // suspension that doesn't hide anything isn't actually enforcement.
  const conditions = [
    "l.status = 'active'",
    "l.moderation_status = 'approved'",
    "u.status = 'approved'",
    "(l.shop_id is null or s.status = 'approved')",
  ];
  const params = [];
  if (category) { params.push(category); conditions.push(`l.category = $${params.length}`); }
  if (city) { params.push(city); conditions.push(`l.city = $${params.length}`); }
  if (q) { params.push(`%${q.toLowerCase()}%`); conditions.push(`(lower(l.title) like $${params.length} or lower(l.make) like $${params.length} or lower(l.model) like $${params.length})`); }

  params.push(limit, offset);
  const { rows } = await query(
    `select l.* from listings l
     join users u on u.id = l.seller_id
     left join shops s on s.id = l.shop_id
     where ${conditions.join(" and ")}
     order by (l.featured and l.featured_until > now()) desc, l.created_at desc
     limit $${params.length - 1} offset $${params.length}`,
    params
  );

  // Log the search for the unfulfilled-demand report — every query, hit or
  // miss, since knowing what people search for even when it DOES return
  // results still tells you what's popular, not just what's missing.
  if (q) {
    try {
      await query(
        "insert into search_queries (query, city_filter, result_count, searcher_id) values ($1,$2,$3,$4)",
        [q, city || null, rows.length, req.user?.id || null]
      );
    } catch (e) {
      console.error("Search log insert failed (non-fatal)", e);
    }
  }

  res.json({ listings: rows });
});

router.get("/:id", optionalAuth, async (req, res) => {
  await query("update listings set views = views + 1 where id = $1", [req.params.id]);
  const { rows } = await query(
    `select l.*, u.status as seller_status, s.status as shop_status
     from listings l join users u on u.id = l.seller_id left join shops s on s.id = l.shop_id
     where l.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Listing not found." });
  const { seller_status, shop_status, ...listing } = rows[0];

  const staffRoles = ["moderator", "admin", "owner"];
  const isOwnerOrStaff = req.user && (req.user.id === listing.seller_id || staffRoles.includes(req.user.role));
  const sellerSuspended = seller_status !== "approved" || (listing.shop_id && shop_status !== "approved");
  if ((listing.moderation_status !== "approved" || sellerSuspended) && !isOwnerOrStaff) {
    // Behaves as if it doesn't exist to anyone who isn't the seller or
    // staff — a pending/rejected listing, or one from a suspended seller,
    // shouldn't be reachable by URL just because someone has the id.
    return res.status(404).json({ error: "Listing not found." });
  }

  // moderation_note is internal admin commentary — never returned to the
  // seller or public, only visible via the admin moderation queue.
  const { moderation_note, ...safeListing } = listing;
  res.json({ listing: isOwnerOrStaff ? listing : safeListing });
});

router.post(
  "/",
  requireAuth,
  rateLimit("listing_create", { max: 20, windowMinutes: 60, keyFn: (req) => req.user.id }),
  async (req, res) => {
    const {
      title, category, make, model, yearFrom, yearTo, price, condition,
      city, description, protectedDeal, shopId,
    } = req.body;
    if (!title || !category || !make || !model || !price || !condition || !city) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const { rows } = await query(
      `insert into listings
        (seller_id, shop_id, title, category, make, model, year_from, year_to, price, condition, city, description, protected_deal)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [req.user.id, shopId || null, title, category, make, model, yearFrom, yearTo, price, condition, city, description, !!protectedDeal]
    );
    res.status(201).json({ listing: rows[0] });
  }
);

// Seller marks their own listing sold or removes it.
router.patch("/:id", requireAuth, async (req, res) => {
  const { status } = req.body; // 'active' | 'sold' | 'removed' — draft isn't a real status in the schema yet
  if (!["active", "sold", "removed"].includes(status)) return res.status(400).json({ error: "Invalid status." });

  const { rows } = await query("select * from listings where id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Listing not found." });
  const staffRoles = ["moderator", "admin", "owner"];
  if (rows[0].seller_id !== req.user.id && !staffRoles.includes(req.user.role)) {
    return res.status(403).json({ error: "Not your listing." });
  }
  const updated = await query("update listings set status = $1 where id = $2 returning *", [status, req.params.id]);
  res.json({ listing: updated.rows[0] });
});

// Start a boost payment — returns a DPAY hosted checkout URL.
router.post("/:id/boost", requireAuth, async (req, res) => {
  const { rows } = await query("select * from listings where id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Listing not found." });
  // This was missing entirely before: without it, any authenticated user
  // could pay to boost someone else's listing just by knowing its id —
  // exactly the "does the request contain an ID" failure mode this whole
  // security pass exists to close.
  if (rows[0].seller_id !== req.user.id) return res.status(403).json({ error: "Not your listing." });

  const invoice = await createInvoice({
    amount: BOOST_FEE,
    description: `Ghayarak boost — ${req.params.id}`,
    customerContact: req.user.contact,
    metadata: { type: "boost", listingId: req.params.id, days: BOOST_DAYS },
  });
  await query(
    "insert into payments (dpay_invoice_id, kind, ref_id, amount, status) values ($1,'boost',$2,$3,'pending')",
    [invoice.id, req.params.id, BOOST_FEE]
  );
  res.json({ paymentUrl: invoice.payment_url });
});

// Anyone signed in can report a listing — doesn't require having ordered
// it, since counterfeit/stolen concerns often come from people who
// recognize a part before ever buying it.
router.post(
  "/:id/report",
  requireAuth,
  rateLimit("listing_report", { max: 10, windowMinutes: 60, keyFn: (req) => req.user.id }),
  async (req, res) => {
    const { reason, description } = req.body;
    if (!["counterfeit", "stolen", "misrepresented", "unsafe", "other"].includes(reason)) {
      return res.status(400).json({ error: "Invalid reason." });
    }
    const listing = await query("select id from listings where id = $1", [req.params.id]);
    if (!listing.rows.length) return res.status(404).json({ error: "Listing not found." });

    const { rows } = await query(
      "insert into listing_reports (listing_id, reporter_id, reason, description) values ($1,$2,$3,$4) returning *",
      [req.params.id, req.user.id, reason, description || null]
    );
    res.status(201).json({ report: rows[0] });
  }
);

module.exports = router;
