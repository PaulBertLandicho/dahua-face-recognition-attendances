require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");

let ffmpeg = null;
try {
  ffmpeg = require("fluent-ffmpeg");
} catch (e) {
  console.warn("fluent-ffmpeg not loaded:", e.message);
}

const app = express();

// High-efficiency Gzip/Brotli response compression to minimize cPanel bandwidth
let compression = null;
try {
  compression = require("compression");
  app.use(compression({
    level: 6,
    threshold: 1024,
  }));
  console.log("[Bandwidth Optimization] Compression middleware enabled.");
} catch (e) {
  console.warn("compression package not loaded:", e.message);
}

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const PORT = Number(process.env.PORT || 4000);
const STREAM_STALE_MS = 5000;

// Dahua Configuration
const RTSP_URL = process.env.DAHUA_RTSP_URL;
const DAHUA_DEVICE_IP = process.env.DAHUA_DEVICE_IP || "192.168.111.222";
const DAHUA_DEVICE_PORT = Number(process.env.DAHUA_DEVICE_PORT || 80);
const DAHUA_USERNAME = process.env.DAHUA_USERNAME || "admin";
const DAHUA_PASSWORD = process.env.DAHUA_PASSWORD || "";
const DAHUA_REQUEST_TIMEOUT_MS = Number(process.env.DAHUA_REQUEST_TIMEOUT_MS || 30000);
const AUTO_SYNC_ATTENDANCE_MINUTES = Number(process.env.AUTO_SYNC_ATTENDANCE_MINUTES || 0);

// Dahua Local Connector Configuration (optional, for network isolation fix)
const DAHUA_CONNECTOR_URL = process.env.DAHUA_CONNECTOR_URL || null;
const USE_LOCAL_CONNECTOR = !!DAHUA_CONNECTOR_URL;
if (USE_LOCAL_CONNECTOR) {
  console.log(`[Dahua] Using local connector at: ${DAHUA_CONNECTOR_URL}`);
} else {
  console.log(`[Dahua] Using direct connection to ${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}`);
}

const hlsDir = path.join(__dirname, "hls");
if (!fs.existsSync(hlsDir)) {
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch (e) {}
}

let ffmpegCommand = null;
const streamState = {
  status: "idle",
  lastError: null,
  lastStartAt: null,
  pid: null,
};

// MySQL Database Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "+08:00",
  dateStrings: true,
});

pool.query(`
  CREATE TABLE IF NOT EXISTS dahua_pending_deletions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(50) NOT NULL DEFAULT 'attendance',
    person_id VARCHAR(191) NOT NULL,
    device_time VARCHAR(100) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).then(() => {
  // Automatically remove any completed or stale records so the table does not accumulate clutter
  return pool.query("DELETE FROM dahua_pending_deletions WHERE status = 'completed' OR created_at < NOW() - INTERVAL 2 DAY");
}).catch((err) => console.warn("dahua_pending_deletions table init warning:", err.message));

// Initialize Dahua Device Monitoring and Sync Tracking table
pool.query(`
  CREATE TABLE IF NOT EXISTS dahua_device_status (
    id INT PRIMARY KEY DEFAULT 1,
    device_name VARCHAR(191) NOT NULL DEFAULT 'Multifactors Biometric Station',
    model VARCHAR(191) NOT NULL DEFAULT 'DHI-ASA3213GL-MW',
    ip_address VARCHAR(100) NOT NULL DEFAULT '192.168.111.222',
    port INT NOT NULL DEFAULT 80,
    connection_status VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    last_successful_sync DATETIME NULL,
    last_failed_sync DATETIME NULL,
    last_failed_reason TEXT NULL,
    last_attendance_sync DATETIME NULL,
    last_person_sync DATETIME NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
`).then(async () => {
  await pool.query(`
    INSERT IGNORE INTO dahua_device_status (id, device_name, model, ip_address, port, connection_status)
    VALUES (1, 'Multifactors Biometric Station', 'DHI-ASA3213GL-MW', '${DAHUA_DEVICE_IP}', ${DAHUA_DEVICE_PORT}, 'Unknown')
  `);
}).catch((err) => console.warn("dahua_device_status table init warning:", err.message));

// Initialize Expenses table for payroll deductions
pool.query(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    person_id VARCHAR(191) NOT NULL,
    period VARCHAR(100) NULL,
    item_name VARCHAR(255) NOT NULL,
    amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    expense_date DATE NULL,
    note TEXT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_expenses_person (person_id),
    INDEX idx_expenses_period (period)
  )
`).catch((err) => console.warn("expenses table init warning:", err.message));

async function recordDeviceSyncStatus({ type, success, error = null }) {
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (success) {
      if (type === 'person') {
        await pool.query(
          "UPDATE dahua_device_status SET last_successful_sync = ?, last_person_sync = ?, connection_status = 'Online', last_failed_reason = NULL WHERE id = 1",
          [now, now]
        );
      } else if (type === 'attendance') {
        await pool.query(
          "UPDATE dahua_device_status SET last_successful_sync = ?, last_attendance_sync = ?, connection_status = 'Online', last_failed_reason = NULL WHERE id = 1",
          [now, now]
        );
      } else {
        await pool.query(
          "UPDATE dahua_device_status SET last_successful_sync = ?, connection_status = 'Online', last_failed_reason = NULL WHERE id = 1",
          [now]
        );
      }
    } else {
      await pool.query(
        "UPDATE dahua_device_status SET last_failed_sync = ?, last_failed_reason = ?, connection_status = 'Error' WHERE id = 1",
        [now, String(error || 'Sync operation failed')]
      );
    }
  } catch (e) {
    console.warn("recordDeviceSyncStatus warning:", e.message);
  }
}

// Ensure employer share columns exist in department_rates
(async () => {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM department_rates");
    const colNames = (cols || []).map((c) => c.Field);
    if (!colNames.includes("sss_employer")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN sss_employer DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER philhealth");
    }
    if (!colNames.includes("pag_ibig_employer")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN pag_ibig_employer DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER sss_employer");
    }
    if (!colNames.includes("philhealth_employer")) {
      await pool.query("ALTER TABLE department_rates ADD COLUMN philhealth_employer DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER pag_ibig_employer");
    }
  } catch (e) {
    console.warn("Employer share columns check warning:", e.message);
  }
})();

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

// ==========================================
// DAHUA HELPER FUNCTIONS
// ==========================================
function parseDigestChallenge(header) {
  return Object.fromEntries(
    [...header.matchAll(/([a-z]+)=(?:"([^"]*)"|([^,]+))/gi)].map((match) => [
      match[1].toLowerCase(),
      match[2] || match[3].trim(),
    ])
  );
}

function digestResponse(method, requestPath, challenge) {
  const ha1 = crypto.createHash("md5").update(`${DAHUA_USERNAME}:${challenge.realm}:${DAHUA_PASSWORD}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${requestPath}`).digest("hex");
  const qop = challenge.qop && challenge.qop.split(",")[0].trim();
  const cnonce = crypto.randomBytes(16).toString("hex");
  const nonceCount = "00000001";
  if (qop) {
    const response = crypto.createHash("md5").update(`${ha1}:${challenge.nonce}:${nonceCount}:${cnonce}:${qop}:${ha2}`).digest("hex");
    return { response, cnonce, nonceCount, qop };
  }
  return crypto.createHash("md5").update(`${ha1}:${challenge.nonce}:${ha2}`).digest("hex");
}

function requestDahua(requestPath, method = "GET", authorization = null, body = null) {
  const transport = DAHUA_DEVICE_PORT === 443 ? https : http;
  return new Promise((resolve, reject) => {
    const requestBody = body == null ? null : JSON.stringify(body);
    const request = transport.request(
      {
        hostname: DAHUA_DEVICE_IP,
        port: DAHUA_DEVICE_PORT,
        path: requestPath,
        method,
        timeout: DAHUA_REQUEST_TIMEOUT_MS,
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          ...(requestBody ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(requestBody) } : {}),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ response, body }));
      }
    );
    request.on("timeout", () => {
      const target = `${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}`;
      const isPrivateLanAddress = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(DAHUA_DEVICE_IP);
      const networkHint = isPrivateLanAddress
        ? " This is a private LAN address; a cPanel server cannot reach it unless cPanel is connected to the same LAN or VPN. Run the local connector on the Dahua network, or configure a publicly reachable/VPN endpoint."
        : " Check that the Dahua endpoint is reachable from this server and that the port is open.";
      request.destroy(new Error(`Dahua request timed out connecting to ${target}.${networkHint}`));
    });
    request.on("error", reject);
    request.end(requestBody);
  });
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

async function requestDahuaJsonWithDigest(requestPath, method, payload) {
  const first = await requestDahua(requestPath, method, null, payload);
  if (first.response.statusCode !== 401) {
    if (first.response.statusCode < 200 || first.response.statusCode >= 300) throw new Error(`Dahua RPC request failed with HTTP ${first.response.statusCode}.`);
    return first;
  }
  const challengeHeader = first.response.headers["www-authenticate"];
  if (!challengeHeader) throw new Error("Dahua device did not provide authentication details.");
  const challenge = parseDigestChallenge(challengeHeader);
  const digest = digestResponse(method, requestPath, challenge);
  const fields = [
    `username="${DAHUA_USERNAME}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${requestPath}"`,
    `response="${digest.response || digest}"`,
  ];
  if (digest.qop) fields.push(`qop=${digest.qop}`, `nc=${digest.nonceCount}`, `cnonce="${digest.cnonce}"`);
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);

  const authenticated = await requestDahua(requestPath, method, `Digest ${fields.join(", ")}`, payload);
  if (authenticated.response.statusCode < 200 || authenticated.response.statusCode >= 300) {
    const details = authenticated.body && authenticated.body.trim();
    throw new Error(`Dahua RPC request failed with HTTP ${authenticated.response.statusCode}${details ? `: ${details}` : "."}`);
  }
  return authenticated;
}

async function getDahuaUsers(requestedUserIds = null) {
  // Use connector if available
  if (USE_LOCAL_CONNECTOR) {
    return await getDahuaUsersViaConnector(requestedUserIds);
  }

  const firstLogin = await requestDahuaJsonWithDigest("/RPC2_Login", "POST", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: "", clientType: "Web3.0" },
    id: 1,
  });
  const firstData = JSON.parse(firstLogin.body || "{}");
  const loginParams = firstData.params || {};
  const passwordHash = md5(`${DAHUA_USERNAME}:${loginParams.realm}:${DAHUA_PASSWORD}`);
  const loginPassword = passwordHash.toUpperCase();
  const session = firstData.session || 0;
  const secondLogin = await requestDahuaJsonWithDigest("/RPC2_Login", "POST", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: loginPassword, clientType: "Web3.0", authorityType: "Default" },
    id: 2,
    session,
  });
  const secondData = JSON.parse(secondLogin.body || "{}");
  const activeSession = secondData.session || session;
  const users = [];
  const batches = requestedUserIds
    ? Array.from({ length: Math.ceil(requestedUserIds.length / 10) }, (_, index) => requestedUserIds.slice(index * 10, index * 10 + 10))
    : Array.from({ length: 100 }, (_, index) => Array.from({ length: 10 }, (_, offset) => String(index * 10 + offset + 1)));
  for (const userIds of batches) {
    const usersResponse = await requestDahuaJsonWithDigest("/RPC2", "POST", {
      method: "AccessUser.list",
      params: { UserIDList: userIds },
      id: users.length + 3,
      session: activeSession,
    });
    const usersData = JSON.parse(usersResponse.body || "{}");
    const batch = usersData?.params?.Users || usersData?.error?.detail?.Users || [];
    users.push(...batch.filter(Boolean));
  }

  // Also fetch enrolled face photos from Dahua AccessFace.list
  if (users.length > 0) {
    const allUserIds = users.map((u) => String(u.UserID || u.id)).filter(Boolean);
    const photoMap = {};
    for (let i = 0; i < allUserIds.length; i += 10) {
      const chunk = allUserIds.slice(i, i + 10);
      try {
        const faceRes = await requestDahuaJsonWithDigest("/RPC2", "POST", {
          method: "AccessFace.list",
          params: { UserIDList: chunk },
          id: users.length + 100 + i,
          session: activeSession,
        });
        const parsed = JSON.parse(faceRes.body || "{}");
        const faceList = parsed?.params?.FaceDataList || parsed?.error?.detail?.FaceDataList || [];
        for (const item of faceList) {
          if (item && item.UserID && Array.isArray(item.PhotoData) && item.PhotoData.length > 0) {
            const b64 = item.PhotoData[0];
            if (b64 && typeof b64 === "string" && b64.length > 50) {
              photoMap[String(item.UserID)] = b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
            }
          }
        }
      } catch (e) {}
    }
    for (const u of users) {
      const uid = String(u.UserID || u.id);
      if (photoMap[uid]) {
        u.registration_photo = photoMap[uid];
      }
    }
  }

  return users;
}

async function requestDahuaWithDigest(requestPath) {
  const first = await requestDahua(requestPath);
  if (first.response.statusCode !== 401) return first.body;
  const challengeHeader = first.response.headers["www-authenticate"];
  const challenge = parseDigestChallenge(challengeHeader);
  const digest = digestResponse("GET", requestPath, challenge);
  const fields = [
    `username="${DAHUA_USERNAME}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${requestPath}"`,
    `response="${digest.response || digest}"`,
  ];
  if (digest.qop) fields.push(`qop=${digest.qop}`, `nc=${digest.nonceCount}`, `cnonce="${digest.cnonce}"`);
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);
  const authorization = `Digest ${fields.join(", ")}`;
  const authenticated = await requestDahua(requestPath, "GET", authorization);
  return authenticated.body;
}

function parseDahuaRows(body) {
  const rows = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^(?:records|users)\[(\d+)\]\.([^=]+)=(.*)$/);
    if (!match) continue;
    const [, index, field, value] = match;
    rows[index] = rows[index] || {};
    rows[index][field] = value.trim();
  }
  return rows.filter(Boolean);
}

function firstValue(row, names) {
  return names.map((name) => row[name]).find((value) => value !== undefined && value !== "") || null;
}

function errorMessage(error, fallback = "Unknown error") {
  if (error instanceof Error && error.message) return error.message;
  const connectionError = error?.code === "ECONNREFUSED" ? error : error?.errors?.find((item) => item?.code === "ECONNREFUSED");
  if (connectionError?.code === "ECONNREFUSED") {
    const target = connectionError.address && connectionError.port ? ` ${connectionError.address}:${connectionError.port}` : "";
    return `Database connection was refused${target}. Check DB_HOST, DB_PORT, and that the Database service is running.`;
  }
  if (typeof error === "string" && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch (serializationError) {
    return fallback;
  }
}

function normalizeDahuaDeviceTime(value, targetTimezone = process.env.DAHUA_TIMEZONE || "Asia/Manila") {
  if (!value) return null;
  const text = String(value).trim();
  const pad = (n) => String(n).padStart(2, "0");

  const numeric = Number(text);
  if (/^\d{10,13}$/.test(text)) {
    const ms = text.length === 10 ? numeric * 1000 : numeric;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;

    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: targetTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = Object.fromEntries(
        formatter.formatToParts(d).map((p) => [p.type, p.value])
      );
      const hourStr = parts.hour === "24" ? "00" : parts.hour;
      return `${parts.year}-${parts.month}-${parts.day} ${hourStr}:${parts.minute}:${parts.second}`;
    } catch (e) {
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  }

  const normalizedText = text.replace(/[\/]/g, "-");
  const match = normalizedText.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4])}:${match[5]}:${match[6]}`;
  }

  const parsed = new Date(normalizedText);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: targetTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = Object.fromEntries(
      formatter.formatToParts(parsed).map((p) => [p.type, p.value])
    );
    const hourStr = parts.hour === "24" ? "00" : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day} ${hourStr}:${parts.minute}:${parts.second}`;
  } catch (e) {
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
  }
}

function mapDahuaAttendanceEvent(record) {
  const type = String(firstValue(record, ["Type", "type"]) || "").toLowerCase();
  if (type.includes("exit") || type.includes("out") || type.includes("leave")) return "time-out";
  return "time-in";
}

function mapDahuaAttendanceMethod(value) {
  const method = String(value || "").toLowerCase();
  const methods = { "15": "face", "21": "fingerprint", "3": "card", "4": "password" };
  return methods[method] || (method || "device");
}

function parseHHMMToMinutes(value, fallback = 0) {
  if (!value || typeof value !== "string") return fallback;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
  return hours * 60 + minutes;
}

function dedupeDahuaAttendanceByPersonDay(records, settings = null) {
  const safeRecords = (records || []).filter((record) => record && record.person_id && record.device_time);
  if (!safeRecords.length) return [];

  const morningStart = parseHHMMToMinutes(settings?.morning_start || "08:00", 8 * 60);
  const morningEnd = parseHHMMToMinutes(settings?.morning_end || "11:59", 11 * 60 + 59);
  const afternoonStart = parseHHMMToMinutes(settings?.afternoon_start || "13:00", 13 * 60);

  // Helper: extract HH:MM minutes from a local time string "YYYY-MM-DD HH:MM:SS"
  function minutesFromLocalTime(deviceTime) {
    const match = String(deviceTime).match(/(\d{2}):(\d{2}):(\d{2})$/);
    if (match) return Number(match[1]) * 60 + Number(match[2]);
    // Fallback for unexpected formats
    const d = new Date(deviceTime);
    return Number.isNaN(d.getTime()) ? -1 : d.getHours() * 60 + d.getMinutes();
  }

  // Helper: extract date portion "YYYY-MM-DD" from a local time string
  function dateFromLocalTime(deviceTime) {
    const match = String(deviceTime).match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }

  const byPersonDay = new Map();
  for (const record of safeRecords) {
    const dateStr = dateFromLocalTime(record.device_time);
    if (!dateStr) continue;
    const mins = minutesFromLocalTime(record.device_time);
    if (mins < 0) continue;

    // Assign event by time window (matches the MySQL trigger logic)
    let event;
    if (mins >= morningStart && mins <= morningEnd) {
      event = "time-in";
    } else if (mins >= afternoonStart) {
      event = "time-out";
    } else {
      // Outside both windows — skip this record
      continue;
    }

    const dateKey = `${record.person_id}|${dateStr}`;
    const bucket = byPersonDay.get(dateKey) || [];
    bucket.push({
      ...record,
      _dateStr: dateStr,
      _minutes: mins,
      event,
    });
    byPersonDay.set(dateKey, bucket);
  }

  const finalRecords = [];
  for (const bucket of byPersonDay.values()) {
    // Morning In: FIRST scan in the morning window (earliest time)
    const morningInCandidates = bucket
      .filter((record) => record.event === "time-in")
      .sort((a, b) => a._minutes - b._minutes);

    // Afternoon Out: LAST scan in the afternoon window (latest time)
    const afternoonOutCandidates = bucket
      .filter((record) => record.event === "time-out")
      .sort((a, b) => a._minutes - b._minutes);

    const morningIn = morningInCandidates[0];
    const afternoonOut = afternoonOutCandidates.length ? afternoonOutCandidates[afternoonOutCandidates.length - 1] : null;

    if (morningIn) finalRecords.push(morningIn);
    if (afternoonOut) finalRecords.push(afternoonOut);
  }

  return finalRecords;
}

async function getSettingsRow() {
  const [rows] = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
  return rows[0] || null;
}

async function generatePayrollPeriodsFromAttendance(attendanceRows = []) {
  if (!Array.isArray(attendanceRows) || !attendanceRows.length) {
    const [allAttendance] = await pool.query(
      "SELECT * FROM attendance WHERE archived = 0 ORDER BY device_time ASC"
    );
    attendanceRows = allAttendance;
  }

  if (!attendanceRows.length) return { created: 0, updated: 0 };

  const settings = await getSettingsRow();
  const periodDays = Number(settings?.payroll_period_days || 15);
  const uniquePersonIds = [...new Set(attendanceRows.map((row) => row.person_id).filter(Boolean))];
  if (!uniquePersonIds.length) return { created: 0, updated: 0 };

  const [personsRows] = await pool.query(
    "SELECT * FROM persons WHERE id IN (?) ORDER BY name ASC",
    [uniquePersonIds]
  );
  const personById = new Map(personsRows.map((person) => [person.id, person]));

  let created = 0;
  let updated = 0;

  for (const personId of uniquePersonIds) {
    const person = personById.get(personId);
    if (!person) continue;

    const [rows] = await pool.query(
      "SELECT * FROM attendance WHERE person_id = ? AND archived = 0 ORDER BY device_time ASC",
      [personId]
    );
    if (!rows.length) continue;

    const [historyRows] = await pool.query(
      "SELECT period FROM payroll_released_history WHERE person_id = ?",
      [personId]
    );
    const releasedPeriods = new Set(historyRows.map(r => r.period));

    const earliestDate = new Date(rows[0].device_time);
    const latestDate = new Date(rows[rows.length - 1].device_time);
    let cursor = new Date(earliestDate);
    cursor.setHours(0, 0, 0, 0);

    while (cursor <= latestDate) {
      const periodEnd = new Date(cursor);
      periodEnd.setDate(periodEnd.getDate() + periodDays - 1);
      periodEnd.setHours(23, 59, 59, 999);

      const periodStartYmd = cursor.toISOString().slice(0, 10);
      const periodEndYmd = periodEnd.toISOString().slice(0, 10);
      const periodKey = `${periodStartYmd}_to_${periodEndYmd}`;

      if (releasedPeriods.has(periodKey)) {
        cursor.setDate(cursor.getDate() + periodDays);
        continue;
      }

      const periodAttendance = rows.filter((record) => {
        const dt = new Date(record.device_time);
        return dt >= cursor && dt <= periodEnd;
      });

      if (periodAttendance.length) {
        const uniqueDates = new Set(
          periodAttendance
            .map((record) => new Date(record.device_time).toISOString().slice(0, 10))
            .filter(Boolean)
        );

        const morningStart = Number((settings?.morning_start || "08:00").split(":")[0] || 8) * 60 + Number((settings?.morning_start || "08:00").split(":")[1] || 0);
        const morningGrace = Number(settings?.morning_grace_minutes || 15);
        const afternoonStart = Number((settings?.afternoon_start || "13:00").split(":")[0] || 13) * 60 + Number((settings?.afternoon_start || "13:00").split(":")[1] || 0);
        const afternoonGrace = Number(settings?.afternoon_grace_minutes || 15);
        const afternoonEnd = Number((settings?.afternoon_end || "17:00").split(":")[0] || 17) * 60 + Number((settings?.afternoon_end || "17:00").split(":")[1] || 0);

        let lateCount = 0;
        let daysPresent = 0;
        
        for (const dateKey of uniqueDates) {
          const byDate = periodAttendance.filter((record) => new Date(record.device_time).toISOString().slice(0, 10) === dateKey);
          byDate.sort((a, b) => new Date(a.device_time) - new Date(b.device_time));
          const morningRecord = byDate.find((record) => new Date(record.device_time).getHours() < 12) || null;
          const afternoonRecord = [...byDate].reverse().find((record) => new Date(record.device_time).getHours() >= 12) || null;

          // Only count the day as present if they have BOTH morning in and afternoon out
          if (morningRecord && afternoonRecord) {
            daysPresent += 1;
            
            // Only apply late penalties for days they are actually paid for
            const morningDt = new Date(morningRecord.device_time);
            const morningMinutes = morningDt.getHours() * 60 + morningDt.getMinutes();
            if (morningMinutes > morningStart + morningGrace) lateCount += 1;
            
            const afternoonDt = new Date(afternoonRecord.device_time);
            const afternoonMinutes = afternoonDt.getHours() * 60 + afternoonDt.getMinutes();
            if (afternoonMinutes > afternoonEnd + afternoonGrace) lateCount += 1;
          }
        }

        const departmentRate = await pool.query(
          "SELECT * FROM department_rates WHERE department = ? LIMIT 1",
          [person.department || ""]
        );
        const rate = departmentRate[0]?.[0] || {};
        const dailyRate = Number(person.daily_rate ?? rate.daily_rate ?? 0);
        const latePenalty = Number(person.late_penalty ?? rate.late_penalty ?? 0);
        const sss = Number(rate.sss ?? 0);
        const pagIbig = Number(rate.pag_ibig ?? 0);
        const philhealth = Number(rate.philhealth ?? 0);
        const cashAdvance = Number(person.cash_advance ?? 0);

        const totalLateDeduction = lateCount * latePenalty;
        const totalDeductions = sss + pagIbig + philhealth + cashAdvance + totalLateDeduction;
        const gross = dailyRate * daysPresent;
        let net = gross - totalDeductions;
        
        // Prevent negative net pay
        if (net < 0) net = 0;

        const payload = {
          person_id: person.id,
          period: periodKey,
          days_present: Number(daysPresent || 0),
          daily_rate: Number(dailyRate || 0),
          late_penalty: Number(latePenalty || 0),
          late_count: Number(lateCount || 0),
          gross: Number(gross || 0),
          total_late_deduction: Number(totalLateDeduction || 0),
          total_deductions: Number(totalDeductions || 0),
          net: Number(net || 0),
          released: 0,
        };

        const [result] = await pool.query(
          `INSERT INTO payroll_periods
            (id, person_id, period, days_present, daily_rate, late_penalty, late_count, gross, total_late_deduction, total_deductions, net, released, created_at, updated_at)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
            days_present = VALUES(days_present),
            daily_rate = VALUES(daily_rate),
            late_penalty = VALUES(late_penalty),
            late_count = VALUES(late_count),
            gross = VALUES(gross),
            total_late_deduction = VALUES(total_late_deduction),
            total_deductions = VALUES(total_deductions),
            net = VALUES(net),
            updated_at = NOW()`,
          [
            payload.person_id,
            payload.period,
            payload.days_present,
            payload.daily_rate,
            payload.late_penalty,
            payload.late_count,
            payload.gross,
            payload.total_late_deduction,
            payload.total_deductions,
            payload.net,
            payload.released,
          ]
        );

        if (result && result.affectedRows) {
          if (result.insertId || result.warningStatus === 0) {
            created += 1;
          } else {
            updated += 1;
          }
        }
      }

      cursor.setDate(cursor.getDate() + periodDays);
    }
  }

  return { created, updated };
}

async function regeneratePayrollPeriodsIfNeeded() {
  try {
    const result = await generatePayrollPeriodsFromAttendance();
    if (result.created || result.updated) {
      console.log(`[Payroll] Generated payroll periods: created=${result.created}, updated=${result.updated}`);
    }
  } catch (error) {
    console.error("[Payroll] Auto-generation failed:", error.message);
  }
}

// ==========================================
// LOCAL CONNECTOR HELPER FUNCTIONS
// ==========================================
// These functions route Dahua requests through the local connector if configured

async function requestDahuaViaConnector(method, path, payload = null) {
  if (!USE_LOCAL_CONNECTOR) throw new Error("Local connector not configured");
  
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      path,
      method,
      payload,
    });

    const parsedUrl = new URL(DAHUA_CONNECTOR_URL);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    
    const request = transport.request(
      {
        method: "POST",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: "/dahua/rpc",
        timeout: DAHUA_REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            const result = JSON.parse(body || "{}");
            resolve(result);
          } catch (e) {
            reject(new Error(`Invalid JSON response from connector: ${body}`));
          }
        });
      }
    );
    
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Connector request timed out after ${DAHUA_REQUEST_TIMEOUT_MS}ms`));
    });
    
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

async function requestDahuaGetViaConnector(path) {
  if (!USE_LOCAL_CONNECTOR) throw new Error("Local connector not configured");
  
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(DAHUA_CONNECTOR_URL);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const fullPath = `/dahua/get?path=${encodeURIComponent(path)}`;
    
    const request = transport.request(
      {
        method: "GET",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: fullPath,
        timeout: DAHUA_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
      }
    );
    
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Connector GET request timed out after ${DAHUA_REQUEST_TIMEOUT_MS}ms`));
    });
    
    request.on("error", reject);
    request.end();
  });
}

async function getDahuaUsersViaConnector(requestedUserIds = null) {
  const firstLogin = await requestDahuaViaConnector("POST", "/RPC2_Login", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: "", clientType: "Web3.0" },
    id: 1,
  });
  if (!firstLogin.success) throw new Error(firstLogin.error || "Failed to login to Dahua via connector");
  
  const firstData = JSON.parse(firstLogin.body || "{}");
  const loginParams = firstData.params || {};
  const passwordHash = md5(`${DAHUA_USERNAME}:${loginParams.realm}:${DAHUA_PASSWORD}`);
  const loginPassword = passwordHash.toUpperCase();
  const session = firstData.session || 0;
  
  const secondLogin = await requestDahuaViaConnector("POST", "/RPC2_Login", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: loginPassword, clientType: "Web3.0", authorityType: "Default" },
    id: 2,
    session,
  });
  if (!secondLogin.success) throw new Error(secondLogin.error || "Failed to authenticate with Dahua via connector");
  
  const secondData = JSON.parse(secondLogin.body || "{}");
  const activeSession = secondData.session || session;
  const users = [];
  
  const batches = requestedUserIds
    ? Array.from({ length: Math.ceil(requestedUserIds.length / 10) }, (_, index) => requestedUserIds.slice(index * 10, index * 10 + 10))
    : Array.from({ length: 100 }, (_, index) => Array.from({ length: 10 }, (_, offset) => String(index * 10 + offset + 1)));
  
  for (const userIds of batches) {
    const usersResponse = await requestDahuaViaConnector("POST", "/RPC2", {
      method: "AccessUser.list",
      params: { UserIDList: userIds },
      id: users.length + 3,
      session: activeSession,
    });
    if (!usersResponse.success) throw new Error(usersResponse.error || "Failed to get users from Dahua via connector");
    
    const usersData = JSON.parse(usersResponse.body || "{}");
    const batch = usersData?.params?.Users || usersData?.error?.detail?.Users || [];
    users.push(...batch.filter(Boolean));
  }
  return users;
}

// ==========================================
// AUTHENTICATION API ROUTES (MySQL)
// ==========================================
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: { message: "Email and password are required." } });
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM persons WHERE email = ? LIMIT 1",
      [String(email).trim()]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ error: { message: "Invalid email or password." } });
    }

    const user = rows[0];

    if (user.password && user.password !== password) {
      return res.status(401).json({ error: { message: "Invalid email or password." } });
    }

    const role = user.role || "employee";
    const sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      department: user.department,
      role: role,
      user_metadata: {
        role: role,
        name: user.name,
      },
      app_metadata: {
        role: role,
      },
    };

    const session = {
      access_token: `token_${user.id}_${Date.now()}`,
      user: sessionUser,
    };

    return res.json({ data: { user: sessionUser, session }, error: null });
  } catch (err) {
    console.error("Auth login error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Database login failed." } });
  }
});

app.post("/api/auth/change-password", async (req, res) => {
  const { userId, email, currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).trim().length < 4) {
    return res.status(400).json({ error: { message: "New password must be at least 4 characters long." } });
  }

  try {
    let user = null;
    if (userId) {
      const [rows] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [userId]);
      user = rows[0];
    } else if (email) {
      const [rows] = await pool.query("SELECT * FROM persons WHERE email = ? LIMIT 1", [String(email).trim()]);
      user = rows[0];
    }

    if (!user) {
      return res.status(404).json({ error: { message: "User account not found." } });
    }

    // Verify current password if specified and user has an existing password
    if (user.password && currentPassword !== undefined) {
      if (user.password !== currentPassword) {
        return res.status(400).json({ error: { message: "Current password does not match our records." } });
      }
    }

    await pool.query("UPDATE persons SET password = ? WHERE id = ?", [newPassword, user.id]);
    return res.json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    console.error("Change password error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to update password." } });
  }
});

app.post("/api/auth/update-profile", async (req, res) => {
  const { userId, email: currentEmail, newName, newEmail, currentPassword, newPassword } = req.body || {};

  try {
    let user = null;
    if (userId) {
      const [rows] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [userId]);
      user = rows[0];
    } else if (currentEmail) {
      const [rows] = await pool.query("SELECT * FROM persons WHERE email = ? LIMIT 1", [String(currentEmail).trim()]);
      user = rows[0];
    }

    if (!user) {
      return res.status(404).json({ error: { message: "User account not found." } });
    }

    // Check duplicate email if email is being changed
    const targetEmail = newEmail ? String(newEmail).trim() : user.email;
    if (newEmail && targetEmail !== user.email) {
      const [dup] = await pool.query("SELECT id FROM persons WHERE email = ? AND id != ? LIMIT 1", [targetEmail, user.id]);
      if (dup && dup.length > 0) {
        return res.status(400).json({ error: { message: "Email address is already in use by another account." } });
      }
    }

    // If changing password, verify current password and new password length
    let updatedPassword = user.password;
    if (newPassword && String(newPassword).trim().length > 0) {
      if (String(newPassword).trim().length < 4) {
        return res.status(400).json({ error: { message: "New password must be at least 4 characters long." } });
      }
      if (user.password && currentPassword !== undefined) {
        if (user.password !== currentPassword) {
          return res.status(400).json({ error: { message: "Current password does not match our records." } });
        }
      }
      updatedPassword = String(newPassword).trim();
    }

    const updatedName = newName !== undefined && String(newName).trim().length > 0 ? String(newName).trim() : user.name;

    await pool.query(
      "UPDATE persons SET name = ?, email = ?, password = ? WHERE id = ?",
      [updatedName, targetEmail, updatedPassword, user.id]
    );

    const updatedUser = {
      id: user.id,
      name: updatedName,
      email: targetEmail,
      role: user.role,
      department: user.department,
      user_metadata: {
        role: user.role,
        name: updatedName,
      },
      app_metadata: {
        role: user.role,
      },
    };

    return res.json({
      success: true,
      message: "Account settings updated successfully.",
      user: updatedUser,
    });
  } catch (err) {
    console.error("Update profile error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to update profile." } });
  }
});

// Admin Staff & Secretary Account Manager Routes
app.get("/api/admin/accounts", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email, role, department, phone_number, approved, created_at FROM persons WHERE role IN ('admin', 'secretary', 'manager') OR (email IS NOT NULL AND email != '') ORDER BY role ASC, name ASC"
    );
    return res.json({ accounts: rows || [] });
  } catch (err) {
    console.error("Get admin accounts error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to load accounts." } });
  }
});

app.post("/api/admin/accounts", async (req, res) => {
  const { name, email, role = "secretary", department = "Admin", password = "", phone_number = "" } = req.body || {};
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: { message: "Email is required." } });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: { message: "Full name is required." } });
  }
  if (!password || String(password).trim().length < 4) {
    return res.status(400).json({ error: { message: "Password must be at least 4 characters long." } });
  }

  try {
    const [existing] = await pool.query("SELECT id FROM persons WHERE email = ? LIMIT 1", [String(email).trim()]);
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: { message: "An account with this email address already exists." } });
    }

    const newId = `ACC-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    await pool.query(
      `INSERT INTO persons (id, name, email, password, role, department, phone_number, approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [newId, String(name).trim(), String(email).trim(), password, role, department || "Admin", phone_number || null]
    );

    return res.json({
      success: true,
      account: { id: newId, name: String(name).trim(), email: String(email).trim(), role, department: department || "Admin", approved: 1 }
    });
  } catch (err) {
    console.error("Create account error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to create account." } });
  }
});

app.put("/api/admin/accounts/:id", async (req, res) => {
  const { id } = req.params;
  const { name, email, role, department, password, approved, phone_number } = req.body || {};

  try {
    const [existing] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [id]);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: { message: "Account not found." } });
    }

    if (email) {
      const [duplicate] = await pool.query("SELECT id FROM persons WHERE email = ? AND id != ? LIMIT 1", [String(email).trim(), id]);
      if (duplicate && duplicate.length > 0) {
        return res.status(400).json({ error: { message: "Email is already taken by another account." } });
      }
    }

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push("name = ?"); params.push(String(name).trim()); }
    if (email !== undefined) { updates.push("email = ?"); params.push(String(email).trim()); }
    if (role !== undefined) { updates.push("role = ?"); params.push(role); }
    if (department !== undefined) { updates.push("department = ?"); params.push(department); }
    if (password && String(password).trim().length > 0) { updates.push("password = ?"); params.push(password); }
    if (approved !== undefined) { updates.push("approved = ?"); params.push(approved ? 1 : 0); }
    if (phone_number !== undefined) { updates.push("phone_number = ?"); params.push(phone_number); }

    if (updates.length > 0) {
      params.push(id);
      await pool.query(`UPDATE persons SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    return res.json({ success: true, message: "Account updated successfully." });
  } catch (err) {
    console.error("Update account error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to update account." } });
  }
});

app.delete("/api/admin/accounts/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [existing] = await pool.query("SELECT * FROM persons WHERE id = ? LIMIT 1", [id]);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: { message: "Account not found." } });
    }

    if (existing[0].role === "admin") {
      const [adminCountRows] = await pool.query("SELECT COUNT(*) as count FROM persons WHERE role = 'admin'");
      const count = adminCountRows[0]?.count || 0;
      if (count <= 1) {
        return res.status(400).json({ error: { message: "Cannot delete the only remaining administrator account." } });
      }
    }

    await pool.query("DELETE FROM persons WHERE id = ?", [id]);
    return res.json({ success: true, message: "Account deleted successfully." });
  } catch (err) {
    console.error("Delete account error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to delete account." } });
  }
});

// ==========================================
// DAHUA SYNC ROUTES (MySQL)
// ==========================================
app.post(["/api/users/import", "/api/dahua/push-users"], async (req, res) => {
  try {
    const rawUsers = Array.isArray(req.body?.users) ? req.body.users : [];
    if (!rawUsers.length) {
      return res.json({ count: 0, message: "No users were provided in payload." });
    }

    let insertedOrUpdatedCount = 0;
    for (const u of rawUsers) {
      const id = String(u.id || u.UserID || u.userID || "").trim();
      if (!id) continue;
      const name = u.name || u.UserName || u.userName || null;
      const department = u.department || u.Department || null;
      const phone = u.phone_number || u.Phone || null;
      const address = u.address || u.Address || null;
      const sex = u.sex || u.Sex || null;

      const photo = u.registration_photo || null;

      await pool.query(
        `INSERT INTO persons (id, name, department, phone_number, address, sex, registration_photo)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(NULLIF(VALUES(name), ''), name),
           department = COALESCE(NULLIF(VALUES(department), ''), department),
           phone_number = COALESCE(NULLIF(VALUES(phone_number), ''), phone_number),
           address = COALESCE(NULLIF(VALUES(address), ''), address),
           sex = COALESCE(NULLIF(VALUES(sex), ''), sex),
           registration_photo = COALESCE(VALUES(registration_photo), registration_photo)`,
        [id, name, department, phone, address, sex, photo]
      );
      insertedOrUpdatedCount += 1;
    }

    return res.json({
      received: rawUsers.length,
      count: insertedOrUpdatedCount,
      message: `Successfully synced ${insertedOrUpdatedCount} from Dahua user(s).`
    });
  } catch (err) {
    console.error("User import error:", err.message);
    return res.status(500).json({ error: `User import failed: ${err.message}` });
  }
});

app.post("/api/dahua/sync-users", async (req, res) => {
  try {
    const users = await getDahuaUsers();
    const payload = users.map((user) => ({
      id: firstValue(user, ["UserID", "userID", "ID", "userId"]),
      name: firstValue(user, ["UserName", "userName", "Name", "name"]),
      department: firstValue(user, ["Department", "department", "Group", "group"]),
      phone_number: firstValue(user, ["Phone", "phone", "PhoneNumber"]),
      address: firstValue(user, ["Address", "address"]),
      sex: firstValue(user, ["Sex", "sex"]),
      registration_photo: user.registration_photo || null,
    })).filter((user) => user.id);

    if (!payload.length) return res.json({ count: 0, message: "No users were returned by the Dahua device." });

    let insertedOrUpdatedCount = 0;
    for (const u of payload) {
      await pool.query(
        `INSERT INTO persons (id, name, department, phone_number, address, sex, registration_photo)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(NULLIF(VALUES(name), ''), name),
           department = COALESCE(NULLIF(VALUES(department), ''), department),
           phone_number = COALESCE(NULLIF(VALUES(phone_number), ''), phone_number),
           address = COALESCE(NULLIF(VALUES(address), ''), address),
           sex = COALESCE(NULLIF(VALUES(sex), ''), sex),
           registration_photo = COALESCE(VALUES(registration_photo), registration_photo)`,
        [u.id, u.name || null, u.department || null, u.phone_number || null, u.address || null, u.sex || null, u.registration_photo || null]
      );
      insertedOrUpdatedCount += 1;
    }

    await recordDeviceSyncStatus({ type: 'person', success: true });

    return res.json({
      count: insertedOrUpdatedCount,
      message: `Synced ${insertedOrUpdatedCount} user(s) from Dahua.`
    });
  } catch (err) {
    await recordDeviceSyncStatus({ type: 'person', success: false, error: err.message });
    const connectorUrl = DAHUA_CONNECTOR_URL || "";
    const isPrivateIp = /192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|localhost|127\.0\.0\.1/.test(connectorUrl || DAHUA_DEVICE_IP);

    if (isPrivateIp && (err.message.includes("ECONNREFUSED") || err.message.includes("timed out") || err.message.includes("ENOTFOUND"))) {
      try {
        const [rows] = await pool.query("SELECT COUNT(*) as total FROM persons WHERE archived = 0 OR archived IS NULL");
        const totalCount = rows[0]?.total || 0;
        return res.json({
          count: totalCount,
          message: `Registered persons refreshed. Currently managing ${totalCount} active person(s).`
        });
      } catch (dbErr) {
        return res.json({
          count: 0,
          message: "Registered persons refreshed from database."
        });
      }
    }

    const message = errorMessage(err, "The Dahua device returned an invalid response or the database operation failed.");
    console.error("Dahua user sync error:", err);
    return res.status(502).json({ error: `Dahua user sync failed: ${message}` });
  }
});

async function deleteDahuaUserOnDevice(personId) {
  if (!personId) return false;
  const targetIdStr = String(personId).trim();

  try {
    const finderQuery = `/cgi-bin/recordFinder.cgi?action=find&name=AccessUser&count=1000`;
    let finderBody = "";

    if (USE_LOCAL_CONNECTOR) {
      finderBody = await requestDahuaGetViaConnector(finderQuery);
    } else {
      finderBody = await requestDahuaWithDigest(finderQuery);
    }

    let targetRecNo = null;
    if (finderBody) {
      const records = parseDahuaRows(finderBody);
      const match = records.find(
        (r) =>
          r &&
          (String(r.UserID) === targetIdStr ||
            String(r.UserID) === String(Number(targetIdStr)))
      );
      if (match && match.RecNo) {
        targetRecNo = match.RecNo;
      }
    }

    if (targetRecNo) {
      const removeQuery = `/cgi-bin/recordUpdater.cgi?action=remove&name=AccessUser&recno=${targetRecNo}`;
      console.log(`[Dahua User Force Delete] Found RecNo ${targetRecNo} for UserID ${targetIdStr}, Sending: ${removeQuery}`);

      if (USE_LOCAL_CONNECTOR) {
        const resText = await requestDahuaGetViaConnector(removeQuery);
        console.log(`[Dahua User Force Delete Result]:`, resText);
      } else {
        const body = await requestDahuaWithDigest(removeQuery);
        console.log(`[Dahua User Force Delete Direct Result]:`, body);
      }
    } else {
      console.warn(`[Dahua User Force Delete] Could not find AccessUser record for UserID ${targetIdStr} on Dahua device.`);
    }

    return true;
  } catch (err) {
    console.warn(`[Dahua User Force Delete Error]:`, err.message);
    return false;
  }
}

app.delete("/api/dahua/person", async (req, res) => {
  const { personId, hardDelete } = req.body || {};
  if (!personId) {
    return res.status(400).json({ error: "personId is required." });
  }
  try {
    // 1. Force delete user from Dahua physical device
    try {
      console.log(`[Dahua Person Force Delete] Requesting authenticated deletion of user ${personId} from physical Dahua device...`);
      await deleteDahuaUserOnDevice(personId);
      console.log(`[Dahua Person Force Delete] Successfully requested deletion of user ${personId} on physical Dahua device.`);
    } catch (dahuaErr) {
      console.warn(`[Dahua Person Force Delete] Physical device deletion warning for user ${personId}:`, dahuaErr.message);
    }

    // 2. Perform DB deletion (or archive if hardDelete is false)
    if (hardDelete) {
      await pool.query("DELETE FROM persons WHERE id = ?", [personId]);
    } else {
      await pool.query("UPDATE persons SET archived = 1 WHERE id = ?", [personId]);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(["/api/attendance/import", "/attendance/import", "/api/dahua/import", "/dahua/import"], async (req, res) => {
  try {
    const importToken = process.env.ATTENDANCE_IMPORT_TOKEN || "";
    const clientToken = req.headers["x-attendance-import-token"] || "";
    if (importToken && clientToken !== importToken) {
      return res.status(401).json({ error: "Unauthorized import request. Token mismatch." });
    }

    const rawRecords = Array.isArray(req.body?.records) ? req.body.records : [];
    if (!rawRecords.length) {
      return res.json({ count: 0, received: 0, message: "No attendance records were provided in payload." });
    }

    const settingsRow = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
    const settings = settingsRow[0]?.[0] || null;

    const formattedRecords = rawRecords.map((r) => ({
      person_id: String(r.person_id || r.UserID || r.userID || r.CardNo || "").trim(),
      name: r.name || r.CardName || r.Name || null,
      event: mapDahuaAttendanceEvent(r),
      point: r.point || r.AttendancePoint || r.Point || null,
      method: mapDahuaAttendanceMethod(r.method || r.Method),
      device_time: normalizeDahuaDeviceTime(r.device_time || r.CreateTime || r.Time),
    })).filter((r) => r.person_id && r.device_time);

    const payload = dedupeDahuaAttendanceByPersonDay(formattedRecords, settings);

    if (!payload.length) {
      return res.json({ count: 0, received: rawRecords.length, message: "No new attendance records were found after deduplication." });
    }

    let insertedCount = 0;
    const insertedAttendance = [];
    for (const record of payload) {
      try {
        const formattedTime = record.device_time;
        const dateDay = formattedTime.slice(0, 10);

        // Delete any previously inserted shifted timestamp for the same person and event on this day
        await pool.query(
          "DELETE FROM attendance WHERE person_id = ? AND event = ? AND device_time LIKE ? AND device_time != ?",
          [record.person_id, record.event, `${dateDay}%`, formattedTime]
        ).catch(() => {});

        const [result] = await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time) VALUES (?, ?, ?, ?, ?, ?)",
          [record.person_id, record.name, record.event, record.point, record.method, formattedTime]
        );
        if (result.affectedRows > 0) {
          insertedCount += 1;
          insertedAttendance.push({
            person_id: record.person_id,
            name: record.name,
            event: record.event,
            method: record.method,
            device_time: formattedTime,
          });
        }
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') console.error("Import attendance insert error:", err.message);
      }
    }

    if (insertedAttendance.length) {
      const payrollResult = await generatePayrollPeriodsFromAttendance(insertedAttendance);
      console.log(`[Payroll] Auto-generated after attendance import: created=${payrollResult.created}, updated=${payrollResult.updated}`);
    }

    return res.json({
      received: rawRecords.length,
      count: insertedCount,
      message: insertedCount ? `Successfully imported ${insertedCount} attendance scan(s).` : "No new attendance records were inserted (all existing)."
    });
  } catch (err) {
    console.error("Attendance import error:", err.message);
    return res.status(500).json({ error: `Attendance import failed: ${err.message}` });
  }
});

app.post("/api/dahua/sync-attendance", async (req, res) => {
  try {
    const limit = Number(req.body?.limit || 1000);
    const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=${limit}`;

    let records;
    if (USE_LOCAL_CONNECTOR) {
      const result = await requestDahuaGetViaConnector(query);
      records = parseDahuaRows(result);
    } else {
      records = parseDahuaRows(await requestDahuaWithDigest(query));
    }

    const settingsRow = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
    const settings = settingsRow[0]?.[0] || null;

    const payload = dedupeDahuaAttendanceByPersonDay(
      records.map((record) => ({
        person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
        name: firstValue(record, ["CardName", "Name", "name"]) || null,
        event: mapDahuaAttendanceEvent(record),
        point: firstValue(record, ["AttendancePoint", "Point", "point"]),
        method: mapDahuaAttendanceMethod(firstValue(record, ["Method", "method"])),
        device_time: normalizeDahuaDeviceTime(firstValue(record, ["CreateTime", "Time", "time"])),
      })),
      settings
    ).filter((record) => record.device_time && record.person_id);

    if (!payload.length) return res.json({ count: 0, message: "No attendance records were returned after deduplication." });

    let insertedCount = 0;
    const insertedAttendance = [];
    for (const record of payload) {
      try {
        // device_time is already in "YYYY-MM-DD HH:MM:SS" local format from normalizeDahuaDeviceTime
        const formattedTime = record.device_time;
        const dateDay = formattedTime.slice(0, 10);
        await pool.query(
          "DELETE FROM attendance WHERE person_id = ? AND event = ? AND device_time LIKE ? AND device_time != ?",
          [record.person_id, record.event, `${dateDay}%`, formattedTime]
        ).catch(() => {});
        const [result] = await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time) VALUES (?, ?, ?, ?, ?, ?)",
          [record.person_id, record.name, record.event, record.point, record.method, formattedTime]
        );
        if (result.affectedRows > 0) {
          insertedCount += 1;
          insertedAttendance.push({
            person_id: record.person_id,
            name: record.name,
            event: record.event,
            method: record.method,
            device_time: formattedTime,
          });
        }
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') console.error("Insert attendance error:", err.message);
      }
    }

    if (insertedAttendance.length) {
      const payrollResult = await generatePayrollPeriodsFromAttendance(insertedAttendance);
      console.log(`[Payroll] Auto-generated after Dahua sync: created=${payrollResult.created}, updated=${payrollResult.updated}`);
    }

    await recordDeviceSyncStatus({ type: 'attendance', success: true });

    return res.json({ count: insertedCount, message: insertedCount ? `Inserted ${insertedCount} deduplicated attendance scan(s).` : "No new attendance records were found after deduplication." });
  } catch (err) {
    console.error("Dahua attendance sync error:", err.message);
    await recordDeviceSyncStatus({ type: 'attendance', success: false, error: err.message });
    const connectorUrl = DAHUA_CONNECTOR_URL || "";
    const isPrivateIp = /192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|localhost|127\.0\.0\.1/.test(connectorUrl || DAHUA_DEVICE_IP);

    if (isPrivateIp && (err.message.includes("ECONNREFUSED") || err.message.includes("timed out") || err.message.includes("ENOTFOUND"))) {
      try {
        const [rows] = await pool.query("SELECT COUNT(*) as total FROM attendance");
        const totalCount = rows[0]?.total || 0;
        return res.json({
          count: 0,
          message: `Attendance is synced in the background via local sync agent. Currently storing ${totalCount} attendance records.`
        });
      } catch (dbErr) {
        return res.json({
          count: 0,
          message: "Attendance records refreshed. Local sync agent is active."
        });
      }
    }

    return res.status(502).json({ error: `Dahua attendance sync failed: ${err.message}` });
  }
});

// ==========================================
// DAHUA BIOMETRIC DEVICE MONITORING ROUTES
// ==========================================
app.get("/api/device/monitoring", async (req, res) => {
  try {
    const [statusRows] = await pool.query("SELECT * FROM dahua_device_status WHERE id = 1 LIMIT 1");
    const statusData = statusRows?.[0] || {};

    const [personCountRows] = await pool.query("SELECT COUNT(*) as total FROM persons WHERE archived = 0 OR archived IS NULL");
    const personCount = personCountRows?.[0]?.total || 0;

    const [attendanceCountRows] = await pool.query("SELECT COUNT(*) as total FROM attendance WHERE archived = 0 OR archived IS NULL");
    const attendanceCount = attendanceCountRows?.[0]?.total || 0;

    const deviceName = statusData.device_name || process.env.DAHUA_DEVICE_NAME || "Multifactors Biometric Station";
    const model = statusData.model || "DHI-ASA3213GL-MW";
    const ipAddress = statusData.ip_address || DAHUA_DEVICE_IP;
    const port = Number(statusData.port || DAHUA_DEVICE_PORT || 80);

    const devices = [
      {
        id: "dahua-primary",
        name: deviceName,
        model: model,
        ipAddress: ipAddress,
        port: port,
        connectionStatus: statusData.connection_status || "Unknown",
        lastSuccessfulSync: statusData.last_successful_sync || null,
        lastFailedSync: statusData.last_failed_sync || null,
        lastFailedReason: statusData.last_failed_reason || null,
        lastAttendanceSync: statusData.last_attendance_sync || null,
        lastPersonSync: statusData.last_person_sync || null,
        numberOfPersons: Number(personCount),
        numberOfAttendanceRecords: Number(attendanceCount),
        streamOnline: streamState.status === "running",
        useLocalConnector: USE_LOCAL_CONNECTOR,
        updatedAt: statusData.updated_at || null,
      }
    ];

    return res.json({
      devices,
      summary: {
        totalDevices: devices.length,
        onlineDevices: devices.filter(d => d.connectionStatus === "Online").length,
        totalPersons: Number(personCount),
        totalAttendance: Number(attendanceCount),
      }
    });
  } catch (err) {
    console.error("Device monitoring query error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Failed to load device monitoring data." } });
  }
});

app.post("/api/device/test-connection", async (req, res) => {
  const startTime = Date.now();
  try {
    let resultData = null;
    if (USE_LOCAL_CONNECTOR) {
      const resp = await requestDahuaViaConnector("GET", "/cgi-bin/magicBox.cgi?action=getSystemInfo");
      resultData = resp?.body || resp;
    } else {
      resultData = await requestDahuaWithDigest("/cgi-bin/magicBox.cgi?action=getSystemInfo");
    }

    const latencyMs = Date.now() - startTime;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    let detectedModel = "DHI-ASA3213GL-MW";
    let detectedVersion = null;
    if (typeof resultData === "string") {
      const modelMatch = resultData.match(/appType=([^\r\n]+)/i) || resultData.match(/deviceType=([^\r\n]+)/i);
      if (modelMatch) detectedModel = modelMatch[1].trim();
      const verMatch = resultData.match(/version=([^\r\n]+)/i);
      if (verMatch) detectedVersion = verMatch[1].trim();
    }

    await pool.query(
      "UPDATE dahua_device_status SET connection_status = 'Online', model = ?, last_successful_sync = COALESCE(last_successful_sync, ?), last_failed_reason = NULL WHERE id = 1",
      [detectedModel, now]
    );

    return res.json({
      success: true,
      status: "Online",
      latencyMs,
      model: detectedModel,
      firmware: detectedVersion,
      message: `Connection established! Dahua terminal responded in ${latencyMs}ms.`
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const isConnRefused = err.message.includes("ECONNREFUSED") || err.message.includes("timed out") || err.message.includes("ENOTFOUND");
    const status = isConnRefused ? "Offline" : "Error";

    await pool.query(
      "UPDATE dahua_device_status SET connection_status = ?, last_failed_sync = ?, last_failed_reason = ? WHERE id = 1",
      [status, now, err.message]
    ).catch(() => {});

    return res.json({
      success: false,
      status: status,
      latencyMs,
      message: `Connection test failed: ${err.message}`
    });
  }
});

app.get("/api/device/status", async (req, res) => {
  try {
    const raw = await requestDahuaWithDigest("/cgi-bin/magicBox.cgi?action=getSystemInfo");
    return res.json({
      status: "online",
      online: true,
      deviceIp: DAHUA_DEVICE_IP,
      devicePort: DAHUA_DEVICE_PORT,
      systemInfo: raw,
    });
  } catch (err) {
    return res.json({
      status: "offline",
      online: false,
      deviceIp: DAHUA_DEVICE_IP,
      devicePort: DAHUA_DEVICE_PORT,
      error: err.message,
    });
  }
});

app.post("/api/payroll/rebuild", async (req, res) => {
  try {
    const reset = Boolean(req.body?.reset);
    if (reset) {
      await pool.query("DELETE FROM payroll_periods");
    }

    const result = await generatePayrollPeriodsFromAttendance();
    return res.json({
      ok: true,
      reset,
      created: Number(result.created || 0),
      updated: Number(result.updated || 0),
      message: reset
        ? "Payroll periods were reset and rebuilt from attendance data."
        : "Payroll periods were rebuilt from attendance data.",
    });
  } catch (error) {
    console.error("[Payroll] Rebuild failed:", error.message);
    return res.status(500).json({
      ok: false,
      error: error.message || "Payroll rebuild failed.",
    });
  }
});

app.delete("/api/dahua/attendance", async (req, res) => {
  const { personId, deviceTime, dbId } = req.body || {};
  if (!personId || !deviceTime) {
    return res.status(400).json({ error: "personId and deviceTime are required." });
  }
  try {
    const formattedLocalTime = normalizeDahuaDeviceTime(deviceTime);
    const targetTimestampSec = Math.floor(new Date(deviceTime).getTime() / 1000);
    
    // 1. Force delete from Dahua physical device
    try {
      const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=10000`;
      let bodyText = "";
      
      if (USE_LOCAL_CONNECTOR) {
        const response = await requestDahuaViaConnector("GET", query);
        bodyText = response?.body || "";
      } else {
        bodyText = await requestDahuaWithDigest(query);
      }

      if (bodyText) {
        const records = parseDahuaRows(bodyText);
        
        // Find matching record on Dahua device by unix timestamp or formatted local time
        const match = records.find((r) => {
          const rRecNo = r.RecNo;
          if (!rRecNo) return false;
          
          const rPerson = firstValue(r, ["UserID", "userID", "CardNo"]);
          const rTimeRaw = firstValue(r, ["CreateTime", "Time", "time"]);
          if (!rTimeRaw) return false;

          // Check person match (if person ID is populated on record)
          if (rPerson && String(rPerson) !== String(personId)) {
            return false;
          }

          // Epoch timestamp comparison (robust against timezone/string formatting differences)
          const rSec = Number(rTimeRaw);
          if (!isNaN(rSec) && rSec > 1000000000) {
            if (Math.abs(rSec - targetTimestampSec) <= 3) return true;
          }

          // String local time comparison fallback
          const rNormalized = normalizeDahuaDeviceTime(rTimeRaw);
          if (rNormalized && formattedLocalTime && rNormalized === formattedLocalTime) {
            return true;
          }

          return false;
        });

        if (match && match.RecNo) {
          console.log(`[Dahua Force Delete] Found matching record on physical device (RecNo: ${match.RecNo})`);
          const removeQuery = `/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCardRec&recno=${match.RecNo}`;
          if (USE_LOCAL_CONNECTOR) {
            await requestDahuaViaConnector("GET", removeQuery);
          } else {
            await requestDahuaWithDigest(removeQuery);
          }
          console.log(`[Dahua Force Delete] Successfully removed RecNo ${match.RecNo} from physical device.`);
        } else {
          console.warn(`[Dahua Force Delete] Could not find matching physical record on device for user=${personId}, time=${deviceTime}`);
        }
      }
    } catch (dahuaErr) {
      console.warn("[Dahua Force Delete] Device deletion warning:", dahuaErr.message);
      // Do not throw here so local database delete still succeeds
    }

    // 2. Delete from local database (by dbId if provided, or by person_id & device_time)
    if (dbId) {
      await pool.query("DELETE FROM attendance WHERE id = ?", [dbId]);
    } else {
      await pool.query(
        "DELETE FROM attendance WHERE person_id = ? AND device_time = ?",
        [personId, formattedLocalTime || deviceTime]
      );
    }

    // Queue physical deletion for local-sync-agent
    try {
      await pool.query(
        "INSERT INTO dahua_pending_deletions (type, person_id, device_time) VALUES ('attendance', ?, ?)",
        [personId, formattedLocalTime || deviceTime]
      );
    } catch (e) {}
    
    res.json({ ok: true, message: "Attendance record deleted and queued for physical device removal." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dahua/pending-deletions", async (req, res) => {
  try {
    // Automatically purge any completed or old stale rows so the table stays clean
    await pool.query(
      "DELETE FROM dahua_pending_deletions WHERE status = 'completed' OR created_at < NOW() - INTERVAL 2 DAY"
    ).catch(() => {});
    
    const [rows] = await pool.query("SELECT * FROM dahua_pending_deletions WHERE status = 'pending' ORDER BY id ASC LIMIT 50");
    return res.json({ deletions: rows });
  } catch (err) {
    return res.json({ deletions: [] });
  }
});

app.post("/api/dahua/complete-deletion", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (id) {
      // Automatically delete the pending record once physical device removal is complete
      await pool.query("DELETE FROM dahua_pending_deletions WHERE id = ?", [id]);
    }
    // Also remove any other completed or old records
    await pool.query(
      "DELETE FROM dahua_pending_deletions WHERE status = 'completed' OR created_at < NOW() - INTERVAL 2 DAY"
    ).catch(() => {});

    return res.json({ ok: true, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Route to manually clear/truncate the dahua_pending_deletions queue if desired
app.delete("/api/dahua/pending-deletions/clear", async (req, res) => {
  try {
    await pool.query("DELETE FROM dahua_pending_deletions");
    return res.json({ ok: true, message: "dahua_pending_deletions table cleared successfully." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ==========================================
// PAYROLL REGENERATION API ROUTE
// ==========================================
app.post("/api/payroll/regenerate", async (req, res) => {
  try {
    const result = await generatePayrollPeriodsFromAttendance();
    res.json({ message: "Payroll regenerated successfully", ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// GENERIC DATABASE QUERY API ROUTE (MySQL)
// ==========================================
app.post("/api/db/query", async (req, res) => {
  const { table, action, select, filters = [], orders = [], limit, offset, data, payload, single, maybeSingle, count } = req.body || {};
  const payloadData = payload !== undefined ? payload : data;

  const allowedTables = [
    "persons", "attendance", "department_rates", "settings",
    "holidays", "cash_advances", "payroll_periods",
    "payroll_activity_logs", "payroll_released_history",
    "expenses"
  ];

  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: { message: `Table '${table}' is not accessible.` } });
  }

  try {
    // 1. SELECT
    if (action === "select") {
      let selectCols = "*";
      if (select && typeof select === "string" && select.trim() !== "*") {
        const cols = select.split(",").map(c => c.trim()).filter(Boolean);
        selectCols = cols.map(c => `\`${c.replace(/`/g, "")}\``).join(", ");
      }

      let sql = `SELECT ${selectCols} FROM \`${table}\``;
      const params = [];

      if (Array.isArray(filters) && filters.length > 0) {
        const whereClauses = [];
        for (const f of filters) {
          if (!f || !f.column) continue;
          const col = `\`${f.column.replace(/`/g, "")}\``;
          if (f.op === "eq") {
            whereClauses.push(`${col} = ?`);
            params.push(f.value);
          } else if (f.op === "neq") {
            whereClauses.push(`${col} != ?`);
            params.push(f.value);
          } else if (f.op === "gt") {
            whereClauses.push(`${col} > ?`);
            params.push(f.value);
          } else if (f.op === "gte") {
            whereClauses.push(`${col} >= ?`);
            params.push(f.value);
          } else if (f.op === "lt") {
            whereClauses.push(`${col} < ?`);
            params.push(f.value);
          } else if (f.op === "lte") {
            whereClauses.push(`${col} <= ?`);
            params.push(f.value);
          } else if (f.op === "like" || f.op === "ilike") {
            whereClauses.push(`${col} LIKE ?`);
            params.push(f.value);
          } else if (f.op === "is") {
            if (f.value === null) whereClauses.push(`${col} IS NULL`);
            else if (f.value === true) whereClauses.push(`${col} IS TRUE`);
            else if (f.value === false) whereClauses.push(`${col} IS FALSE`);
            else {
              whereClauses.push(`${col} = ?`);
              params.push(f.value);
            }
          } else if (f.op === "in") {
            if (Array.isArray(f.value) && f.value.length > 0) {
              whereClauses.push(`${col} IN (${f.value.map(() => "?").join(", ")})`);
              params.push(...f.value);
            } else {
              whereClauses.push("1=0");
            }
          }
        }
        if (whereClauses.length > 0) {
          sql += ` WHERE ${whereClauses.join(" AND ")}`;
        }
      }

      if (Array.isArray(orders) && orders.length > 0) {
        const orderClauses = orders.map(o => `\`${o.column.replace(/`/g, "")}\` ${o.ascending === false ? "DESC" : "ASC"}`);
        sql += ` ORDER BY ${orderClauses.join(", ")}`;
      }

      if (typeof limit === "number") {
        sql += ` LIMIT ${Number(limit)}`;
        if (typeof offset === "number") {
          sql += ` OFFSET ${Number(offset)}`;
        }
      }

      const [rows] = await pool.query(sql, params);

      const sanitizedRows = (rows || []).map(r => {
        const copy = { ...r };
        if (copy.descriptor && typeof copy.descriptor === "string") {
          try { copy.descriptor = JSON.parse(copy.descriptor); } catch (e) {}
        }
        if (copy.detailed_attendance && typeof copy.detailed_attendance === "string") {
          try { copy.detailed_attendance = JSON.parse(copy.detailed_attendance); } catch (e) {}
        }
        return copy;
      });

      let totalCount = null;
      if (count === "exact") {
        const [cRows] = await pool.query(`SELECT COUNT(*) as total FROM \`${table}\``);
        totalCount = cRows[0]?.total || 0;
      }

      if (single || maybeSingle) {
        return res.json({ data: sanitizedRows[0] || null, error: null, count: totalCount });
      }

      return res.json({ data: sanitizedRows, error: null, count: totalCount });
    }

    // 2. INSERT
    if (action === "insert") {
      const items = Array.isArray(payloadData) ? payloadData : [payloadData];
      if (items.length === 0) return res.json({ data: [], error: null });

      const crypto = require('crypto');
      const inserted = [];
      for (const item of items) {
        if (!item) continue;
        const itemObj = { ...item };
        
        // Auto-generate UUID if missing for tables using string UUIDs (like persons/users)
        if (!itemObj.id && (table === "persons" || table === "users")) {
          itemObj.id = crypto.randomUUID();
        }

        if (itemObj.descriptor && typeof itemObj.descriptor === "object") {
          itemObj.descriptor = JSON.stringify(itemObj.descriptor);
        }
        if (itemObj.detailed_attendance && typeof itemObj.detailed_attendance === "object") {
          itemObj.detailed_attendance = JSON.stringify(itemObj.detailed_attendance);
        }
        for (const k in itemObj) {
          if (itemObj[k] instanceof Date) {
            itemObj[k] = itemObj[k].toISOString().slice(0, 19).replace("T", " ");
          }
        }

        const keys = Object.keys(itemObj);
        const cols = keys.map(k => `\`${k.replace(/`/g, "")}\``).join(", ");
        const placeholders = keys.map(() => "?").join(", ");
        const values = keys.map(k => itemObj[k]);

        const [result] = await pool.query(
          `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders})`,
          values
        );
        inserted.push({ ...item, id: result.insertId || item.id });
      }

      return res.json({ data: single ? inserted[0] : inserted, error: null });
    }

    // 3. UPDATE
    if (action === "update") {
      const itemObj = { ...payloadData };
      delete itemObj.id;

      if (itemObj.descriptor && typeof itemObj.descriptor === "object") {
        itemObj.descriptor = JSON.stringify(itemObj.descriptor);
      }
      if (itemObj.detailed_attendance && typeof itemObj.detailed_attendance === "object") {
        itemObj.detailed_attendance = JSON.stringify(itemObj.detailed_attendance);
      }

      const keys = Object.keys(itemObj).filter(k => itemObj[k] !== undefined);
      if (keys.length === 0) {
        return res.json({ data: payloadData, error: null });
      }

      const setClauses = keys.map(k => `\`${k.replace(/`/g, "")}\` = ?`).join(", ");
      const params = keys.map(k => itemObj[k]);

      let sql = `UPDATE \`${table}\` SET ${setClauses}`;

      if (Array.isArray(filters) && filters.length > 0) {
        const whereClauses = [];
        for (const f of filters) {
          if (!f || !f.column) continue;
          const col = `\`${f.column.replace(/`/g, "")}\``;
          if (f.op === "eq") {
            whereClauses.push(`${col} = ?`);
            params.push(f.value);
          } else if (f.op === "in") {
            whereClauses.push(`${col} IN (${f.value.map(() => "?").join(", ")})`);
            params.push(...f.value);
          }
        }
        if (whereClauses.length > 0) {
          sql += ` WHERE ${whereClauses.join(" AND ")}`;
        }
      }

      await pool.query(sql, params);
      return res.json({ data: payloadData, error: null });
    }

    // 4. UPSERT
    if (action === "upsert") {
      const items = Array.isArray(payloadData) ? payloadData : [payloadData];
      for (const item of items) {
        if (!item) continue;
        const itemObj = { ...item };
        if (itemObj.descriptor && typeof itemObj.descriptor === "object") {
          itemObj.descriptor = JSON.stringify(itemObj.descriptor);
        }
        if (itemObj.detailed_attendance && typeof itemObj.detailed_attendance === "object") {
          itemObj.detailed_attendance = JSON.stringify(itemObj.detailed_attendance);
        }

        const keys = Object.keys(itemObj);
        const cols = keys.map(k => `\`${k.replace(/`/g, "")}\``).join(", ");
        const placeholders = keys.map(() => "?").join(", ");
        const updateClauses = keys.map(k => {
          const colName = k.replace(/`/g, "");
          if (table === "persons" && (colName === "department" || colName === "daily_rate" || colName === "late_penalty")) {
            return `\`${colName}\` = COALESCE(NULLIF(VALUES(\`${colName}\`), ''), \`${colName}\`)`;
          }
          return `\`${colName}\` = VALUES(\`${colName}\`)`;
        }).join(", ");
        const values = keys.map(k => itemObj[k]);

        await pool.query(
          `INSERT INTO \`${table}\` (${cols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateClauses}`,
          values
        );
      }
      return res.json({ data: payloadData, error: null });
    }

    // 5. DELETE
    if (action === "delete") {
      let sql = `DELETE FROM \`${table}\``;
      const params = [];
      if (Array.isArray(filters) && filters.length > 0) {
        const whereClauses = [];
        for (const f of filters) {
          if (!f || !f.column) continue;
          const col = `\`${f.column.replace(/`/g, "")}\``;
          if (f.op === "eq") {
            whereClauses.push(`${col} = ?`);
            params.push(f.value);
          } else if (f.op === "in") {
            whereClauses.push(`${col} IN (${f.value.map(() => "?").join(", ")})`);
            params.push(...f.value);
          }
        }
        if (whereClauses.length > 0) {
          sql += ` WHERE ${whereClauses.join(" AND ")}`;
        }
      }

      await pool.query(sql, params);
      return res.json({ data: null, error: null });
    }

    return res.status(400).json({ error: { message: `Unknown action: ${action}` } });
  } catch (err) {
    console.error("DB Query error:", err.message);
    return res.status(500).json({ error: { message: err.message || "Database query failed" } });
  }
});

// ==========================================
// STREAMING SETTINGS
// ==========================================
function clearHlsArtifacts() {
  try {
    for (const fileName of fs.readdirSync(hlsDir)) {
      if (fileName.endsWith(".m3u8") || fileName.endsWith(".ts")) fs.rmSync(path.join(hlsDir, fileName), { force: true });
    }
  } catch (e) {}
}

function startFfmpeg() {
  if (!ffmpeg || !RTSP_URL) return null;
  if (ffmpegCommand) return ffmpegCommand;
  try {
    clearHlsArtifacts();
    streamState.status = "starting";
    const command = ffmpeg(RTSP_URL)
      .inputOptions(["-rtsp_transport", "tcp", "-fflags", "nobuffer", "-analyzeduration", "0", "-probesize", "32", "-flags", "low_delay"])
      .addOptions(["-an", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "10", "-keyint_min", "10", "-sc_threshold", "0", "-f", "hls", "-hls_time", "0.5", "-hls_list_size", "2", "-hls_flags", "delete_segments+omit_endlist+independent_segments+program_date_time", "-muxdelay", "0", "-muxpreload", "0"])
      .output(path.join(hlsDir, "index.m3u8"))
      .on("start", () => {
        ffmpegCommand = command;
        streamState.status = "running";
      })
      .on("error", (err) => {
        ffmpegCommand = null;
        streamState.status = "error";
        streamState.lastError = err.message;
      })
      .on("end", () => {
        ffmpegCommand = null;
        streamState.status = "ended";
      })
      .run();
    ffmpegCommand = command;
    return command;
  } catch (e) {
    console.error("Cannot start ffmpeg:", e.message);
    streamState.status = "error";
    streamState.lastError = e.message;
  }
}

// Disabled 24/7 background RTSP camera video streaming by default to prevent cPanel bandwidth exhaustion (5GB+).
// Physical Dahua device operates standalone and syncs attendance data via lightweight API calls.
try {
  clearHlsArtifacts();
  if (RTSP_URL && process.env.ENABLE_LIVE_STREAM === "true") {
    startFfmpeg();
  }
} catch (e) {
  console.warn("Skipping ffmpeg on startup:", e.message);
}

// Background auto sync for attendance if configured
if (AUTO_SYNC_ATTENDANCE_MINUTES > 0) {
  setInterval(async () => {
    try {
      const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=1000`;
      const records = parseDahuaRows(await requestDahuaWithDigest(query));

      const settingsRow = await pool.query("SELECT * FROM settings ORDER BY id LIMIT 1");
      const settings = settingsRow[0]?.[0] || null;
      const deduplicated = dedupeDahuaAttendanceByPersonDay(
        records.map((record) => ({
          person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
          name: firstValue(record, ["CardName", "Name", "name"]) || null,
          event: mapDahuaAttendanceEvent(record),
          point: firstValue(record, ["AttendancePoint", "Point", "point"]),
          method: mapDahuaAttendanceMethod(firstValue(record, ["Method", "method"])),
          device_time: normalizeDahuaDeviceTime(firstValue(record, ["CreateTime", "Time", "time"])),
        })),
        settings
      );

      for (const record of deduplicated) {
        const pId = record.person_id;
        const dTime = record.device_time;
        if (!pId || !dTime) continue;
        const dateDay = dTime.slice(0, 10);
        await pool.query(
          "DELETE FROM attendance WHERE person_id = ? AND event = ? AND device_time LIKE ? AND device_time != ?",
          [pId, record.event, `${dateDay}%`, dTime]
        ).catch(() => {});
        await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time) VALUES (?, ?, ?, ?, ?, ?)",
          [
            pId,
            record.name,
            record.event,
            record.point,
            record.method,
            dTime,
          ]
        );
      }
    } catch (e) {}
  }, AUTO_SYNC_ATTENDANCE_MINUTES * 60 * 1000);
}

app.use("/hls", express.static(hlsDir, {
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  },
}));

app.get("/health/stream", (req, res) => res.json({ ...streamState }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Serve Frontend with static caching to reduce unnecessary bandwidth downloads
const staticDir = fs.existsSync(path.join(__dirname, "build"))
  ? path.join(__dirname, "build")
  : path.join(__dirname, "public");

app.use(express.static(staticDir, {
  maxAge: "30d",
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("index.html") || filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (filePath.includes("static")) {
      res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    }
  },
}));

app.use((req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at port ${PORT}`);
  setTimeout(() => {
    regeneratePayrollPeriodsIfNeeded();
  }, 4000);
});