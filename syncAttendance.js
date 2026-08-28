require("dotenv").config();
require("dotenv").config({ path: ".env.local" });
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

if (!process.env.DB_USER || !process.env.DB_NAME) {
  console.error("Missing DB_USER or DB_NAME in .env");
  process.exit(1);
}

// MySQL Connection Pool 
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const ATTENDANCE_DIR =
  process.env.ATTENDANCE_EXPORT_DIR ||
  path.join(__dirname, "attendance_exports");

function getLatestCsvPath() {
  if (!fs.existsSync(ATTENDANCE_DIR)) {
    console.error("Attendance export folder does not exist:", ATTENDANCE_DIR);
    return null;
  }

  const files = fs
    .readdirSync(ATTENDANCE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".csv"));
  if (!files.length) return null;

  return files
    .map((name) => {
      const full = path.join(ATTENDANCE_DIR, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)[0].full;
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const header = lines[0];
  const delim =
    (header.match(/;/g) || []).length > (header.match(/,/g) || []).length
      ? ";"
      : ",";
  const cols = header.split(delim).map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const vals = line.split(delim);
    const row = {};
    cols.forEach((c, i) => {
      row[c] = (vals[i] || "").trim();
    });
    return row;
  });
}

async function syncOnce() {
  const csvPath = getLatestCsvPath();
  if (!csvPath) {
    console.log("No CSV found in", ATTENDANCE_DIR);
    return;
  }

  console.log("Reading", csvPath);
  const content = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(content);

  if (!rows.length) {
    console.log("CSV has no data rows");
    return;
  }

  // Convert time to MySQL format (YYYY-MM-DD HH:MM:SS)
  const toMysqlDate = (dateString) => {
    if (!dateString) return null;
    return new Date(dateString).toISOString().slice(0, 19).replace('T', ' ');
  };

  const payload = rows.map((r) => ({
    person_id: r["Person ID"] || null,
    name: r["Name"] || null,
    department: r["Department"] || null,
    event: r["Attendance Event"] || null,
    point: r["Attendance Point"] || null,
    method: r["Attendance Method"] || null,
    device_time: r["Time"] ? toMysqlDate(r["Time"]) : null,
  }));

  try {
    const keys = payload
      .filter((p) => p.person_id && p.device_time)
      .map((p) => ({ person_id: p.person_id, device_time: p.device_time, event: p.event }));

    if (keys.length > 0) {
      const deviceTimes = [...new Set(keys.map((k) => k.device_time))];
      let existingSet = new Set();

      try {
        // Fetch existing records from MySQL
        const [existing] = await pool.query(
          "SELECT person_id, event, device_time FROM attendance WHERE device_time IN (?)",
          [deviceTimes]
        );

        existingSet = new Set(
          existing.map((r) => {
            const dbDate = new Date(r.device_time).toISOString().slice(0, 19).replace('T', ' ');
            return `${r.person_id}|${r.event}|${dbDate}`;
          })
        );
      } catch (fetchErr) {
        console.error("Could not fetch existing attendance for dedupe:", fetchErr.message);
      }

      const filtered = payload.filter((p) => {
        if (!p.person_id || !p.device_time) return true;
        return !existingSet.has(`${p.person_id}|${p.event}|${p.device_time}`);
      });

      if (!filtered.length) {
        console.log("No new rows to insert after deduplication.");
        return;
      }

      // MySQL Bulk Insert
      const values = filtered.map(p => [
        p.person_id, p.name, p.department, p.event, p.point, p.method, p.device_time
      ]);

      const [result] = await pool.query(
        "INSERT INTO attendance (person_id, name, department, event, point, method, device_time) VALUES ?",
        [values]
      );
      console.log(`Inserted ${result.affectedRows} rows into MySQL.`);
      return;
    }

    // Fallback: insert everything if dedupe step couldn't run
    const values = payload.map(p => [
      p.person_id, p.name, p.department, p.event, p.point, p.method, p.device_time
    ]);
    const [result] = await pool.query(
      "INSERT INTO attendance (person_id, name, department, event, point, method, device_time) VALUES ?",
      [values]
    );
    console.log(`Inserted ${result.affectedRows} rows into MySQL.`);
    
  } catch (err) {
    console.error("Sync failed:", err);
  }
}

syncOnce().then(() => {
  pool.end(); // Close the database connection cleanly
  process.exit(0);
});