const crypto = require("crypto");

const DPAY_BASE = "https://api.dpay.ly/v1";

async function createInvoice({ amount, description, customerContact, metadata }) {
  const res = await fetch(`${DPAY_BASE}/invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DPAY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "LYD",
      description,
      customer: { contact: customerContact },
      metadata,
      redirect_url: process.env.DPAY_REDIRECT_URL || "https://ghayarak.ly/pay/return",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DPAY invoice creation failed (${res.status}): ${body}`);
  }
  return res.json(); // { id, payment_url, status, ... }
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const expected = crypto
    .createHmac("sha256", process.env.DPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  // timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createInvoice, verifyWebhookSignature };
