const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");

const router = express.Router();

// Buyer reviewing the seller, or seller reviewing the buyer — direction is
// inferred from who's making the request, never trusted from the client.
router.post("/orders/:orderId/reviews", requireAuth, rateLimit("review_submit", { max: 20, windowMinutes: 60, keyFn: (req) => req.user.id }), async (req, res) => {
  const { overallRating, accuracyRating, conditionRating, communicationRating, speedRating, paymentRating, pickupRating, comment } = req.body;

  const order = await query("select * from orders where id = $1", [req.params.orderId]);
  if (!order.rows.length) return res.status(404).json({ error: "Order not found." });
  const o = order.rows[0];

  if (o.status !== "completed") {
    return res.status(400).json({ error: "Reviews can only be left on completed orders." });
  }

  let direction, revieweeId;
  if (req.user.id === o.buyer_id) {
    direction = "buyer_on_seller";
    revieweeId = o.seller_id;
  } else if (req.user.id === o.seller_id) {
    direction = "seller_on_buyer";
    revieweeId = o.buyer_id;
  } else {
    return res.status(403).json({ error: "Only the buyer or seller on this order can review it." });
  }

  if (!overallRating || overallRating < 1 || overallRating > 5) {
    return res.status(400).json({ error: "overallRating must be 1-5." });
  }

  const existing = await query("select id from reviews where order_id = $1 and direction = $2", [req.params.orderId, direction]);
  if (existing.rows.length) return res.status(409).json({ error: "You've already reviewed this order." });

  const { rows } = await query(
    `insert into reviews
      (order_id, reviewer_id, reviewee_id, direction, overall_rating, accuracy_rating, condition_rating, communication_rating, speed_rating, payment_rating, pickup_rating, comment)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [
      req.params.orderId, req.user.id, revieweeId, direction, overallRating,
      direction === "buyer_on_seller" ? accuracyRating : null,
      direction === "buyer_on_seller" ? conditionRating : null,
      direction === "buyer_on_seller" ? communicationRating : null,
      direction === "buyer_on_seller" ? speedRating : null,
      direction === "seller_on_buyer" ? paymentRating : null,
      direction === "seller_on_buyer" ? pickupRating : null,
      comment || null,
    ]
  );
  res.status(201).json({ review: rows[0] });
});

// Public — a seller's (or buyer's) review history and computed average.
// This is what a shop profile page or listing detail should call to show
// a real rating instead of a static seeded number.
router.get("/users/:userId/reviews", async (req, res) => {
  const [reviews, summary] = await Promise.all([
    query("select * from reviews where reviewee_id = $1 order by created_at desc limit 50", [req.params.userId]),
    query(
      `select count(*) as total, coalesce(avg(overall_rating), 0) as avg_rating,
              coalesce(avg(accuracy_rating), 0) as avg_accuracy, coalesce(avg(condition_rating), 0) as avg_condition,
              coalesce(avg(communication_rating), 0) as avg_communication, coalesce(avg(speed_rating), 0) as avg_speed
       from reviews where reviewee_id = $1 and direction = 'buyer_on_seller'`,
      [req.params.userId]
    ),
  ]);
  res.json({
    reviews: reviews.rows,
    summary: {
      total: Number(summary.rows[0].total),
      avgRating: Number(summary.rows[0].avg_rating),
      avgAccuracy: Number(summary.rows[0].avg_accuracy),
      avgCondition: Number(summary.rows[0].avg_condition),
      avgCommunication: Number(summary.rows[0].avg_communication),
      avgSpeed: Number(summary.rows[0].avg_speed),
    },
  });
});

module.exports = router;
