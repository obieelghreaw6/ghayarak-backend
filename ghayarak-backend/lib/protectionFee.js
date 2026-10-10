const { query } = require("../db");
const { createInvoice } = require("../payments/dpay");

// Ghayarak's fee is charged to the BUYER, on top of the listed price. The
// seller keeps 100% of the price they listed. Example: part 500 -> fee 25
// -> buyer's total 525. Change the percentage here and nowhere else.
const FEE_PCT = 5.0;

function computeFee(price) {
  return Math.round(Number(price) * (FEE_PCT / 100) * 100) / 100;
}

// Set REQUIRE_FEE_BEFORE_ACCEPT=true in Railway only once the frontend can
// send the buyer to the DPAY payment page. While it is off, orders still
// carry the fee and an invoice, but a seller can accept without it paid.
function feeGateEnabled() {
  return String(process.env.REQUIRE_FEE_BEFORE_ACCEPT || "").toLowerCase() === "true";
}

function feeIsBuyerPaid(order) {
  return order.fee_payer === "buyer" && Number(order.protection_fee) > 0;
}

async function isFeePaid(orderId) {
  const { rows } = await query(
    "select 1 from payments where kind = 'protection' and ref_id = $1 and status = 'paid' limit 1",
    [orderId]
  );
  return rows.length > 0;
}

// Creates (or returns the already-open) DPAY invoice for the buyer's
// protection fee. Safe to call repeatedly: a partial unique index allows
// only one pending-or-paid protection payment per order. Never throws —
// a DPAY outage must not break order creation; the caller gets
// { status: "unavailable" } and the buyer can retry via
// POST /orders/:id/protection-invoice.
async function ensureProtectionInvoice(order) {
  try {
    if (!feeIsBuyerPaid(order)) return { status: "none" };

    const existing = await query(
      "select * from payments where kind = 'protection' and ref_id = $1 and status in ('pending','paid') order by created_at desc limit 1",
      [order.id]
    );
    if (existing.rows.length) {
      const p = existing.rows[0];
      if (p.status === "paid") return { status: "paid" };
      const url = p.raw_payload && p.raw_payload.payment_url;
      if (url) return { status: "pending", invoiceId: p.dpay_invoice_id, paymentUrl: url };
    }

    const buyer = await query("select contact from users where id = $1", [order.buyer_id]);
    const invoice = await createInvoice({
      amount: Number(order.protection_fee),
      description: `Ghayarak protection fee — order ${order.id}`,
      customerContact: buyer.rows[0] ? buyer.rows[0].contact : null,
      metadata: { type: "protection", orderId: order.id },
    });
    try {
      await query(
        "insert into payments (dpay_invoice_id, kind, ref_id, amount, status, raw_payload) values ($1,'protection',$2,$3,'pending',$4)",
        [invoice.id, order.id, order.protection_fee, JSON.stringify(invoice)]
      );
    } catch (e) {
      // 23505: a concurrent call already opened an invoice for this order.
      if (e.code !== "23505") throw e;
      const again = await query(
        "select * from payments where kind = 'protection' and ref_id = $1 and status in ('pending','paid') limit 1",
        [order.id]
      );
      const p = again.rows[0];
      if (p && p.status === "paid") return { status: "paid" };
      return { status: "pending", invoiceId: p && p.dpay_invoice_id, paymentUrl: p && p.raw_payload && p.raw_payload.payment_url };
    }
    return { status: "pending", invoiceId: invoice.id, paymentUrl: invoice.payment_url };
  } catch (e) {
    console.error("Protection invoice failed for order", order && order.id, e);
    return { status: "unavailable" };
  }
}

// If the buyer already paid the fee and the order is then cancelled, queue
// a refund request for the fee so an admin returns it. Runs on the caller's
// transaction client. Idempotent: at most one fee refund per order.
async function queueFeeRefundIfPaid(client, orderId, userId, why) {
  const paid = await client.query(
    "select amount from payments where kind = 'protection' and ref_id = $1 and status = 'paid' limit 1",
    [orderId]
  );
  if (!paid.rows.length) return null;
  const dup = await client.query(
    "select id from refunds where order_id = $1 and reason like 'Protection fee refund%' and status <> 'rejected' limit 1",
    [orderId]
  );
  if (dup.rows.length) return null;
  const r = await client.query(
    "insert into refunds (order_id, amount, reason, requested_by) values ($1,$2,$3,$4) returning *",
    [orderId, paid.rows[0].amount, `Protection fee refund — ${why}`, userId]
  );
  return r.rows[0];
}

module.exports = {
  FEE_PCT,
  computeFee,
  feeGateEnabled,
  feeIsBuyerPaid,
  isFeePaid,
  ensureProtectionInvoice,
  queueFeeRefundIfPaid,
};
