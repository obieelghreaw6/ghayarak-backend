// A single, minimal integration — a plain HTTPS call via Node's built-in
// fetch (Node 18+, already what this app runs on), no new dependency to
// install. If RESEND_API_KEY isn't set yet, this falls back to logging
// the content instead of throwing — so OTP requests keep working for
// local/manual testing even before the real key is configured, rather
// than breaking login entirely in the meantime.
async function sendEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "Ghayarak <onboarding@resend.dev>";

  if (!apiKey) {
    console.log(`[EMAIL not configured — would have sent] to=${to} subject="${subject}" body="${text}"`);
    return { sent: false };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Email send failed (${res.status}): ${body}`);
    return { sent: false };
  }

  return { sent: true };
}

module.exports = { sendEmail };
