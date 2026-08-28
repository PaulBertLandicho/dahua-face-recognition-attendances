require("dotenv").config();
require("dotenv").config({ path: ".env.local" });
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
const AUTO_SYNC_ATTENDANCE_MINUTES = Number(process.env.AUTO_SYNC_ATTENDANCE_MINUTES || 0);

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
        timeout: 10000,
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
    request.on("timeout", () => request.destroy(new Error("Dahua request timed out.")));
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

function normalizeDahuaDeviceTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const numeric = Number(text);
  const date = /^\d{10,13}$/.test(text) ? new Date(text.length === 10 ? numeric * 1000 : numeric) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

    return res.json({ count: insertedOrUpdatedCount, message: `Synced ${insertedOrUpdatedCount} users from Dahua device to MySQL database.` });
  } catch (err) {
    console.error("Dahua user sync error:", err.message);
    return res.status(502).json({ error: `Dahua user sync failed: ${err.message}` });
  }
});

app.post("/api/dahua/sync-attendance", async (req, res) => {
  try {
    const limit = Number(req.body?.limit || 1000);
    const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=${limit}`;
    const records = parseDahuaRows(await requestDahuaWithDigest(query));

    const payload = records.map((record) => ({
      person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
      name: firstValue(record, ["CardName", "Name", "name"]) || null,
      event: mapDahuaAttendanceEvent(record),
      point: firstValue(record, ["AttendancePoint", "Point", "point"]),
      method: mapDahuaAttendanceMethod(firstValue(record, ["Method", "method"])),
      device_time: normalizeDahuaDeviceTime(firstValue(record, ["CreateTime", "Time", "time"])),
    })).filter((record) => record.device_time && record.person_id);

    if (!payload.length) return res.json({ count: 0, message: "No attendance records were returned." });

    let insertedCount = 0;
    for (const record of payload) {
      try {
        const formattedTime = new Date(record.device_time).toISOString().slice(0, 19).replace('T', ' ');
        const [result] = await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time) VALUES (?, ?, ?, ?, ?, ?)",
          [record.person_id, record.name, record.event, record.point, record.method, formattedTime]
        );
        if (result.affectedRows > 0) insertedCount += 1;
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') console.error("Insert attendance error:", err.message);
      }
    }
    return res.json({ count: insertedCount, message: insertedCount ? `Inserted ${insertedCount} new attendance scan(s) into MySQL.` : "No new attendance records were found." });
  } catch (err) {
    console.error("Dahua attendance sync error:", err.message);
    return res.status(502).json({ error: `Dahua attendance sync failed: ${err.message}` });
  }
});

app.get("/api/device/status", async (req, res) => {
  try {
    const raw = await requestDahuaWithDigest("/cgi-bin/magicBox.cgi?action=getSystemInfo");
    return res.json({ status: "online", systemInfo: raw });
  } catch (err) {
    return res.json({ status: "offline", error: err.message });
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

      const inserted = [];
      for (const item of items) {
        if (!item) continue;
        const itemObj = { ...item };
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
      for (const record of records) {
        const pId = firstValue(record, ["UserID", "userID", "CardNo"]);
        const dTime = normalizeDahuaDeviceTime(firstValue(record, ["CreateTime", "Time", "time"]));
        if (!pId || !dTime) continue;
        const formattedTime = new Date(dTime).toISOString().slice(0, 19).replace('T', ' ');
        await pool.query(
          "INSERT IGNORE INTO attendance (person_id, name, event, point, method, device_time) VALUES (?, ?, ?, ?, ?, ?)",
          [
            pId,
            firstValue(record, ["CardName", "Name", "name"]) || null,
            mapDahuaAttendanceEvent(record),
            firstValue(record, ["AttendancePoint", "Point", "point"]),
            mapDahuaAttendanceMethod(firstValue(record, ["Method", "method"])),
            formattedTime,
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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at port ${PORT}`);
});