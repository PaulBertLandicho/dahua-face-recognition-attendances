require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

const BCRYPT_SALT_ROUNDS = Math.min(
  14,
  Math.max(10, Number(process.env.BCRYPT_SALT_ROUNDS || 12) || 12)
);
const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function isBcryptHash(value) {
  return typeof value === "string" && BCRYPT_HASH_REGEX.test(value);
}

/**
 * Hash every non-bcrypt password currently stored in `persons.password`.
 * Safe to re-run (already-hashed rows are skipped). Logs identifiers only, never secrets.
 */
async function migratePlaintextPasswords(pool, { apply = false, logger = console } = {}) {
  const [rows] = await pool.query(
    "SELECT id, email, role, password FROM persons WHERE password IS NOT NULL AND password != ''"
  );

  const summary = {
    totalWithPassword: rows.length,
    alreadyHashed: 0,
    pendingHash: 0,
    hashedNow: 0,
  };

  const toUpdate = [];
  for (const row of rows) {
    if (isBcryptHash(row.password)) {
      summary.alreadyHashed += 1;
    } else {
      summary.pendingHash += 1;
      toUpdate.push(row);
    }
  }

  logger.log(
    `[Password Migration] Checked ${summary.totalWithPassword} account(s): alreadyHashed=${summary.alreadyHashed}, unhashed=${summary.pendingHash}`
  );

  for (const row of toUpdate) {
    logger.log(`  - id=${row.id} email=${row.email || "(none)"} role=${row.role || "(none)"}`);
  }

  if (!apply || toUpdate.length === 0) {
    if (!apply && toUpdate.length > 0) {
      logger.log("[Password Migration] Dry run complete. Re-run with --apply to hash these rows in MySQL.");
    }
    return summary;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const row of toUpdate) {
      const hashed = await bcrypt.hash(String(row.password), BCRYPT_SALT_ROUNDS);
      await conn.query("UPDATE persons SET password = ? WHERE id = ?", [hashed, row.id]);
      summary.hashedNow += 1;
    }
    await conn.commit();
    logger.log(`[Password Migration] Successfully hashed ${summary.hashedNow} account password(s) with ${BCRYPT_SALT_ROUNDS} rounds.`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
  });

  try {
    await migratePlaintextPasswords(pool, { apply });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[Password Migration] Failed:", err.message);
    process.exit(1);
  });
}

module.exports = {
  BCRYPT_SALT_ROUNDS,
  BCRYPT_HASH_REGEX,
  isBcryptHash,
  migratePlaintextPasswords,
};
