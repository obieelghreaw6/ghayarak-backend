const express = require("express");
const { query } = require("../db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");

const router = express.Router();

// There's no background job running on a schedule, so expiry is checked
// lazily — whenever requests actually get read — rather than via real
// cron infrastructure that isn't set up. A request nobody looks at won't
// flip to 'expired' until the next time someone does look at it, which
// is an acceptable approximation given the constraint, not a perfect
// real-time system.
async function expireDueBulk() {
  await query("update part_requests set status = 'expired' where status = 'open' and expires_at < now()");
}

// Public — anyone can browse open requests (this is what lets a seller
// without a matching listing still see demand and respond to it).
router.get("/", optionalAuth, async (req, res) => {
  await expireDueBulk();

  // Best-effort: notify the requester the first time we notice one of
  // their own requests has expired. Piggybacks on this same read rather
  // than a real scheduled check, since there's no cron running.
  if (req.user) {
    try {
      await query(
        `insert into notifications (user_id, type, title, body, ref_type, ref_id)
         select requester_id, 'request_expired', 'Your part request expired',
                'Nobody made an offer in 7 days — renew it if you still need this part.', 'request', id
         from part_requests
         where requester_id = $1 and status = 'expired'
           and not exists (select 1 from notifications n where n.ref_type = 'request' and n.ref_id = part_requests.id and n.type = 'request_expired')`,
        [req.user.id]
      );
    } catch (e) {
      console.error("Expiry notification insert failed (non-fatal)", e);
    }
  }

  const { status, city } = req.query;
  const conditions = ["1 = 1"];
  const params = [];
  // No status filter by default — the frontend's "open requests" and "my
  // requests" tabs both filter client-side from the same fetched set, and
  // "my requests" needs to see the requester's own matched/closed ones
  // too, not just open ones.
  if (status) { params.push(status); conditions.push(`pr.status = $${params.length}`); }
  if (city) { params.push(city); conditions.push(`pr.city = $${params.length}`); }
  const { rows } = await query(
    `select pr.*, u.name as requester_name, u.contact as requester_contact,
            (select count(*) from part_offers po where po.request_id = pr.id) as offer_count
     from part_requests pr join users u on u.id = pr.requester_id
     where ${conditions.join(" and ")} order by pr.created_at desc`,
    params
  );
  res.json({ requests: rows });
});

router.get("/:id", optionalAuth, async (req, res) => {
  await query(
    "update part_requests set status = 'expired' where id = $1 and status = 'open' and expires_at < now()",
    [req.params.id]
  );
  const { rows } = await query(
    `select pr.*, u.name as requester_name, u.contact as requester_contact
     from part_requests pr join users u on u.id = pr.requester_id where pr.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Request not found." });
  const offers = await query(
    `select po.*, u.name as seller_name, u.contact as seller_contact, s.name as shop_name
     from part_offers po join users u on u.id = po.seller_id left join shops s on s.id = po.shop_id
     where po.request_id = $1 order by po.created_at asc`,
    [req.params.id]
  );
  res.json({ request: rows[0], offers: offers.rows });
});

router.post(
  "/",
  requireAuth,
  rateLimit("request_create", { max: 10, windowMinutes: 60, keyFn: (req) => req.user.id }),
  async (req, res) => {
    const { make, model, year, partDescription, conditionPreference, city, urgency } = req.body;
    if (!make || !model || !partDescription || !city) {
      return res.status(400).json({ error: "Make, model, part description, and city are required." });
    }
    const { rows } = await query(
      `insert into part_requests (requester_id, make, model, year, part_description, condition_preference, city, urgency)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [req.user.id, make, model, year || null, partDescription, conditionPreference || null, city, urgency || "flexible"]
    );
    res.status(201).json({ request: rows[0] });
  }
);

// A seller offers to fulfil an open request. Not gated to shops only —
// an individual seller can respond too, same as they can post listings.
router.post(
  "/:id/offers",
  requireAuth,
  rateLimit("offer_create", { max: 30, windowMinutes: 60, keyFn: (req) => req.user.id }),
  async (req, res) => {
    const { price, condition, notes, deliveryAvailable, shopId } = req.body;
    if (!price || price <= 0 || !condition) {
      return res.status(400).json({ error: "A positive price and condition are required." });
    }
    const request = await query("select * from part_requests where id = $1", [req.params.id]);
    if (!request.rows.length) return res.status(404).json({ error: "Request not found." });
    if (request.rows[0].status !== "open") return res.status(400).json({ error: "This request is no longer open." });
    if (request.rows[0].requester_id === req.user.id) return res.status(400).json({ error: "You can't offer on your own request." });

    const { rows } = await query(
      `insert into part_offers (request_id, seller_id, shop_id, price, condition, notes, delivery_available)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [req.params.id, req.user.id, shopId || null, price, condition, notes || null, !!deliveryAvailable]
    );

    await query(
      "insert into notifications (user_id, type, title, body, ref_type, ref_id) values ($1,'new_offer','New offer on your request',$2,'request',$3)",
      [request.rows[0].requester_id, `An offer of ${price} was made on your ${request.rows[0].make} ${request.rows[0].model} request`, req.params.id]
    );

    res.status(201).json({ offer: rows[0] });
  }
);

// Requester accepts an offer — closes the request. Doesn't create an
// order automatically; the requester still goes through the normal buy
// flow against the seller directly (a request/offer is a match-making
// tool, not a transaction itself).
router.post("/:id/accept-offer", requireAuth, async (req, res) => {
  const { offerId } = req.body;
  const request = await query("select * from part_requests where id = $1", [req.params.id]);
  if (!request.rows.length) return res.status(404).json({ error: "Request not found." });
  if (request.rows[0].requester_id !== req.user.id) return res.status(403).json({ error: "Only the requester can accept an offer." });

  const offer = await query("select * from part_offers where id = $1 and request_id = $2", [offerId, req.params.id]);
  if (!offer.rows.length) return res.status(404).json({ error: "Offer not found." });

  const { rows } = await query(
    "update part_requests set status = 'matched', accepted_offer_id = $1 where id = $2 returning *",
    [offerId, req.params.id]
  );
  res.json({ request: rows[0] });
});

// Requester withdraws a request they no longer need — e.g. they found
// the part elsewhere. Only makes sense while it's still open or expired;
// once matched or already cancelled, cancelling again doesn't mean
// anything.
router.post("/:id/cancel", requireAuth, async (req, res) => {
  const request = await query("select * from part_requests where id = $1", [req.params.id]);
  if (!request.rows.length) return res.status(404).json({ error: "Request not found." });
  if (request.rows[0].requester_id !== req.user.id) return res.status(403).json({ error: "Only the requester can cancel this." });
  if (!["open", "expired"].includes(request.rows[0].status)) {
    return res.status(400).json({ error: `Request is '${request.rows[0].status}', can't cancel.` });
  }
  const { rows } = await query("update part_requests set status = 'cancelled' where id = $1 returning *", [req.params.id]);
  res.json({ request: rows[0] });
});

// Requester renews an expired (or about-to-expire) request for another 7
// days — pushes it back to 'open' so sellers see it again.
router.post("/:id/renew", requireAuth, async (req, res) => {
  const request = await query("select * from part_requests where id = $1", [req.params.id]);
  if (!request.rows.length) return res.status(404).json({ error: "Request not found." });
  if (request.rows[0].requester_id !== req.user.id) return res.status(403).json({ error: "Only the requester can renew this." });
  if (!["open", "expired"].includes(request.rows[0].status)) {
    return res.status(400).json({ error: `Request is '${request.rows[0].status}', can't renew.` });
  }
  const { rows } = await query(
    "update part_requests set status = 'open', expires_at = now() + interval '7 days' where id = $1 returning *",
    [req.params.id]
  );
  res.json({ request: rows[0] });
});

module.exports = router;
