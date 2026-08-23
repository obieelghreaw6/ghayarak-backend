const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

// Runs the full schema.sql on every boot. This is safe because the schema
// is written entirely with "create table if not exists", "create index if
// not exists", etc. — running it against a database that already has
// everything is a no-op, not a reset. This exists specifically so
// deploying doesn't require anyone to run `psql` by hand from a computer;
// the server sets itself up.
async function runMigrations() {
  const schemaPath = path.join(__dirname, "migrations", "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");

  console.log("Running database migrations...");
  try {
    // A plain (non-parameterized) query to node-postgres is sent via the
    // simple query protocol, which — unlike a parameterized query — is
    // allowed to contain multiple semicolon-separated statements in one
    // call. That's what lets the whole schema file run as a single step.
    await pool.query(schemaSql);
    console.log("Migrations complete.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    throw err;
  }
}

module.exports = { runMigrations };
