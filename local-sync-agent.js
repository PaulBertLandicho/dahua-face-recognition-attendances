require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const http = require("http");
const https = require("https");
const crypto = require("crypto");

const CONNECTOR_URL = (process.env.LOCAL_DAHUA_CONNECTOR_URL || "http://localhost:5000").replace(/\/$/, "");
const BACKEND_URL = (process.env.ATTENDANCE_IMPORT_URL || "https://attendance.multifactors-sales.com/api/attendance/import").replace(/\/$/, "");
const IMPORT_TOKEN = process.env.ATTENDANCE_IMPORT_TOKEN || "";
const SYNC_INTERVAL_MS = Number(process.env.LOCAL_SYNC_INTERVAL_MS || 1 * 60 * 1000);
const FETCH_LIMIT = Number(process.env.LOCAL_SYNC_FETCH_LIMIT || 1000);

const DAHUA_DEVICE_IP = process.env.DAHUA_DEVICE_IP || "192.168.111.222";
const DAHUA_DEVICE_PORT = Number(process.env.DAHUA_DEVICE_PORT || 80);
const DAHUA_USERNAME = process.env.DAHUA_USERNAME || "admin";
const DAHUA_PASSWORD = process.env.DAHUA_PASSWORD || "12a34s56d";

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

function requestDahuaDirect(requestPath) {
  const transport = DAHUA_DEVICE_PORT === 443 ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        hostname: DAHUA_DEVICE_IP,
        port: DAHUA_DEVICE_PORT,
        path: requestPath,
        method: "GET",
        timeout: 8000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Timeout connecting to Dahua IP ${DAHUA_DEVICE_IP}`));
    });
    request.on("error", reject);
    request.end();
  });
}

async function requestDahuaDirectWithDigest(requestPath) {
  const first = await requestDahuaDirect(requestPath);
  if (first.statusCode !== 401) return first.body;

  const challengeHeader = first.headers["www-authenticate"];
  if (!challengeHeader) return first.body;

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
  const transport = DAHUA_DEVICE_PORT === 443 ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        hostname: DAHUA_DEVICE_IP,
        port: DAHUA_DEVICE_PORT,
        path: requestPath,
        method: "GET",
        timeout: 8000,
        headers: { Authorization: authorization },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      }
    );
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`Timeout on authenticated request to Dahua IP ${DAHUA_DEVICE_IP}`));
    });
    request.on("error", reject);
    request.end();
  });
}

async function fetchDahuaGet(path) {
  // 1. Try local connector first
  try {
    const connectorRes = await fetch(`${CONNECTOR_URL}/dahua/get?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(3000) });
    if (connectorRes.ok) {
      const text = await connectorRes.text();
      if (text && !text.includes("ECONNREFUSED")) return text;
    }
  } catch (e) {}

  // 2. Direct fallback to Dahua device on LAN
  return await requestDahuaDirectWithDigest(path);
}

async function fetchDahuaRecordFinder(finderName, fetchLimit = 1000) {
  try {
    const findQuery = `/cgi-bin/recordFinder.cgi?action=find&name=${finderName}`;
    const findText = await fetchDahuaGet(findQuery);
    if (!findText) return "";

    const tokenMatch = findText.match(/token=(\d+)/i);
    let recordsText = findText;

    if (tokenMatch && tokenMatch[1]) {
      const token = tokenMatch[1];
      const doFindQuery = `/cgi-bin/recordFinder.cgi?action=doFind&token=${token}&count=${fetchLimit}`;
      recordsText = await fetchDahuaGet(doFindQuery);
      const destroyQuery = `/cgi-bin/recordFinder.cgi?action=destroy&token=${token}`;
      await fetchDahuaGet(destroyQuery).catch(() => {});
    }

    return recordsText;
  } catch (e) {
    return "";
  }
}

function parseDahuaRows(body) {
  const rows = [];
  for (const line of String(body || "").split(/\r?\n/)) {
    const match = line.match(/^records\[(\d+)\]\.([^=]+)=(.*)$/);
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

async function syncUsers() {
  try {
    const userUrl = `${process.env.USER_IMPORT_URL || BACKEND_URL.replace(/attendance\/import$/, "users/import")}`;
    
    let rawText = await fetchDahuaRecordFinder("AccessControlCard", FETCH_LIMIT);
    let records = parseDahuaRows(rawText);
    if (!records.length) {
      rawText = await fetchDahuaRecordFinder("AccessUser", FETCH_LIMIT);
      records = parseDahuaRows(rawText);
    }

    const payload = records.map((record) => ({
      id: firstValue(record, ["UserID", "userID", "ID", "userId", "RecNo"]),
      name: firstValue(record, ["CardName", "UserName", "userName", "Name", "name"]),
      department: firstValue(record, ["Department", "department", "Group", "group"]),
      phone_number: firstValue(record, ["Phone", "phone", "PhoneNumber"]),
      address: firstValue(record, ["Address", "address"]),
      sex: firstValue(record, ["Sex", "sex"]),
    })).filter((user) => user.id);

    if (!payload.length) {
      console.log(`[Local Sync Users] No registered users found on Dahua device.`);
      return;
    }

    const headers = { "Content-Type": "application/json" };
    if (IMPORT_TOKEN) headers["x-attendance-import-token"] = IMPORT_TOKEN;

    const response = await fetch(userUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ users: payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok) {
      console.log(`[Local Sync Users] received=${result.received || 0}, stored=${result.count || 0}`);
    } else {
      console.error(`[Local Sync Users Error] HTTP ${response.status}: ${result.error || "User import rejected"}`);
    }
  } catch (e) {
    console.error(`[Local Sync Users Exception] ${e.message}`);
  }
}

async function processPendingDeletions() {
  try {
    const pendingUrl = `${process.env.PENDING_DELETIONS_URL || BACKEND_URL.replace(/attendance\/import$/, "dahua/pending-deletions")}`;
    const completeUrl = `${process.env.COMPLETE_DELETION_URL || BACKEND_URL.replace(/attendance\/import$/, "dahua/complete-deletion")}`;

    const res = await fetch(pendingUrl);
    if (!res.ok) return;
    const data = await res.json().catch(() => ({ deletions: [] }));
    const deletions = data.deletions || [];

    for (const item of deletions) {
      if (item.type === "attendance") {
        const rawText = await fetchDahuaRecordFinder("AccessControlCardRec", FETCH_LIMIT);
        const records = parseDahuaRows(rawText);
        const targetPerson = String(item.person_id).trim();
        const targetTimeSec = item.device_time ? Math.floor(new Date(item.device_time).getTime() / 1000) : null;

        const match = records.find((r) => {
          if (!r.RecNo) return false;
          const rPerson = firstValue(r, ["UserID", "userID", "CardNo"]);
          const rTimeRaw = firstValue(r, ["CreateTime", "Time", "time"]);
          if (rPerson && String(rPerson) !== targetPerson) return false;

          const rSec = Number(rTimeRaw);
          if (!isNaN(rSec) && rSec > 1000000000 && targetTimeSec) {
            if (Math.abs(rSec - targetTimeSec) <= 3) return true;
          }

          const rNormalized = normalizeDahuaDeviceTime(rTimeRaw);
          if (rNormalized && item.device_time && rNormalized === item.device_time) return true;
          return false;
        });

        if (match && match.RecNo) {
          const removeQuery = `/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCardRec&recno=${match.RecNo}`;
          await fetchDahuaGet(removeQuery);
          console.log(`[Local Sync Physical Delete] Removed Attendance RecNo ${match.RecNo} for person ${item.person_id} from Dahua device.`);
        }
      }

      await fetch(completeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      }).catch(() => {});
    }
  } catch (e) {
    console.error(`[Local Sync Deletions Error] ${e.message}`);
  }
}

async function syncOnce() {
  await syncUsers();
  await processPendingDeletions();
  const rawText = await fetchDahuaRecordFinder("AccessControlCardRec", FETCH_LIMIT);
  const records = parseDahuaRows(rawText);
  const payload = records.map((record) => {
    const rawTime = firstValue(record, ["CreateTime", "Time", "time"]);
    const formattedTime = normalizeDahuaDeviceTime(rawTime);
    return {
      person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
      name: firstValue(record, ["CardName", "Name", "name"]),
      event: "device",
      point: firstValue(record, ["AttendancePoint", "Point", "point"]),
      method: firstValue(record, ["Method", "method"]),
      device_time: formattedTime,
    };
  }).filter((record) => record.person_id && record.device_time);

  if (!payload.length) {
    console.log(`[Local Sync Attendance] No attendance scan records found on Dahua device.`);
    return;
  }

  const headers = {
    "Content-Type": "application/json",
  };
  if (IMPORT_TOKEN) {
    headers["x-attendance-import-token"] = IMPORT_TOKEN;
  }

  const response = await fetch(BACKEND_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ records: payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Backend returned HTTP ${response.status}.`);
  console.log(`[Local Sync Attendance] received=${result.received || 0}, stored=${result.count || 0}`);
}

async function main() {
  console.log(`[Local Sync Agent] Target Dahua Device: http://${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}`);
  console.log(`[Local Sync Agent] cPanel Import URL: ${BACKEND_URL}`);
  await syncOnce();
  if (process.env.LOCAL_SYNC_ONCE === "1") return;
  setInterval(() => syncOnce().catch((error) => console.error(`[Local Sync Exception] ${error.message}`)), SYNC_INTERVAL_MS);
}

main().catch((error) => {
  console.error(`[Local Sync Fatal Error] ${error.message}`);
  process.exitCode = 1;
});
