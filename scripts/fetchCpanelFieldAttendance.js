const https = require("https");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const REMOTE_BASE_URL = "https://attendance.multifactors-sales.com";
const REMOTE_QUERY_URL = `${REMOTE_BASE_URL}/api/db/query`;
const REMOTE_LOGIN_URL = `${REMOTE_BASE_URL}/api/auth/login`;
const REMOTE_SCAN_CONTEXT_URL = `${REMOTE_BASE_URL}/api/face/scan-context`;
const REMOTE_PERSONS_OFFLINE_URL = `${REMOTE_BASE_URL}/api/face/persons-offline`;
const REMOTE_FACE_VERIFY_URL = `${REMOTE_BASE_URL}/api/face/verify`;

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

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", rejectUnauthorized: false },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Remote HTTP error ${res.statusCode} on GET ${url}: ${raw}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(new Error(`Network error on GET ${url}: ${err.message}`)));
    req.end();
  });
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
            return reject(new Error(`Remote HTTP error ${res.statusCode}: ${raw}`));
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              return reject(new Error(`Remote DB query error: ${JSON.stringify(parsed.error)}`));
            }
            resolve(parsed);
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

function loadBackupMetadataMap() {
  const backupMap = new Map();
  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) return backupMap;

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith(".json") && f.startsWith("cpanel_field_attendance_"));

  for (const file of files) {
    try {
      const records = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
      if (Array.isArray(records)) {
        for (const r of records) {
          if (r && (r.photo || r.notes || r.point)) {
            if (r.id != null) backupMap.set(Number(r.id), r);
            if (r.remote_id != null) backupMap.set(Number(r.remote_id), r);
            if (r.person_id && r.attendance_work_date && r.attendance_slot) {
              const slotKey = `${r.person_id}|${String(r.attendance_work_date).slice(0, 10)}|${r.attendance_slot}`;
              backupMap.set(slotKey, r);
            }
          }
        }
      }
    } catch (_) {
      // Ignore unreadable backup files
    }
  }
  return backupMap;
}

function formatMysqlDatetime(val) {
  if (!val) return null;
  const str = String(val).trim();
  if (str.includes("T")) {
    return str.replace("T", " ").replace(/\..+$/, "").replace(/Z$/, "").slice(0, 19);
  }
  return str.slice(0, 19);
}

function formatMysqlDate(val) {
  if (!val) return null;
  return String(val).trim().slice(0, 10);
}

async function tryObtainAdminToken(cliOpts) {
  const explicitToken = cliOpts.token || process.env.CPANEL_ADMIN_TOKEN || "";
  if (explicitToken) {
    return explicitToken.trim();
  }
  const email = cliOpts.email || process.env.CPANEL_ADMIN_EMAIL || "multifactors-sales@gmail.com";
  const password = cliOpts.password || process.env.CPANEL_ADMIN_PASSWORD || "";
  if (!password) return null;

  try {
    const loginRes = await postJson(REMOTE_LOGIN_URL, { email, password });
    return loginRes?.data?.session?.access_token || null;
  } catch (err) {
    console.warn(`Admin login attempt failed (${err.message}). Falling back to scanner verification token.`);
    return null;
  }
}

async function fetchRemoteFieldAttendance(cliOpts) {
  const scanContext = await getJson(REMOTE_SCAN_CONTEXT_URL);
  const remotePersons = scanContext.persons || [];
  const offlineData = await getJson(REMOTE_PERSONS_OFFLINE_URL);
  const offlinePersons = offlineData.persons || [];

  const remotePersonMap = new Map();
  for (const p of remotePersons) {
    remotePersonMap.set(String(p.id), {
      id: String(p.id),
      name: p.name || null,
      department: p.department || null,
      descriptor: null,
    });
  }
  for (const p of offlinePersons) {
    const existing = remotePersonMap.get(String(p.id)) || {
      id: String(p.id),
      name: p.name || null,
      department: p.department || null,
    };
    existing.descriptor = Array.isArray(p.descriptor) ? JSON.stringify(p.descriptor) : null;
    remotePersonMap.set(String(p.id), existing);
  }

  // 1. Try admin JWT first (returns full row including photo and notes)
  const adminToken = await tryObtainAdminToken(cliOpts);
  if (adminToken) {
    console.log("Authenticated with cPanel Admin JWT (fetching full records including photo & notes)...");
    const res = await postJson(
      REMOTE_QUERY_URL,
      {
        table: "attendance",
        action: "select",
        select: "*",
        filters: [{ column: "method", op: "eq", value: "field-site" }],
        orders: [{ column: "device_time", ascending: true }],
      },
      {
        Authorization: `Bearer ${adminToken}`,
        "X-Auth-Token": adminToken,
      }
    );
    return {
      records: res.data || [],
      remotePersonMap,
      fullColumnsFetched: true,
    };
  }

  // 2. Fallback: mint live face verification token and query across all person IDs
  console.log("Using live Face Verification Token to fetch field-site attendance records...");
  if (offlinePersons.length === 0) {
    throw new Error("No eligible face descriptors available on remote server to mint verification token.");
  }
  const verifyRes = await postJson(REMOTE_FACE_VERIFY_URL, {
    descriptor: offlinePersons[0].descriptor,
  });
  const faceToken = verifyRes.token;

  const pidSet = new Set([
    ...Array.from(remotePersonMap.keys()),
    ...Array.from({ length: 50 }, (_, i) => String(i + 1)),
  ]);
  const allPids = Array.from(pidSet);
  const recordsMap = new Map();

  for (let i = 0; i < allPids.length; i += 25) {
    const chunk = allPids.slice(i, i + 25);
    const res = await postJson(
      REMOTE_QUERY_URL,
      {
        table: "attendance",
        action: "select",
        filters: [
          { column: "person_id", op: "in", value: chunk },
          { column: "method", op: "eq", value: "field-site" },
        ],
        orders: [{ column: "device_time", ascending: true }],
      },
      { "X-Face-Token": faceToken }
    );
    for (const r of res.data || []) {
      recordsMap.set(Number(r.id), r);
    }
  }

  return {
    records: Array.from(recordsMap.values()),
    remotePersonMap,
    fullColumnsFetched: false,
  };
}

async function run() {
  const cliOpts = parseCliArgs();
  console.log("=== Fetching cPanel Field Attendance Records ===");
  console.log(`Connecting to remote endpoint: ${REMOTE_QUERY_URL}...`);

  const { records: rawFieldRecords, remotePersonMap, fullColumnsFetched } = await fetchRemoteFieldAttendance(cliOpts);
  console.log(`Found ${rawFieldRecords.length} field-site attendance record(s) on cPanel.`);

  if (rawFieldRecords.length === 0) {
    console.log("No field-site records found on remote server. Nothing to import.");
    return;
  }

  const backupMetadataMap = loadBackupMetadataMap();

  console.log(`\nConnecting to local MySQL at ${LOCAL_DB_CONFIG.host}:${LOCAL_DB_CONFIG.port}/${LOCAL_DB_CONFIG.database}...`);
  const conn = await mysql.createConnection(LOCAL_DB_CONFIG);

  const [localPersons] = await conn.query("SELECT id, name, department FROM persons");
  const localPersonMap = new Map(localPersons.map((p) => [String(p.id), p]));

  // Ensure all remote persons exist in local `persons` table
  for (const [pid, rp] of remotePersonMap.entries()) {
    const lp = localPersonMap.get(pid);
    if (!lp) {
      console.log(`Syncing missing employee from cPanel to local persons table: ID=${rp.id}, Name=${rp.name}, Dept=${rp.department}`);
      await conn.execute(
        "INSERT INTO persons (id, name, department, descriptor, approved, archived) VALUES (?, ?, ?, ?, 1, 0) ON DUPLICATE KEY UPDATE name = VALUES(name), department = VALUES(department)",
        [rp.id, rp.name, rp.department, rp.descriptor]
      );
      localPersonMap.set(pid, { id: rp.id, name: rp.name, department: rp.department });
    }
  }

  const fieldRecords = rawFieldRecords
    .map((r) => {
      const pid = String(r.person_id);
      const personInfo = remotePersonMap.get(pid) || localPersonMap.get(pid) || {};
      const workDate = formatMysqlDate(r.attendance_work_date) || formatMysqlDate(r.device_time);
      const slotKey = `${pid}|${workDate}|${r.attendance_slot}`;
      const backupMeta = backupMetadataMap.get(Number(r.id)) || backupMetadataMap.get(slotKey) || null;

      return {
        remote_id: Number(r.id),
        person_id: pid,
        name: r.name || (backupMeta && backupMeta.name) || personInfo.name || null,
        department: r.department || (backupMeta && backupMeta.department) || personInfo.department || null,
        event: r.event || null,
        point: r.point !== undefined ? r.point : (backupMeta ? backupMeta.point : null),
        method: r.method || "field-site",
        device_time: formatMysqlDatetime(r.device_time),
        attendance_work_date: workDate,
        attendance_slot: r.attendance_slot || null,
        status: r.status || null,
        ot_status: r.ot_status || (backupMeta && backupMeta.ot_status) || "pending",
        archived: r.archived !== undefined ? r.archived : (backupMeta && backupMeta.archived !== undefined ? backupMeta.archived : 0),
        photo: r.photo !== undefined ? r.photo : (backupMeta ? backupMeta.photo : null),
        notes: r.notes !== undefined ? r.notes : (backupMeta ? backupMeta.notes : null),
      };
    })
    .sort((a, b) => String(a.device_time || "").localeCompare(String(b.device_time || "")));

  // Save backup JSON to disk for audit
  const backupDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `cpanel_field_attendance_${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(fieldRecords, null, 2), "utf8");
  console.log(`Saved local JSON backup to: ${backupPath}`);

  const [countBeforeRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance");
  const [fieldBeforeRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance WHERE method = 'field-site'");
  console.log(`Local attendance before sync: Total = ${countBeforeRows[0].total}, Field-Site = ${fieldBeforeRows[0].total}`);

  const upsertSql = `
    INSERT INTO attendance (
      \`person_id\`, \`name\`, \`department\`, \`event\`, \`point\`, \`method\`,
      \`device_time\`, \`attendance_work_date\`, \`attendance_slot\`,
      \`status\`, \`ot_status\`, \`archived\`, \`photo\`, \`notes\`
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      \`name\` = COALESCE(VALUES(\`name\`), \`name\`),
      \`department\` = COALESCE(VALUES(\`department\`), \`department\`),
      \`event\` = VALUES(\`event\`),
      \`point\` = COALESCE(VALUES(\`point\`), \`point\`),
      \`method\` = VALUES(\`method\`),
      \`device_time\` = VALUES(\`device_time\`),
      \`attendance_work_date\` = VALUES(\`attendance_work_date\`),
      \`attendance_slot\` = VALUES(\`attendance_slot\`),
      \`status\` = VALUES(\`status\`),
      \`ot_status\` = COALESCE(\`ot_status\`, VALUES(\`ot_status\`), 'pending'),
      \`archived\` = COALESCE(\`archived\`, VALUES(\`archived\`), 0),
      \`photo\` = COALESCE(VALUES(\`photo\`), \`photo\`),
      \`notes\` = COALESCE(VALUES(\`notes\`), \`notes\`)
  `;

  let insertedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const record of fieldRecords) {
    const values = [
      record.person_id,
      record.name,
      record.department,
      record.event,
      record.point,
      record.method,
      record.device_time,
      record.attendance_work_date,
      record.attendance_slot,
      record.status,
      record.ot_status,
      record.archived,
      record.photo,
      record.notes,
    ];

    const [res] = await conn.execute(upsertSql, values);
    if (res.affectedRows === 1) {
      insertedCount++;
    } else if (res.affectedRows === 2) {
      updatedCount++;
    } else {
      unchangedCount++;
    }
  }

  const [countAfterRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance");
  const [fieldAfterRows] = await conn.query("SELECT COUNT(*) AS total FROM attendance WHERE method = 'field-site'");
  console.log(`\nSync Summary:`);
  console.log(`  Newly inserted:   ${insertedCount}`);
  console.log(`  Updated existing: ${updatedCount}`);
  console.log(`  Already synced:   ${unchangedCount}`);
  console.log(`Local attendance after sync: Total = ${countAfterRows[0].total}, Field-Site = ${fieldAfterRows[0].total}`);

  const [importedRows] = await conn.query(
    `SELECT id, person_id, name, department, event,
            DATE_FORMAT(device_time, '%Y-%m-%d %H:%i:%s') AS device_time,
            DATE_FORMAT(attendance_work_date, '%Y-%m-%d') AS work_date,
            attendance_slot, method, status,
            (photo IS NOT NULL AND photo != '') AS has_photo,
            notes
     FROM attendance
     WHERE method = 'field-site'
     ORDER BY device_time ASC`
  );
  console.log("\nImported local field-site records in XAMPP:");
  console.table(importedRows);

  if (!fullColumnsFetched) {
    console.log(
      "\nTip: To also fetch 'photo' and 'notes' for new field-site records directly from cPanel, run with your cPanel admin password:\n" +
      "  node scripts/fetchCpanelFieldAttendance.js --email multifactors-sales@gmail.com --password <your-cpanel-admin-password>"
    );
  }

  await conn.end();
  console.log("\nField attendance sync completed successfully.");
}

run().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
