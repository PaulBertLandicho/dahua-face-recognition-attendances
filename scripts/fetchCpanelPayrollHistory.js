const https = require("https");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const REMOTE_BASE_URL = "https://attendance.multifactors-sales.com";
const REMOTE_QUERY_URL = `${REMOTE_BASE_URL}/api/db/query`;
const REMOTE_LOGIN_URL = `${REMOTE_BASE_URL}/api/auth/login`;

const LOCAL_DB_CONFIG = {
  host: process.env.LOCAL_DB_HOST || process.env.DB_HOST || "localhost",
  port: Number(process.env.LOCAL_DB_PORT || process.env.DB_PORT || 3306),
  user: process.env.LOCAL_DB_USER || process.env.DB_USER || "root",
  password: process.env.LOCAL_DB_PASSWORD ?? (process.env.DB_PASSWORD ?? ""),
  database: process.env.LOCAL_DB_NAME || process.env.DB_NAME || "multifac_attendance",
};

function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) opts.email = args[++i];
    else if (args[i] === "--password" && args[i + 1]) opts.password = args[++i];
    else if (args[i] === "--token" && args[i + 1]) opts.token = args[++i];
  }
  return opts;
}

function postJson(url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          ...extraHeaders,
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Remote HTTP error ${res.statusCode} on POST ${url}: ${raw}`));
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              return reject(new Error(`Remote DB query error: ${JSON.stringify(parsed.error)}`));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(new Error(`Network error on POST ${url}: ${err.message}`)));
    req.write(postData);
    req.end();
  });
}

function formatMysqlDatetime(val) {
  if (!val) return null;
  const str = String(val).trim();
  if (str.includes("T")) {
    return str.replace("T", " ").replace(/\..+$/, "").replace(/Z$/, "").slice(0, 19);
  }
  return str.slice(0, 19);
}

async function obtainAdminToken(cliOpts) {
  const explicitToken = cliOpts.token || process.env.CPANEL_ADMIN_TOKEN || "";
  if (explicitToken) {
    return explicitToken.trim();
  }
  const email = cliOpts.email || process.env.CPANEL_ADMIN_EMAIL || "multifactors-sales@gmail.com";
  const password = cliOpts.password || process.env.CPANEL_ADMIN_PASSWORD || "";
  if (!password) {
    throw new Error(
      "Admin authentication required. Pass --email and --password (or --token), or set CPANEL_ADMIN_EMAIL / CPANEL_ADMIN_PASSWORD."
    );
  }
  const loginRes = await postJson(REMOTE_LOGIN_URL, { email, password });
  const token = loginRes?.data?.session?.access_token;
  if (!token) {
    throw new Error("Admin login succeeded but did not return an access_token.");
  }
  return token;
}

async function getLocalTableColumns(conn, tableName) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\``);
  return new Set(rows.map((r) => r.Field));
}

async function run() {
  const cliOpts = parseCliArgs();
  console.log("=== Fetching cPanel Payroll Released Activity Logs & Released History ===");
  console.log(`Connecting to remote cPanel server: ${REMOTE_BASE_URL}...`);

  const adminToken = await obtainAdminToken(cliOpts);
  const authHeaders = {
    Authorization: `Bearer ${adminToken}`,
    "X-Auth-Token": adminToken,
  };

  const [logsRes, historyRes, periodsRes, personsRes] = await Promise.all([
    postJson(REMOTE_QUERY_URL, { table: "payroll_activity_logs", action: "select", select: "*" }, authHeaders),
    postJson(REMOTE_QUERY_URL, { table: "payroll_released_history", action: "select", select: "*" }, authHeaders),
    postJson(REMOTE_QUERY_URL, { table: "payroll_periods", action: "select", select: "*" }, authHeaders),
    postJson(REMOTE_QUERY_URL, { table: "persons", action: "select", select: "id,name,department" }, authHeaders),
  ]);

  const remoteLogs = logsRes.data || [];
  const remoteHistory = historyRes.data || [];
  const remotePeriods = periodsRes.data || [];
  const remotePersons = personsRes.data || [];

  console.log(
    `Fetched from cPanel -> payroll_activity_logs: ${remoteLogs.length}, payroll_released_history: ${remoteHistory.length}, payroll_periods: ${remotePeriods.length}`
  );

  // Save JSON backup to data/
  const backupDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `cpanel_payroll_history_${timestamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        fetched_at: new Date().toISOString(),
        payroll_activity_logs: remoteLogs,
        payroll_released_history: remoteHistory,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`Saved local JSON backup to: ${backupPath}`);

  console.log(
    `Connecting to local XAMPP MySQL at ${LOCAL_DB_CONFIG.host}:${LOCAL_DB_CONFIG.port}/${LOCAL_DB_CONFIG.database}...`
  );
  const conn = await mysql.createConnection(LOCAL_DB_CONFIG);

  try {
    // 1. Ensure all referenced person_ids exist in local `persons`
    const referencedPersonIds = new Set([
      ...remoteLogs.map((r) => r.person_id).filter(Boolean).map(String),
      ...remoteHistory.map((r) => r.person_id).filter(Boolean).map(String),
    ]);
    const [localPersons] = await conn.query("SELECT id FROM persons");
    const localPersonSet = new Set(localPersons.map((p) => String(p.id)));
    const remotePersonMap = new Map(remotePersons.map((p) => [String(p.id), p]));

    for (const pid of referencedPersonIds) {
      if (!localPersonSet.has(pid)) {
        const rp = remotePersonMap.get(pid) || {};
        await conn.execute(
          "INSERT INTO persons (id, name, department, approved, archived) VALUES (?, ?, ?, 1, 0) ON DUPLICATE KEY UPDATE name = COALESCE(VALUES(name), name)",
          [pid, rp.name || `Employee #${pid}`, rp.department || null]
        );
        localPersonSet.add(pid);
      }
    }

    // 2. Sync all payroll_periods referenced by payroll_activity_logs or payroll_released_history
    //    so foreign key fk_payroll_activity_logs_period and released flags stay aligned with cPanel.
    const referencedPeriodIds = new Set([
      ...remoteLogs.map((r) => r.payroll_period_id).filter(Boolean).map(String),
      ...remoteHistory.map((r) => r.payroll_period_id).filter(Boolean).map(String),
    ]);
    const periodCols = await getLocalTableColumns(conn, "payroll_periods");
    const remotePeriodMap = new Map(remotePeriods.map((p) => [String(p.id), p]));

    let syncedPeriods = 0;
    for (const periodId of referencedPeriodIds) {
      const rp = remotePeriodMap.get(periodId);
      const fallbackHistory = remoteHistory.find((h) => String(h.payroll_period_id) === periodId);
      const source = rp || fallbackHistory;
      if (!source || !source.person_id || !source.period) continue;

      const candidateRow = {
        id: periodId,
        person_id: String(source.person_id),
        period: String(source.period),
        days_present: source.days_present ?? 0,
        daily_rate: source.daily_rate ?? 0,
        late_penalty: source.late_penalty ?? 0,
        late_count: source.late_count ?? 0,
        gross: source.gross ?? 0,
        total_late_deduction: source.total_late_deduction ?? 0,
        total_deductions: source.total_deductions ?? 0,
        net: source.net ?? 0,
        released: source.released ?? 1,
        waive_early_in: source.waive_early_in ?? 0,
        waive_overtime: source.waive_overtime ?? 0,
        waive_late: source.waive_late ?? 0,
        created_at: formatMysqlDatetime(source.created_at),
        updated_at: formatMysqlDatetime(source.updated_at),
      };

      const cols = Object.keys(candidateRow).filter((c) => periodCols.has(c) && candidateRow[c] !== undefined);
      const colList = cols.map((c) => `\`${c}\``).join(", ");
      const placeholders = cols.map(() => "?").join(", ");
      const updates = cols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(", ");

      await conn.execute(
        `INSERT INTO payroll_periods (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
        cols.map((c) => candidateRow[c])
      );
      syncedPeriods++;
    }
    console.log(`Aligned ${syncedPeriods} referenced payroll_periods record(s) in local XAMPP.`);

    // 3. Upsert payroll_released_history
    const historyCols = await getLocalTableColumns(conn, "payroll_released_history");
    let historyInserted = 0;
    let historyUpdated = 0;
    let historyUnchanged = 0;

    for (const h of remoteHistory) {
      let detailedAttendanceJson = "[]";
      if (typeof h.detailed_attendance === "string") {
        detailedAttendanceJson = h.detailed_attendance.trim() || "[]";
      } else if (h.detailed_attendance !== null && h.detailed_attendance !== undefined) {
        detailedAttendanceJson = JSON.stringify(h.detailed_attendance);
      }

      const candidateRow = {
        id: String(h.id),
        payroll_period_id: String(h.payroll_period_id),
        person_id: String(h.person_id),
        person_name: h.person_name ?? null,
        department: h.department ?? null,
        period: String(h.period),
        days_present: h.days_present ?? 0,
        daily_rate: h.daily_rate ?? 0,
        late_penalty: h.late_penalty ?? 0,
        late_count: h.late_count ?? 0,
        gross: h.gross ?? 0,
        total_late_deduction: h.total_late_deduction ?? 0,
        total_deductions: h.total_deductions ?? 0,
        net: h.net ?? 0,
        waive_late: h.waive_late ?? 0,
        waive_early_in: h.waive_early_in ?? 0,
        waive_overtime: h.waive_overtime ?? 0,
        detailed_attendance: detailedAttendanceJson,
        released: h.released ?? 1,
        action: h.action || "Period Released",
        released_by: h.released_by ?? null,
        released_at: formatMysqlDatetime(h.released_at),
        created_at: formatMysqlDatetime(h.created_at),
        updated_at: formatMysqlDatetime(h.updated_at),
      };

      const cols = Object.keys(candidateRow).filter((c) => historyCols.has(c) && candidateRow[c] !== undefined);
      const colList = cols.map((c) => `\`${c}\``).join(", ");
      const placeholders = cols.map(() => "?").join(", ");
      const updates = cols
        .filter((c) => c !== "id")
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(", ");

      const [res] = await conn.execute(
        `INSERT INTO payroll_released_history (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
        cols.map((c) => candidateRow[c])
      );
      if (res.affectedRows === 1) historyInserted++;
      else if (res.affectedRows === 2) historyUpdated++;
      else historyUnchanged++;
    }

    // 4. Upsert payroll_activity_logs
    const logCols = await getLocalTableColumns(conn, "payroll_activity_logs");
    let logsInserted = 0;
    let logsUpdated = 0;
    let logsUnchanged = 0;

    for (const l of remoteLogs) {
      const candidateRow = {
        id: String(l.id),
        person_name: l.person_name ?? null,
        released_by: l.released_by || "Admin",
        action: l.action || "Period Released",
        timestamp: formatMysqlDatetime(l.timestamp),
        payroll_period_id: String(l.payroll_period_id),
        person_id: l.person_id != null ? String(l.person_id) : null,
      };

      const cols = Object.keys(candidateRow).filter((c) => logCols.has(c) && candidateRow[c] !== undefined);
      const colList = cols.map((c) => `\`${c}\``).join(", ");
      const placeholders = cols.map(() => "?").join(", ");
      const updates = cols
        .filter((c) => c !== "id")
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(", ");

      const [res] = await conn.execute(
        `INSERT INTO payroll_activity_logs (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
        cols.map((c) => candidateRow[c])
      );
      if (res.affectedRows === 1) logsInserted++;
      else if (res.affectedRows === 2) logsUpdated++;
      else logsUnchanged++;
    }

    const [[historyTotal]] = await conn.query("SELECT COUNT(*) AS total FROM payroll_released_history");
    const [[logsTotal]] = await conn.query("SELECT COUNT(*) AS total FROM payroll_activity_logs");

    console.log("\nSync Summary:");
    console.log(
      `  payroll_released_history -> Inserted: ${historyInserted}, Updated: ${historyUpdated}, Unchanged: ${historyUnchanged}, Local Total: ${historyTotal.total}`
    );
    console.log(
      `  payroll_activity_logs    -> Inserted: ${logsInserted}, Updated: ${logsUpdated}, Unchanged: ${logsUnchanged}, Local Total: ${logsTotal.total}`
    );

    const [historyRows] = await conn.query(
      `SELECT person_id, person_name, department, period, days_present, gross, total_deductions, net, action, released_by,
              DATE_FORMAT(released_at, '%Y-%m-%d %H:%i:%s') AS released_at
       FROM payroll_released_history
       ORDER BY released_at DESC, person_name ASC`
    );
    console.log("\nImported payroll_released_history in local XAMPP:");
    console.table(historyRows);

    const [logRows] = await conn.query(
      `SELECT person_id, person_name, action, released_by,
              DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:%s') AS timestamp
       FROM payroll_activity_logs
       ORDER BY timestamp DESC, person_name ASC`
    );
    console.log("\nImported payroll_activity_logs in local XAMPP:");
    console.table(logRows);

    console.log("\nPayroll released history & activity logs sync completed successfully.");
  } finally {
    await conn.end();
  }
}

run().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
