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
});

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
    return `MySQL connection was refused${target}. Check DB_HOST, DB_PORT, and that the MySQL service is running.`;
  }
  if (typeof error === "string" && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch (serializationError) {
    return fallback;
  }
}

function normalizeDahuaDeviceTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const pad = (n) => String(n).padStart(2, "0");

  // Handle unix timestamps (seconds or milliseconds)
  const numeric = Number(text);
  if (/^\d{10,13}$/.test(text)) {
    const ms = text.length === 10 ? numeric * 1000 : numeric;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    // Format using LOCAL time (not UTC) to match device timezone
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // For string timestamps like "2026-09-04 08:15:23" — extract components directly
  // to avoid timezone shifts from Date parsing
  const normalizedText = text.replace(/[\/]/g, "-");
  const match = normalizedText.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4])}:${match[5]}:${match[6]}`;
  }

  // Fallback: try parsing and format using local time components
  const parsed = new Date(normalizedText);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
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

// ==========================================
// DAHUA SYNC ROUTES (MySQL)
// ==========================================
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
    })).filter((user) => user.id);

    if (!payload.length) return res.json({ count: 0, message: "No users were returned by the Dahua device." });

    let insertedOrUpdatedCount = 0;
    for (const u of payload) {
      await pool.query(
        `INSERT INTO persons (id, name, department, phone_number, address, sex)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(VALUES(name), name),
           department = COALESCE(VALUES(department), department),
           phone_number = COALESCE(VALUES(phone_number), phone_number),
           address = COALESCE(VALUES(address), address),
           sex = COALESCE(VALUES(sex), sex)`,
        [u.id, u.name || null, u.department || null, u.phone_number || null, u.address || null, u.sex || null]
      );
      insertedOrUpdatedCount += 1;
    }

  } catch (err) {
    const message = errorMessage(err, "The Dahua device returned an invalid response or the MySQL operation failed.");
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

    return res.json({ count: insertedCount, message: insertedCount ? `Inserted ${insertedCount} deduplicated attendance scan(s) into MySQL.` : "No new attendance records were found after deduplication." });
  } catch (err) {
    console.error("Dahua attendance sync error:", err.message);
    return res.status(502).json({ error: `Dahua attendance sync failed: ${err.message}` });
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
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  const { table, action, select, filters = [], orders = [], limit, offset, data: payloadData, single, maybeSingle, count } = req.body || {};

  const allowedTables = [
    "persons", "attendance", "department_rates", "settings",
    "holidays", "cash_advances", "payroll_periods",
    "payroll_activity_logs", "payroll_released_history"
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
        
        // Auto-generate UUID if missing
        if (!itemObj.id) {
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
      if (itemObj.descriptor && typeof itemObj.descriptor === "object") {
        itemObj.descriptor = JSON.stringify(itemObj.descriptor);
      }
      if (itemObj.detailed_attendance && typeof itemObj.detailed_attendance === "object") {
        itemObj.detailed_attendance = JSON.stringify(itemObj.detailed_attendance);
      }

      const keys = Object.keys(itemObj);
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
        const updateClauses = keys.map(k => `\`${k.replace(/`/g, "")}\` = VALUES(\`${k.replace(/`/g, "")}\`)`).join(", ");
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

try {
  if (RTSP_URL) startFfmpeg();
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
        // device_time is already in "YYYY-MM-DD HH:MM:SS" local format from normalizeDahuaDeviceTime
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

// ==========================================
// SERVE FRONTEND (React Static Build)
// ==========================================
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at port ${PORT}`);
  setTimeout(() => {
    regeneratePayrollPeriodsIfNeeded();
  }, 4000);
});