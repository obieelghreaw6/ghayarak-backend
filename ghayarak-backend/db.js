const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Unexpected Postgres error", err);
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
