const express = require("express");
const { query } = require("../db");
const { verifyWebhookSignature } = require("../payments/dpay");

const router = express.Router();

// Mounted with express.raw() in index.js so we can verify the signature
// against the exact bytes DPAY sent.
router.post("/dpay", async (req, res) => {
  const signature = req.headers["x-dpay-signature"];
  if (!verifyWebhookSignature(req.body, signature)) {
    return res.status(401).send("invalid signature");
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("invalid payload");
  }

  const payment = await query("select * from payments where dpay_invoice_id = $1", [event.id]);
  if (!payment.rows.length) return res.status(404).send("unknown invoice");
  const p = payment.rows[0];

  if (event.status === "paid" && p.status !== "paid") {
    await query("update payments set status = 'paid', raw_payload = $1 where id = $2", [event, p.id]);

    if (p.kind === "boost") {
      await query(
        "update listings set featured = true, featured_until = now() + interval '7 days' where id = $1",
        [p.ref_id]
      );
      await query("insert into revenue_events (source, amount, ref_id) values ('boost', $1, $2)", [p.amount, p.ref_id]);
    }

    if (p.kind === "subscription") {
      await query(
        "update shops set subscription_expiry = greatest(coalesce(subscription_expiry, now()), now()) + interval '30 days' where id = $1",
        [p.ref_id]
      );
      await query("insert into revenue_events (source, amount, ref_id) values ('subscription', $1, $2)", [p.amount, p.ref_id]);
    }

    if (p.kind === "protected_deal") {
      await query("update deals set escrow_status = 'held' where id = $1", [p.ref_id]);
      const deal = await query("select protection_fee from deals where id = $1", [p.ref_id]);
      if (deal.rows.length) {
        await query("insert into revenue_events (source, amount, ref_id) values ('protection', $1, $2)", [deal.rows[0].protection_fee, p.ref_id]);
      }
    }

    // Commission invoices are billed to the SELLER (they owe Ghayarak, not
    // the other way around) — p.ref_id here is a settlements.id.
    // Guard against double-counting: this webhook can retry/redeliver, and
    // an admin may have already marked this settlement paid manually.
    if (p.kind === "commission") {
      const before = await query("select * from settlements where id = $1", [p.ref_id]);
      if (before.rows.length && before.rows[0].status !== "paid") {
        await query("update settlements set status = 'paid', paid_at = now() where id = $1", [p.ref_id]);
        await query("insert into revenue_events (source, amount, ref_id) values ('commission', $1, $2)", [p.amount, p.ref_id]);
        await query(
          "insert into audit_logs (entity_type, entity_id, action, before_state, after_state) values ('settlement', $1, 'paid_via_dpay', $2, $3)",
          [p.ref_id, JSON.stringify(before.rows[0]), JSON.stringify({ status: "paid", dpay_event: event.id })]
        );
      }
    }
  }

  if (event.status === "failed") {
    await query("update payments set status = 'failed', raw_payload = $1 where id = $2", [event, p.id]);
  }

  res.sendStatus(200);
});

module.exports = router;
