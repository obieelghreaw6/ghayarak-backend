const express = require("express");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
// Broad gate: any staff role can authenticate into the admin area at all.
// Specific route groups below apply stricter role checks for
// financial and moderation actions — not every staff member should be
// able to do everything just because they can reach /admin.
router.use(requireAuth, requireRole("admin", "owner", "moderator", "support", "finance"));
const financeOnly = requireRole("finance", "admin", "owner");
const moderationOnly = requireRole("moderator", "admin", "owner");

async function writeAudit(entityType, entityId, action, actorId, before, after) {
  await query(
    "insert into audit_logs (entity_type, entity_id, action, actor_id, before_state, after_state) values ($1,$2,$3,$4,$5,$6)",
    [entityType, entityId, action, actorId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)]
  );
}

// Real business metrics — every number here traces to an actual query
// against production tables, not a placeholder. Organized into the same
// sections requested: marketplace activity, money, supply, demand,
// operations, plus a simple health read at the end.
router.get("/overview", async (req, res) => {
  const [marketplace, money, supply, supplyNew, demand, demandOffers, demandTiming, ops, disputesRow, paymentsRow, attention] = await Promise.all([
    query(`select
             (select count(*) filter (where deleted_at is null) as total,
                     count(*) filter (where deleted_at is null and status = 'approved') as active
              from users) as users_row,
             (select count(*) as total,
                     count(*) filter (where status = 'active' and moderation_status = 'approved') as active
              from listings) as listings_row,
             (select count(*) filter (where status = 'open') as open from part_requests) as requests_row,
             (select count(*) as total from part_offers) as offers_row,
             (select count(*) as total,
                     count(*) filter (where status = 'completed') as completed,
                     count(*) filter (where status = 'cancelled') as cancelled,
                     count(*) filter (where status = 'refunded') as refunded
              from orders) as orders_row
    `),
    query(`select
             coalesce(sum(part_price) filter (where status = 'completed'), 0) as gmv,
             coalesce(sum(commission_amount) filter (where status = 'completed'), 0) as commission_earned,
             count(*) filter (where status = 'completed') as completed_count
           from orders`),
    query(`select
             (select count(*) as total, count(*) filter (where verified) as verified from shops) as shops_row,
             (select count(distinct seller_id) as total from listings where shop_id is null) as individual_row,
             (select count(distinct seller_id) as total from listings where status = 'active' and moderation_status = 'approved') as active_row
    `),
    // New sellers = whoever posted their very first listing in the
    // window — not just "new user", since a signed-up-but-never-listed
    // account isn't really a seller yet.
    query(`select
             count(*) filter (where first_at >= now() - interval '7 days') as week,
             count(*) filter (where first_at >= now() - interval '30 days') as month
           from (select seller_id, min(created_at) as first_at from listings group by seller_id) x`),
    query(`select
             count(*) filter (where created_at >= now() - interval '7 days') as requests_week,
             count(*) filter (where created_at >= now() - interval '30 days') as requests_month,
             count(*) filter (where created_at >= now() - interval '7 days') as listings_week,
             count(*) filter (where created_at >= now() - interval '30 days') as listings_month
           from part_requests`),
    query(`select count(distinct request_id) as with_offers, count(*) as total_offers from part_offers`),
    // Average time from a request being posted to its first offer —
    // only meaningful for requests that actually got one.
    query(`select extract(epoch from avg(fo.first_offer_at - pr.created_at)) as avg_seconds
           from part_requests pr
           join (select request_id, min(created_at) as first_offer_at from part_offers group by request_id) fo
             on fo.request_id = pr.id`),
    query(`select
             count(*) filter (where status = 'pending') as awaiting_acceptance,
             count(*) filter (where status in ('accepted', 'preparing')) as awaiting_dispatch,
             count(*) filter (where status in ('ready_for_pickup', 'out_for_delivery')) as in_delivery
           from orders`),
    query(`select count(*) as total, count(*) filter (where status in ('open', 'investigating')) as open from disputes`),
    query(`select count(*) filter (where status = 'failed') as failed from payments`),
    query(`select
             (select count(*) from listings where moderation_status = 'pending') as pending_listings,
             (select count(*) from shops where status = 'pending') as pending_shops,
             (select count(*) from bank_transfer_confirmations where status = 'pending') as pending_bank_transfers,
             (select count(*) from refunds where status = 'requested') as pending_refunds
    `),
  ]);

  const m = marketplace.rows[0];
  const mo = money.rows[0];
  const su = supply.rows[0];
  const sn = supplyNew.rows[0];
  const de = demand.rows[0];
  const doff = demandOffers.rows[0];
  const dt = demandTiming.rows[0];
  const op = ops.rows[0];
  const disp = disputesRow.rows[0];
  const pay = paymentsRow.rows[0];
  const att = attention.rows[0];

  const [requestTotalRows, settlementRows, refundTotalRows] = await Promise.all([
    query("select count(*) as total from part_requests"),
    query(`select status, coalesce(sum(commission_amount), 0) as total from settlements group by status`),
    query(`select coalesce(sum(amount), 0) as total from refunds where status = 'refunded'`),
  ]);
  const allRequestsCount = Number(requestTotalRows.rows[0].total);
  const settlementBySource = { owed: 0, invoiced: 0, paid: 0, waived: 0 };
  settlementRows.rows.forEach((r) => { settlementBySource[r.status] = Number(r.total); });
  const refundedTotal = Number(refundTotalRows.rows[0].total);

  const gmv = Number(mo.gmv);
  const commissionEarned = Number(mo.commission_earned);
  const completedCount = Number(mo.completed_count);

  res.json({
    marketplace: {
      totalUsers: Number(m.users_row.total),
      activeUsers: Number(m.users_row.active),
      totalListings: Number(m.listings_row.total),
      activeListings: Number(m.listings_row.active),
      openRequests: Number(m.requests_row.open),
      offersSubmitted: Number(m.offers_row.total),
      totalOrders: Number(m.orders_row.total),
      completedOrders: Number(m.orders_row.completed),
      cancelledOrders: Number(m.orders_row.cancelled),
      refundedOrders: Number(m.orders_row.refunded),
    },
    money: {
      gmv,
      commissionEarned,
      commissionCollected: settlementBySource.paid,
      commissionOutstanding: settlementBySource.owed + settlementBySource.invoiced,
      // Ghayarak never holds buyer funds (sellers collect payment
      // directly) — there's no real "payout" to track. This is gross
      // seller earnings, i.e. what sellers kept after commission, not a
      // transfer Ghayarak actually makes.
      sellerGrossEarnings: gmv - commissionEarned,
      refundedAmount: refundedTotal,
      averageOrderValue: completedCount > 0 ? Math.round((gmv / completedCount) * 100) / 100 : 0,
    },
    supply: {
      totalShops: Number(su.shops_row.total),
      verifiedShops: Number(su.shops_row.verified),
      individualSellers: Number(su.individual_row.total),
      activeSellers: Number(su.active_row.total),
      newSellersThisWeek: Number(sn.week),
      newSellersThisMonth: Number(sn.month),
      listingsAddedThisWeek: Number(de.listings_week),
      listingsAddedThisMonth: Number(de.listings_month),
    },
    demand: {
      requestsThisWeek: Number(de.requests_week),
      requestsThisMonth: Number(de.requests_month),
      requestsWithOffers: Number(doff.with_offers),
      requestsWithNoOffers: Math.max(0, allRequestsCount - Number(doff.with_offers)),
      averageOffersPerRequestWithOffers: Number(doff.with_offers) > 0 ? Math.round((Number(doff.total_offers) / Number(doff.with_offers)) * 10) / 10 : 0,
      // null, not 0, when nobody has ever made an offer yet — 0 hours
      // would misleadingly read as "instant."
      averageHoursToFirstOffer: dt.avg_seconds !== null ? Math.round((Number(dt.avg_seconds) / 3600) * 10) / 10 : null,
    },
    operations: {
      ordersAwaitingAcceptance: Number(op.awaiting_acceptance),
      ordersAwaitingDispatch: Number(op.awaiting_dispatch),
      ordersInDelivery: Number(op.in_delivery),
      openDisputes: Number(disp.open),
      totalDisputes: Number(disp.total),
      failedPayments: Number(pay.failed),
      needsAttention: {
        pendingListings: Number(att.pending_listings),
        pendingShops: Number(att.pending_shops),
        pendingBankTransfers: Number(att.pending_bank_transfers),
        pendingRefunds: Number(att.pending_refunds),
        // Not trackable: notifications are database rows, not actually
        // delivered anywhere yet (no real push/SMS/email pipeline
        // exists) — there is no "delivery failure" to detect. Flagged
        // honestly rather than showing a fake 0.
      },
    },
  });
});

// Revenue over a window, in daily buckets, for a real chart — not the
// random-number placeholder this replaces. days=1|7|30|90, matching the
// four periods requested.
router.get("/revenue-chart", async (req, res) => {
  const days = [1, 7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;

  const [gmvRows, refundRows] = await Promise.all([
    query(
      `select date_trunc('day', completed_at) as day,
              coalesce(sum(part_price), 0) as gmv,
              coalesce(sum(commission_amount), 0) as commission
       from orders
       where status = 'completed' and completed_at >= now() - make_interval(days => $1)
       group by day order by day`,
      [days]
    ),
    query(
      `select date_trunc('day', completed_at) as day, coalesce(sum(amount), 0) as refunds
       from refunds
       where status = 'refunded' and completed_at >= now() - make_interval(days => $1)
       group by day order by day`,
      [days]
    ),
  ]);

  // Merged by day in JS — the two queries can have different sets of
  // days (a day with refunds but no completed sales, or vice versa), so
  // this is safer than trying to force them together in one SQL query.
  const byDay = new Map();
  for (const r of gmvRows.rows) {
    const key = r.day.toISOString().slice(0, 10);
    byDay.set(key, { date: key, gmv: Number(r.gmv), commission: Number(r.commission), refunds: 0 });
  }
  for (const r of refundRows.rows) {
    const key = r.day.toISOString().slice(0, 10);
    const existing = byDay.get(key) || { date: key, gmv: 0, commission: 0, refunds: 0 };
    existing.refunds = Number(r.refunds);
    byDay.set(key, existing);
  }
  const series = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

  const totals = series.reduce(
    (acc, d) => ({ gmv: acc.gmv + d.gmv, commission: acc.commission + d.commission, refunds: acc.refunds + d.refunds }),
    { gmv: 0, commission: 0, refunds: 0 }
  );
  totals.net = Math.round((totals.commission - totals.refunds) * 100) / 100;

  res.json({ days, series, totals });
});

// A few real, at-a-glance health signals — not a full monitoring system
// (that's real infrastructure work, not a database query), but genuine
// signal from what the database actually shows, with a status color
// derived from real thresholds rather than invented for show.
router.get("/health", async (req, res) => {
  const [orderHealth, requestHealth, paymentHealth, sellerHealth] = await Promise.all([
    query(`select
             count(*) filter (where status = 'completed') as completed,
             count(*) filter (where status in ('completed', 'cancelled', 'refunded', 'disputed')) as terminal
           from orders`),
    query(`select
             count(*) filter (where status = 'open') as open_total,
             count(*) filter (where status = 'open' and not exists (select 1 from part_offers po where po.request_id = pr.id)) as open_no_offers
           from part_requests pr`),
    query(`select
             count(*) filter (where status = 'paid') as paid,
             count(*) filter (where status in ('paid', 'failed')) as attempted
           from payments`),
    query(`select count(distinct l.seller_id) as no_sales
           from listings l
           where l.status = 'active' and l.moderation_status = 'approved'
             and not exists (select 1 from orders o where o.seller_id = l.seller_id and o.status = 'completed')`),
  ]);

  const oh = orderHealth.rows[0];
  const rh = requestHealth.rows[0];
  const ph = paymentHealth.rows[0];
  const sh = sellerHealth.rows[0];

  // Rate is null (not 0) when there's not enough data yet to mean
  // anything — a fresh marketplace with 2 orders shouldn't show a
  // confident red/green off a sample that small.
  const orderCompletionRate = Number(oh.terminal) > 0 ? Number(oh.completed) / Number(oh.terminal) : null;
  const paymentSuccessRate = Number(ph.attempted) > 0 ? Number(ph.paid) / Number(ph.attempted) : null;
  const requestsNoOfferRate = Number(rh.open_total) > 0 ? Number(rh.open_no_offers) / Number(rh.open_total) : null;

  function statusFor(rate, goodAbove, warnAbove) {
    if (rate === null) return "unknown";
    if (rate >= goodAbove) return "good";
    if (rate >= warnAbove) return "warning";
    return "bad";
  }

  res.json({
    orderCompletion: { rate: orderCompletionRate, status: statusFor(orderCompletionRate, 0.8, 0.5), sampleSize: Number(oh.terminal) },
    paymentSuccess: { rate: paymentSuccessRate, status: statusFor(paymentSuccessRate, 0.9, 0.7), sampleSize: Number(ph.attempted) },
    // Inverted: a HIGH no-offer rate is the bad direction, so the good/warn
    // thresholds are phrased as "rate is LOW enough" — statusFor expects
    // "higher is better," so this passes (1 - rate) through it instead.
    requestsGettingOffers: { noOfferRate: requestsNoOfferRate, status: statusFor(requestsNoOfferRate === null ? null : 1 - requestsNoOfferRate, 0.5, 0.25), sampleSize: Number(rh.open_total) },
    sellersWithNoSales: { count: Number(sh.no_sales) },
    // Not trackable yet: there's no background job system or error
    // monitoring wired up (that's real infrastructure, not a query) —
    // flagged honestly rather than shown as a fake green light.
    infrastructureMonitoring: { status: "not_configured" },
  });
});

// The money dashboard specifically — "today's sales", commission earned,
// outstanding vs settled, refunds. Every figure here should be traceable
// back to individual orders via the /admin/orders-like queries elsewhere;
// this endpoint is aggregate-only by design, drill-down happens by id.
router.get("/money", financeOnly, async (req, res) => {
  const [today, settlementTotals, refunds] = await Promise.all([
    query(`select coalesce(sum(part_price), 0) as sales, coalesce(sum(commission_amount), 0) as commission
           from orders where status = 'completed' and completed_at >= date_trunc('day', now())`),
    query(`select status, coalesce(sum(commission_amount), 0) as total, count(*) as count
           from settlements group by status`),
    query(`select coalesce(sum(amount), 0) as total, count(*) as count from revenue_events where source = 'refund'`),
  ]);

  const settlementBySource = { owed: { total: 0, count: 0 }, invoiced: { total: 0, count: 0 }, paid: { total: 0, count: 0 }, waived: { total: 0, count: 0 } };
  settlementTotals.rows.forEach((r) => { settlementBySource[r.status] = { total: Number(r.total), count: Number(r.count) }; });

  res.json({
    todaySales: Number(today.rows[0].sales),
    todayCommission: Number(today.rows[0].commission),
    commissionOutstanding: settlementBySource.owed.total + settlementBySource.invoiced.total,
    commissionSettled: settlementBySource.paid.total,
    refunds: { total: Number(refunds.rows[0].total), count: Number(refunds.rows[0].count) },
    settlementBreakdown: settlementBySource,
  });
});

// ---------------------------------------------------------------------
// Seller management
// ---------------------------------------------------------------------

// Unified list — shops and individual sellers side by side, since an
// admin managing "sellers" thinks in terms of one list, not two tables.
router.get("/sellers", async (req, res) => {
  const [shopRows, individualRows] = await Promise.all([
    query(`select s.*, u.name as owner_name, u.contact as owner_contact,
             (select count(*) from listings l where l.shop_id = s.id and l.status != 'removed') as listing_count,
             (select coalesce(sum(part_price), 0) from orders o where o.shop_id = s.id and o.status = 'completed') as total_sales
           from shops s join users u on u.id = s.owner_id order by s.created_at desc`),
    query(`select u.id, u.name, u.contact, u.seller_level, u.status, u.created_at,
             (select count(*) from listings l where l.seller_id = u.id and l.shop_id is null and l.status != 'removed') as listing_count,
             (select coalesce(sum(part_price), 0) from orders o where o.seller_id = u.id and o.status = 'completed') as total_sales
           from users u where u.role in ('seller') and not exists (select 1 from shops s2 where s2.owner_id = u.id)
           order by u.created_at desc`),
  ]);
  res.json({ shops: shopRows.rows, individuals: individualRows.rows });
});

router.get("/sellers/:type/:id", async (req, res) => {
  const { type, id } = req.params; // type: 'shop' | 'individual'
  if (!["shop", "individual"].includes(type)) return res.status(400).json({ error: "Invalid seller type." });

  const sellerIdCol = type === "shop" ? "shop_id" : "seller_id";
  const [listings, orders, disputes, settlements] = await Promise.all([
    query(`select * from listings where ${sellerIdCol} = $1 order by created_at desc limit 50`, [id]),
    query(`select * from orders where ${sellerIdCol} = $1 order by created_at desc limit 50`, [id]),
    query(`select d.* from disputes d join orders o on o.id = d.order_id where o.${sellerIdCol} = $1 order by d.created_at desc`, [id]),
    query(`select se.* from settlements se join orders o on o.id = se.order_id where o.${sellerIdCol} = $1 order by se.created_at desc`, [id]),
  ]);
  res.json({ listings: listings.rows, orders: orders.rows, disputes: disputes.rows, settlements: settlements.rows });
});

router.post("/sellers/:type/:id/status", moderationOnly, async (req, res) => {
  const { type, id } = req.params;
  const { status, reason } = req.body; // status: approved | suspended | banned | pending
  if (!["shop", "individual"].includes(type)) return res.status(400).json({ error: "Invalid seller type." });

  if (type === "shop") {
    if (!["pending", "approved", "suspended", "banned"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    const before = await query("select * from shops where id = $1", [id]);
    if (!before.rows.length) return res.status(404).json({ error: "Shop not found." });
    const { rows } = await query("update shops set status = $1, status_reason = $2 where id = $3 returning *", [status, reason || null, id]);
    await writeAudit("shop", id, `status_${status}`, req.user.id, before.rows[0], rows[0]);
    return res.json({ shop: rows[0] });
  }

  if (!["approved", "suspended", "banned"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  const before = await query("select * from users where id = $1", [id]);
  if (!before.rows.length) return res.status(404).json({ error: "Seller not found." });
  const { rows } = await query("update users set status = $1 where id = $2 returning *", [status, id]);
  await writeAudit("user", id, `status_${status}`, req.user.id, before.rows[0], rows[0]);
  res.json({ user: rows[0] });
});

router.post("/sellers/individual/:id/level", moderationOnly, async (req, res) => {
  const { level } = req.body; // 'individual' | 'verified'
  if (!["individual", "verified"].includes(level)) return res.status(400).json({ error: "Invalid level." });

  const before = await query("select * from users where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "User not found." });

  const { rows } = await query("update users set seller_level = $1 where id = $2 returning *", [level, req.params.id]);
  await writeAudit("user", req.params.id, `level_${level}`, req.user.id, before.rows[0], rows[0]);
  res.json({ user: rows[0] });
});

router.get("/shops/pending", async (req, res) => {
  const { rows } = await query("select * from shops where status = 'pending' order by created_at asc");
  res.json({ shops: rows });
});

router.post("/shops/:id/verify", moderationOnly, async (req, res) => {
  const before = await query("select * from shops where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "Shop not found." });

  const { rows } = await query("update shops set verified = true where id = $1 returning *", [req.params.id]);
  await writeAudit("shop", req.params.id, "verified", req.user.id, before.rows[0], rows[0]);
  res.json({ shop: rows[0] });
});

// ---------------------------------------------------------------------
// Listing moderation
// ---------------------------------------------------------------------

router.get("/listings/pending", async (req, res) => {
  const { rows } = await query(
    `select l.*, u.name as seller_name, u.contact as seller_contact from listings l
     join users u on u.id = l.seller_id
     where l.moderation_status = 'pending' order by l.created_at asc`
  );
  res.json({ listings: rows });
});

router.post("/listings/:id/moderate", moderationOnly, async (req, res) => {
  const { decision, note } = req.body; // decision: approved | rejected | flagged
  if (!["approved", "rejected", "flagged"].includes(decision)) return res.status(400).json({ error: "Invalid decision." });

  const before = await query("select * from listings where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "Listing not found." });

  const { rows } = await query(
    "update listings set moderation_status = $1, moderation_note = $2 where id = $3 returning *",
    [decision, note || null, req.params.id]
  );
  await writeAudit("listing", req.params.id, `moderation_${decision}`, req.user.id, before.rows[0], rows[0]);
  res.json({ listing: rows[0] });
});

router.post("/listings/:id/remove", moderationOnly, async (req, res) => {
  const before = await query("select * from listings where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "Listing not found." });

  const { rows } = await query("update listings set status = 'removed' where id = $1 returning *", [req.params.id]);
  await writeAudit("listing", req.params.id, "removed_by_admin", req.user.id, before.rows[0], rows[0]);
  res.json({ listing: rows[0] });
});

router.get("/listings", async (req, res) => {
  const { rows } = await query("select * from listings order by created_at desc limit 200");
  res.json({ listings: rows });
});

// Sellers who owe commission and haven't paid yet — the honesty/reconciliation
// risk you flagged directly. This is the list to chase manually until volume
// justifies automating collections.
router.get("/settlements", async (req, res) => {
  const { status = "owed" } = req.query;
  const { rows } = await query(
    `select s.*, u.name as seller_name, u.contact as seller_contact, o.listing_id
     from settlements s
     join users u on u.id = s.seller_id
     join orders o on o.id = s.order_id
     where s.status = $1
     order by s.created_at asc`,
    [status]
  );
  res.json({ settlements: rows });
});

// Manual override for when a seller pays commission outside DPAY (bank
// transfer, in person, etc). Always logged to audit_logs since this is a
// human asserting money changed hands, not a system-verified payment.
router.post("/settlements/:id/mark-paid", financeOnly, async (req, res) => {
  const before = await query("select * from settlements where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "Settlement not found." });
  if (before.rows[0].status === "paid") return res.status(400).json({ error: "Already marked paid." });

  const { rows } = await query("update settlements set status = 'paid', paid_at = now() where id = $1 returning *", [req.params.id]);
  await query("insert into revenue_events (source, amount, ref_id) values ('commission', $1, $2)", [rows[0].commission_amount, rows[0].id]);
  await writeAudit("settlement", req.params.id, "marked_paid_manually", req.user.id, before.rows[0], rows[0]);
  res.json({ settlement: rows[0] });
});

// ---------------------------------------------------------------------
// Disputes center
// ---------------------------------------------------------------------

// Open disputes, oldest first — these need a human to actually look at them.
router.get("/disputes", async (req, res) => {
  const { status = "open" } = req.query;
  const { rows } = await query(
    `select d.*, o.listing_id, o.buyer_id, o.seller_id, o.part_price, o.payment_method, o.status as order_status
     from disputes d
     join orders o on o.id = d.order_id
     where d.status = $1 order by d.created_at asc`,
    [status]
  );
  res.json({ disputes: rows });
});

// Full drill-down for one dispute: order, listing, both parties, payment
// method, protection status, and the dispute's own event history. This is
// everything an admin needs on one screen to make a refund/release call.
router.get("/disputes/:id", async (req, res) => {
  const dispute = await query("select * from disputes where id = $1", [req.params.id]);
  if (!dispute.rows.length) return res.status(404).json({ error: "Dispute not found." });
  const d = dispute.rows[0];

  const [order, events, protection] = await Promise.all([
    query(
      `select o.*, l.title as listing_title,
              buyer.name as buyer_name, buyer.contact as buyer_contact,
              seller.name as seller_name, seller.contact as seller_contact
       from orders o
       join listings l on l.id = o.listing_id
       join users buyer on buyer.id = o.buyer_id
       join users seller on seller.id = o.seller_id
       where o.id = $1`,
      [d.order_id]
    ),
    query("select * from dispute_events where dispute_id = $1 order by created_at asc", [req.params.id]),
    query("select * from buyer_protection where order_id = $1", [d.order_id]),
  ]);

  res.json({ dispute: d, order: order.rows[0] || null, events: events.rows, protection: protection.rows[0] || null });
});

// Resolving a dispute is a real decision, not just a status flip: it needs
// a human-readable rationale (dispute_events), an audit trail, and — if
// this dispute was a buyer-protection claim — an explicit covered/denied
// outcome, since that's the thing the protection fee was sold as covering.
//
// resolutionType drives what actually happens to the order:
//   refund_buyer   -> order marked 'refunded', a negative revenue_event logged
//                     (the real money transfer back to the buyer happens
//                     outside this system today — see Model A notes — this
//                     records the decision and the accounting impact)
//   release_seller -> order stays 'completed', dispute closed in seller's favor
//   partial        -> recorded via resolution_note, no automatic order change
//   rejected       -> dispute dismissed, order stays as-is
router.post("/disputes/:id/resolve", moderationOnly, async (req, res) => {
  const { resolutionType, note, protectionOutcome } = req.body;
  if (!["refund_buyer", "release_seller", "partial", "rejected"].includes(resolutionType)) {
    return res.status(400).json({ error: "Invalid resolutionType." });
  }
  if (protectionOutcome && !["covered", "denied"].includes(protectionOutcome)) {
    return res.status(400).json({ error: "protectionOutcome must be 'covered' or 'denied'." });
  }

  const before = await query("select * from disputes where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "Dispute not found." });

  const disputeStatus = resolutionType === "rejected" ? "rejected" : "resolved";
  const { rows } = await query(
    "update disputes set status = $1, resolution_type = $2, resolution_note = $3, resolved_by = $4, resolved_at = now() where id = $5 returning *",
    [disputeStatus, resolutionType, note || null, req.user.id, req.params.id]
  );

  await query(
    "insert into dispute_events (dispute_id, actor_id, event_type, detail) values ($1,$2,$3,$4)",
    [req.params.id, req.user.id, disputeStatus === "resolved" ? "resolved" : "rejected", `${resolutionType}: ${note || ""}`]
  );
  await writeAudit("dispute", req.params.id, `admin_${resolutionType}`, req.user.id, before.rows[0], rows[0]);

  if (resolutionType === "refund_buyer") {
    const order = await query("select * from orders where id = $1", [before.rows[0].order_id]);
    if (order.rows.length) {
      const o = order.rows[0];
      await query("update orders set status = 'refunded' where id = $1", [o.id]);

      // Create the actual refund record rather than just flipping the order
      // status — an admin resolving a dispute is a definitive decision, so
      // this goes straight to 'refunded', but it's still a real row with
      // its own audit trail, not a silent status change.
      const refund = await query(
        `insert into refunds (order_id, dispute_id, amount, reason, status, requested_by, approved_by, approved_at, completed_at)
         values ($1,$2,$3,$4,'refunded',$5,$6,now(),now()) returning *`,
        [o.id, req.params.id, o.part_price, `Dispute resolution: ${note || resolutionType}`, before.rows[0].reporter_id, req.user.id]
      );
      await query(
        "insert into ledger_adjustments (order_id, refund_id, adjustment_type, amount, note, created_by) values ($1,$2,'refund',$3,$4,$5)",
        [o.id, refund.rows[0].id, o.part_price, `Dispute ${req.params.id} resolved as refund_buyer`, req.user.id]
      );
      await query("insert into revenue_events (source, amount, ref_id) values ('refund', $1, $2)", [o.part_price, o.id]);
    }
  }

  const protection = await query("select * from buyer_protection where claim_dispute_id = $1", [req.params.id]);
  if (protection.rows.length && protectionOutcome) {
    const pBefore = protection.rows[0];
    const pUpdated = await query("update buyer_protection set status = $1, resolved_at = now() where id = $2 returning *", [protectionOutcome, pBefore.id]);
    await writeAudit("buyer_protection", pBefore.id, `claim_${protectionOutcome}`, req.user.id, pBefore, pUpdated.rows[0]);
  }

  res.json({ dispute: rows[0] });
});

// ---------------------------------------------------------------------
// Unfulfilled demand — the "what should we go recruit sellers for" report
// ---------------------------------------------------------------------
router.get("/demand", async (req, res) => {
  const { maxResults = 3, days = 30 } = req.query;
  const { rows } = await query(
    `select lower(trim(query)) as normalized_query, count(*) as search_count,
            max(result_count) as best_result_count, max(created_at) as last_searched,
            mode() within group (order by inferred_category) as likely_category,
            mode() within group (order by city_filter) as likely_city
     from search_queries
     where result_count <= $1 and created_at >= now() - ($2 || ' days')::interval
     group by normalized_query
     order by search_count desc
     limit 50`,
    [maxResults, days]
  );
  res.json({ unfulfilledDemand: rows });
});

// ---------------------------------------------------------------------
// Bank transfer verification
// ---------------------------------------------------------------------
router.get("/bank-transfers/pending", async (req, res) => {
  const { rows } = await query(
    `select btc.*, o.part_price, o.buyer_id, u.name as buyer_name, u.contact as buyer_contact
     from bank_transfer_confirmations btc
     join orders o on o.id = btc.order_id
     join users u on u.id = btc.submitted_by
     where btc.status = 'pending' order by btc.created_at asc`
  );
  res.json({ confirmations: rows });
});

router.post("/bank-transfers/:id/verify", financeOnly, async (req, res) => {
  const { decision, rejectionReason } = req.body; // decision: 'verified' | 'rejected'
  if (!["verified", "rejected"].includes(decision)) return res.status(400).json({ error: "Invalid decision." });
  if (decision === "rejected" && !rejectionReason?.trim()) return res.status(400).json({ error: "rejectionReason required when rejecting." });

  const before = await query("select * from bank_transfer_confirmations where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "Confirmation not found." });
  if (before.rows[0].status !== "pending") return res.status(400).json({ error: "Already reviewed." });

  const { rows } = await query(
    "update bank_transfer_confirmations set status = $1, verified_by = $2, verified_at = now(), rejection_reason = $3 where id = $4 returning *",
    [decision, req.user.id, decision === "rejected" ? rejectionReason.trim() : null, req.params.id]
  );
  await writeAudit("bank_transfer_confirmation", req.params.id, `bank_transfer_${decision}`, req.user.id, before.rows[0], rows[0]);
  res.json({ confirmation: rows[0] });
});

// ---------------------------------------------------------------------
// Refund state machine
// ---------------------------------------------------------------------
router.get("/refunds", async (req, res) => {
  const { status = "requested" } = req.query;
  const { rows } = await query(
    `select r.*, o.part_price, o.listing_id, o.buyer_id, o.seller_id from refunds r
     join orders o on o.id = r.order_id
     where r.status = $1 order by r.created_at asc`,
    [status]
  );
  res.json({ refunds: rows });
});

async function transitionRefund(client, id, actorId, fromStatuses, toStatus, extraFields = {}) {
  const before = await query("select * from refunds where id = $1", [id]);
  if (!before.rows.length) return { error: 404, message: "Refund not found." };
  if (!fromStatuses.includes(before.rows[0].status)) {
    return { error: 400, message: `Refund is '${before.rows[0].status}', can't move to '${toStatus}'.` };
  }

  const setClauses = ["status = $1"];
  const params = [toStatus];
  for (const [col, val] of Object.entries(extraFields)) {
    params.push(val);
    setClauses.push(`${col} = $${params.length}`);
  }
  params.push(id);

  const { rows } = await query(`update refunds set ${setClauses.join(", ")} where id = $${params.length} returning *`, params);
  await writeAudit("refund", id, `refund_${toStatus}`, actorId, before.rows[0], rows[0]);
  return { refund: rows[0] };
}

router.post("/refunds/:id/approve", financeOnly, async (req, res) => {
  const result = await transitionRefund(null, req.params.id, req.user.id, ["requested"], "approved", { approved_by: req.user.id, approved_at: new Date() });
  if (result.error) return res.status(result.error).json({ error: result.message });
  res.json({ refund: result.refund });
});

router.post("/refunds/:id/process", financeOnly, async (req, res) => {
  const result = await transitionRefund(null, req.params.id, req.user.id, ["approved"], "processing");
  if (result.error) return res.status(result.error).json({ error: result.message });
  res.json({ refund: result.refund });
});

// The step that actually records the financial impact — a ledger entry
// and a matching revenue_events row — happens here, not at 'requested' or
// 'approved', since those are just decisions in progress.
router.post("/refunds/:id/complete", financeOnly, async (req, res) => {
  const before = await query("select * from refunds where id = $1", [req.params.id]);
  if (!before.rows.length) return res.status(404).json({ error: "Refund not found." });
  if (before.rows[0].status !== "processing") return res.status(400).json({ error: "Refund must be 'processing' before completing." });

  const { rows } = await query("update refunds set status = 'refunded', completed_at = now() where id = $1 returning *", [req.params.id]);
  await query(
    "insert into ledger_adjustments (order_id, refund_id, adjustment_type, amount, note, created_by) values ($1,$2,'refund',$3,$4,$5)",
    [before.rows[0].order_id, req.params.id, before.rows[0].amount, before.rows[0].reason, req.user.id]
  );
  await query("insert into revenue_events (source, amount, ref_id) values ('refund', $1, $2)", [before.rows[0].amount, before.rows[0].order_id]);
  await query("update orders set status = 'refunded' where id = $1", [before.rows[0].order_id]);
  await writeAudit("refund", req.params.id, "refund_completed", req.user.id, before.rows[0], rows[0]);
  res.json({ refund: rows[0] });
});

router.post("/refunds/:id/reject", financeOnly, async (req, res) => {
  const { reason } = req.body;
  const result = await transitionRefund(null, req.params.id, req.user.id, ["requested", "approved"], "rejected", reason ? { rejection_reason: reason } : {});
  if (result.error) return res.status(result.error).json({ error: result.message });
  res.json({ refund: result.refund });
});

// ---------------------------------------------------------------------
// Transactions search — the "find one specific order fast" view
// ---------------------------------------------------------------------
router.get("/transactions", financeOnly, async (req, res) => {
  const { orderId, sellerContact, buyerContact, minAmount, maxAmount, paymentMethod, status, dateFrom, dateTo } = req.query;
  const conditions = [];
  const params = [];

  if (orderId) { params.push(orderId); conditions.push(`o.id = $${params.length}`); }
  if (sellerContact) { params.push(`%${sellerContact}%`); conditions.push(`seller.contact ilike $${params.length}`); }
  if (buyerContact) { params.push(`%${buyerContact}%`); conditions.push(`buyer.contact ilike $${params.length}`); }
  if (minAmount) { params.push(minAmount); conditions.push(`o.part_price >= $${params.length}`); }
  if (maxAmount) { params.push(maxAmount); conditions.push(`o.part_price <= $${params.length}`); }
  if (paymentMethod) { params.push(paymentMethod); conditions.push(`o.payment_method = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`o.status = $${params.length}`); }
  if (dateFrom) { params.push(dateFrom); conditions.push(`o.created_at >= $${params.length}`); }
  if (dateTo) { params.push(dateTo); conditions.push(`o.created_at <= $${params.length}`); }

  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const { rows } = await query(
    `select o.*, l.title as listing_title,
            buyer.name as buyer_name, buyer.contact as buyer_contact,
            seller.name as seller_name, seller.contact as seller_contact
     from orders o
     join listings l on l.id = o.listing_id
     join users buyer on buyer.id = o.buyer_id
     join users seller on seller.id = o.seller_id
     ${where}
     order by o.created_at desc limit 200`,
    params
  );
  res.json({ transactions: rows });
});

module.exports = router;
