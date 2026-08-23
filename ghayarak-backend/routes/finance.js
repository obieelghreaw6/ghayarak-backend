const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /me/financials — the authenticated seller's own statement. Works
// for both individual sellers and shop owners: if they own a shop, figures
// are shop-wide; otherwise they're scoped to orders sold as an individual.
router.get("/me/financials", requireAuth, async (req, res) => {
  const shop = await query("select * from shops where owner_id = $1", [req.user.id]);
  const isShop = shop.rows.length > 0;
  const sellerCondition = isShop ? "o.shop_id = $1" : "o.seller_id = $1 and o.shop_id is null";
  const sellerParam = isShop ? shop.rows[0].id : req.user.id;

  const [totals, settlementTotals, refundTotals, orders, settlements] = await Promise.all([
    query(`select coalesce(sum(part_price), 0) as total_sales, count(*) as completed_count
           from orders o where ${sellerCondition} and o.status = 'completed'`, [sellerParam]),
    query(
      `select se.status, coalesce(sum(se.commission_amount), 0) as total, count(*) as count
       from settlements se join orders o on o.id = se.order_id
       where ${sellerCondition} group by se.status`,
      [sellerParam]
    ),
    query(
      `select coalesce(sum(r.amount), 0) as total, count(*) as count
       from refunds r join orders o on o.id = r.order_id
       where ${sellerCondition} and r.status = 'refunded'`,
      [sellerParam]
    ),
    query(
      `select o.id, o.part_price, o.status, o.created_at, o.completed_at, l.title as listing_title
       from orders o join listings l on l.id = o.listing_id
       where ${sellerCondition} order by o.created_at desc limit 50`,
      [sellerParam]
    ),
    query(
      `select se.* from settlements se join orders o on o.id = se.order_id
       where ${sellerCondition} order by se.created_at desc limit 50`,
      [sellerParam]
    ),
  ]);

  const bySettlementStatus = { owed: { total: 0, count: 0 }, invoiced: { total: 0, count: 0 }, paid: { total: 0, count: 0 }, waived: { total: 0, count: 0 } };
  settlementTotals.rows.forEach((r) => { bySettlementStatus[r.status] = { total: Number(r.total), count: Number(r.count) }; });

  res.json({
    isShop,
    totalSales: Number(totals.rows[0].total_sales),
    completedOrders: Number(totals.rows[0].completed_count),
    commissionOutstanding: bySettlementStatus.owed.total + bySettlementStatus.invoiced.total,
    commissionSettled: bySettlementStatus.paid.total,
    refundsTotal: Number(refundTotals.rows[0].total),
    refundsCount: Number(refundTotals.rows[0].count),
    settlementBreakdown: bySettlementStatus,
    recentOrders: orders.rows,
    settlementHistory: settlements.rows,
  });
});

module.exports = router;
