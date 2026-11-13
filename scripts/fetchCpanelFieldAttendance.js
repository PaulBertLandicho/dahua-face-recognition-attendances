const https = require("https");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const REMOTE_URL = "https://attendance.multifactors-sales.com/api/db/query";

const LOCAL_DB_CONFIG = {
  host: process.env.LOCAL_DB_HOST || process.env.DB_HOST || "localhost",
  port: Number(process.env.LOCAL_DB_PORT || process.env.DB_PORT || 3306),
  user: process.env.LOCAL_DB_USER || process.env.DB_USER || "root",
  password: process.env.LOCAL_DB_PASSWORD ?? (process.env.DB_PASSWORD ?? ""),
  database: process.env.LOCAL_DB_NAME || process.env.DB_NAME || "multifac_attendance",
};

function fetchRemoteFieldAttendance() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      table: "attendance",
      action: "select",
      select: "*",
      filters: [{ column: "method", op: "eq", value: "field-site" }],
    });

    const req = https.request(
      REMOTE_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        rejectUnauthorized: false, // cPanel self-signed or CA cert compatibility
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Remote HTTP error ${res.statusCode}: ${raw}`));
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              return reject(new Error(`Remote DB query error: ${JSON.stringify(parsed.error)}`));
            }
            resolve(parsed.data || []);
          } catch (e) {
            reject(new Error(`Failed to parse remote response: ${e.message}\nRaw: ${raw.slice(0, 200)}`));
          }
        });
      }
    );

    req.on("error", (err) => reject(new Error(`Network error connecting to remote: ${err.message}`)));
    req.write(postData);
    req.end();
  });
}

async function run() {
  console.log("=== Fetching cPanel Field Attendance Records ===");
  console.log(`Connecting to remote endpoint: ${REMOTE_URL}...`);
  const fieldRecords = await fetchRemoteFieldAttendance();
  console.log(`Found ${fieldRecords.length} field-site attendance record(s) on cPanel.`);

  if (fieldRecords.length === 0) {
    console.log("No field-site records found on remote server. Nothing to import.");
    return;
  }

  // Save backup JSON to disk for audit
  const backupDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `cpanel_field_attendance_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(fieldRecords, null, 2), "utf8");
  console.log(`Saved local JSON backup to: ${backupPath}`);

  console.log(`\nConnecting to local MySQL at ${LOCAL_DB_CONFIG.host}:${LOCAL_DB_CONFIG.port}/${LOCAL_DB_CONFIG.database}...`);
  const conn = await mysql.createConnection(LOCAL_DB_CONFIG);

  const [countBeforeRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance");
  const [fieldBeforeRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance WHERE method = 'field-site'");
  console.log(`Local attendance before sync: Total = ${countBeforeRows[0].total}, Field-Site = ${fieldBeforeRows[0].total}`);

  const columns = [
    "id",
    "person_id",
    "name",
    "department",
    "event",
    "point",
    "method",
    "device_time",
    "attendance_work_date",
    "attendance_slot",
    "created_at",
    "status",
    "ot_status",
    "archived",
    "photo",
    "notes",
  ];

  const colList = columns.map((c) => `\`${c}\``).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const updateClauses = columns
    .filter((c) => c !== "id")
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
    .join(", ");

  const sql = `INSERT INTO attendance (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClauses}`;

  let insertedCount = 0;
  let updatedCount = 0;

  for (const record of fieldRecords) {
    const values = columns.map((col) => {
      let val = record[col];
      if (val === undefined) return null;
      if (col === "device_time" || col === "created_at") {
        if (typeof val === "string" && val.includes("T")) {
          // Format ISO 8601 to MySQL DATETIME
          val = val.replace("T", " ").replace(/\..+$/, "").slice(0, 19);
        }
      }
      return val;
    });

    const [res] = await conn.execute(sql, values);
    if (res.affectedRows === 1) {
      insertedCount++;
    } else if (res.affectedRows === 2) {
      updatedCount++;
    }
  }

  const [countAfterRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance");
  const [fieldAfterRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance WHERE method = 'field-site'");
  console.log(`\nSync Summary:`);
  console.log(`  Newly inserted: ${insertedCount}`);
  console.log(`  Updated existing: ${updatedCount}`);
  console.log(`Local attendance after sync: Total = ${countAfterRows[0].total}, Field-Site = ${fieldAfterRows[0].total}`);

  const [importedRows] = await conn.query(
    "SELECT id, person_id, name, event, attendance_work_date, attendance_slot, method, status, notes FROM attendance WHERE method = 'field-site' ORDER BY device_time ASC"
  );
  console.log("\nImported local field-site records in XAMPP:");
  console.table(importedRows);

  await conn.end();
  console.log("\nField attendance sync completed successfully.");
}

run().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
