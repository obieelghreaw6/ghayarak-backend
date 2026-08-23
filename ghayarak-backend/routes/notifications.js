const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, async (req, res) => {
  const { unreadOnly } = req.query;
  const condition = unreadOnly === "true" ? "and read_at is null" : "";
  const { rows } = await query(
    `select * from notifications where user_id = $1 ${condition} order by created_at desc limit 100`,
    [req.user.id]
  );
  res.json({ notifications: rows });
});

router.get("/unread-count", requireAuth, async (req, res) => {
  const { rows } = await query("select count(*) from notifications where user_id = $1 and read_at is null", [req.user.id]);
  res.json({ count: Number(rows[0].count) });
});

router.post("/:id/read", requireAuth, async (req, res) => {
  const { rows } = await query(
    "update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null returning *",
    [req.params.id, req.user.id]
  );
  res.json({ notification: rows[0] || null });
});

router.post("/read-all", requireAuth, async (req, res) => {
  await query("update notifications set read_at = now() where user_id = $1 and read_at is null", [req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
