require("dotenv").config();
require("dotenv").config({ path: ".env.local" });
const express = require("express");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = Number(process.env.PORT || 4000);
const STREAM_STALE_MS = 5000;
const MAX_RESTART_DELAY_MS = 10000;

// Dahua RTSP URL with your credentials.
// If this path is wrong for your model, the log in this terminal will show 401/404 errors.
const RTSP_URL =
  process.env.DAHUA_RTSP_URL ||
  "rtsp://admin:12a34s56d@192.168.111.227:554/cam/realmonitor?channel=1&subtype=0";
const DAHUA_DEVICE_IP = process.env.DAHUA_DEVICE_IP || "192.168.111.227";
const DAHUA_DEVICE_PORT = Number(process.env.DAHUA_DEVICE_PORT || 80);
const DAHUA_USERNAME = process.env.DAHUA_USERNAME || "admin";
const DAHUA_PASSWORD = process.env.DAHUA_PASSWORD || "";
const AUTO_SYNC_ATTENDANCE_MINUTES = Number(
  process.env.AUTO_SYNC_ATTENDANCE_MINUTES || 0,
);

const hlsDir = path.join(__dirname, "hls");
if (!fs.existsSync(hlsDir)) {
  fs.mkdirSync(hlsDir);
}

let ffmpegCommand = null;
let restartTimer = null;
let restartCount = 0;
const streamState = {
  status: "idle",
  lastError: null,
  lastStartAt: null,
  pid: null,
};

// Supabase client (server-side, uses service role key)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    "Warning: SUPABASE_URL or SUPABASE_SERVICE_KEY not set. /api/attendance endpoints will not work until you configure them."
  );
}

const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

function parseDigestChallenge(header) {
  return Object.fromEntries(
    [...header.matchAll(/([a-z]+)=(?:"([^"]*)"|([^,]+))/gi)].map((match) => [
      match[1].toLowerCase(),
      match[2] || match[3].trim(),
    ])
  );
}

function digestResponse(method, requestPath, challenge) {
  const ha1 = crypto
    .createHash("md5")
    .update(`${DAHUA_USERNAME}:${challenge.realm}:${DAHUA_PASSWORD}`)
    .digest("hex");
  const ha2 = crypto
    .createHash("md5")
    .update(`${method}:${requestPath}`)
    .digest("hex");
  const qop = challenge.qop && challenge.qop.split(",")[0].trim();
  const cnonce = crypto.randomBytes(16).toString("hex");
  const nonceCount = "00000001";
  if (qop) {
    const response = crypto
      .createHash("md5")
      .update(`${ha1}:${challenge.nonce}:${nonceCount}:${cnonce}:${qop}:${ha2}`)
      .digest("hex");
    return { response, cnonce, nonceCount, qop };
  }
  return crypto
    .createHash("md5")
    .update(`${ha1}:${challenge.nonce}:${ha2}`)
    .digest("hex");
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
          ...(requestBody
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(requestBody),
              }
            : {}),
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

async function requestDahuaJsonWithDigest(requestPath, method, payload) {
  const first = await requestDahua(requestPath, method, null, payload);
  if (first.response.statusCode !== 401) {
    if (first.response.statusCode < 200 || first.response.statusCode >= 300) {
      throw new Error(`Dahua RPC request failed with HTTP ${first.response.statusCode}.`);
    }
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
  if (digest.qop) {
    fields.push(`qop=${digest.qop}`, `nc=${digest.nonceCount}`, `cnonce="${digest.cnonce}"`);
  }
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);

  const authenticated = await requestDahua(
    requestPath,
    method,
    `Digest ${fields.join(", ")}`,
    payload
  );
  if (authenticated.response.statusCode < 200 || authenticated.response.statusCode >= 300) {
    const details = authenticated.body && authenticated.body.trim();
    throw new Error(
      `Dahua RPC request failed with HTTP ${authenticated.response.statusCode}${details ? `: ${details}` : "."}`
    );
  }
  return authenticated;
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

async function getDahuaUsers(requestedUserIds = null) {
  const firstLogin = await requestDahuaJsonWithDigest("/RPC2_Login", "POST", {
    method: "global.login",
    params: { userName: DAHUA_USERNAME, password: "", clientType: "Web3.0" },
    id: 1,
  });
  const firstData = JSON.parse(firstLogin.body || "{}");
  const loginParams = firstData.params || {};
  if (!loginParams.realm || !loginParams.random) {
    throw new Error("Dahua RPC login did not return a login challenge.");
  }

  const passwordHash = md5(
    `${DAHUA_USERNAME}:${loginParams.realm}:${DAHUA_PASSWORD}`
  );
  const loginPassword = passwordHash.toUpperCase();
  const session = firstData.session || 0;
  const secondLogin = await requestDahuaJsonWithDigest("/RPC2_Login", "POST", {
    method: "global.login",
    params: {
      userName: DAHUA_USERNAME,
      password: loginPassword,
      clientType: "Web3.0",
      authorityType: "Default",
    },
    id: 2,
    session,
  });
  const secondData = JSON.parse(secondLogin.body || "{}");
  if (secondData.result === false) {
    const detail =
      secondData.error?.message ||
      secondData.error?.detail ||
      secondData.params?.error ||
      `RPC response: ${JSON.stringify(secondData)}`;
    throw new Error(`Dahua RPC login was rejected: ${detail}`);
  }

  const activeSession = secondData.session || session;
  const users = [];
  const batches = requestedUserIds
    ? Array.from({ length: Math.ceil(requestedUserIds.length / 10) }, (_, index) =>
        requestedUserIds.slice(index * 10, index * 10 + 10),
      )
    : Array.from({ length: 100 }, (_, index) =>
        Array.from({ length: 10 }, (_, offset) => String(index * 10 + offset + 1)),
      );
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
  if (!challengeHeader) throw new Error("Dahua device did not provide authentication details.");
  const challenge = parseDigestChallenge(challengeHeader);
  const digest = digestResponse("GET", requestPath, challenge);
  const fields = [
    `username="${DAHUA_USERNAME}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${requestPath}"`,
    `response="${digest.response || digest}"`,
  ];
  if (digest.qop) {
    fields.push(`qop=${digest.qop}`, `nc=${digest.nonceCount}`, `cnonce="${digest.cnonce}"`);
  }
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);
  const authorization = `Digest ${fields.join(", ")}`;
  const authenticated = await requestDahua(requestPath, "GET", authorization);
  if (authenticated.response.statusCode < 200 || authenticated.response.statusCode >= 300) {
    const details = authenticated.body && authenticated.body.trim();
    throw new Error(
      `Dahua request failed with HTTP ${authenticated.response.statusCode}${details ? `: ${details}` : "."}`
    );
  }
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
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const numeric = Number(text);
  const date = /^\d{10,13}$/.test(text)
    ? new Date(text.length === 10 ? numeric * 1000 : numeric)
    : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapDahuaAttendanceEvent(record) {
  const type = String(firstValue(record, ["Type", "type"]) || "").toLowerCase();
  if (type.includes("exit") || type.includes("out") || type.includes("leave")) return "time-out";
  return "time-in";
}

function mapDahuaAttendanceMethod(value) {
  const method = String(value || "").toLowerCase();
  const methods = {
    "15": "face",
    "21": "fingerprint",
    "3": "card",
    "4": "password",
  };
  return methods[method] || (method || "device");
}

app.post("/api/dahua/sync-users", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured on the backend." });
  }

  try {
    const users = await getDahuaUsers();
    const payload = users
      .map((user) => ({
        id: firstValue(user, ["UserID", "userID", "ID", "userId"]),
        name: firstValue(user, ["UserName", "userName", "Name", "name"]),
        department: firstValue(user, ["Department", "department", "Group", "group"]),
        phone_number: firstValue(user, ["Phone", "phone", "PhoneNumber"]),
        address: firstValue(user, ["Address", "address"]),
        sex: firstValue(user, ["Sex", "sex"]),
      }))
      .filter((user) => user.id);

    if (!payload.length) return res.json({ count: 0, message: "No users were returned by the Dahua device." });

    const userIds = payload.map((user) => String(user.id));
    const { data: existingUsers, error: existingError } = await supabase
      .from("persons")
      .select("id")
      .in("id", userIds);
    if (existingError) throw existingError;

    const existingIds = new Set((existingUsers || []).map((user) => String(user.id)));
    const newUsers = payload.filter((user) => !existingIds.has(String(user.id)));
    if (!newUsers.length) {
      return res.json({ count: 0, message: "No new Dahua users were found. Existing person records were preserved." });
    }

    const { error } = await supabase.from("persons").insert(newUsers);
    if (error) throw error;
    res.json({ count: newUsers.length, message: "Only new Dahua users were added. Existing person records were preserved." });
  } catch (err) {
    console.error("Dahua user sync error:", err.message);
    res.status(502).json({ error: `Dahua user sync failed: ${err.message}` });
  }
});

app.post("/api/dahua/sync-attendance", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase is not configured on the backend." });
  }

  try {
    // This firmware rejects date filters. Request the complete device history
    // so newer users such as Paulbert are not hidden behind the first page.
    const query = "/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=1000";
    const records = parseDahuaRows(await requestDahuaWithDigest(query));
    const attendanceUserIds = [...new Set(
      records
        .map((record) => firstValue(record, ["UserID", "userID"]))
        .filter(Boolean)
        .map(String),
    )];
    const users = await getDahuaUsers(attendanceUserIds);
    const userNames = new Map(
      users
        .map((user) => [
          String(firstValue(user, ["UserID", "userID", "ID"])),
          firstValue(user, ["UserName", "userName", "Name", "name"]),
        ])
        .filter(([id, name]) => id && name),
    );
    const payload = records
      .map((record) => ({
        person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
        name: firstValue(record, ["CardName", "Name", "name"]) || userNames.get(String(firstValue(record, ["UserID", "userID"]))) || null,
        event: mapDahuaAttendanceEvent(record),
        point: firstValue(record, ["AttendancePoint", "Point", "point"]),
        method: mapDahuaAttendanceMethod(firstValue(record, ["Method", "method"])),
        device_time: normalizeDahuaDeviceTime(firstValue(record, ["CreateTime", "Time", "time"])),
      }))
      .filter((record) => record.device_time && record.person_id);

    if (!payload.length) return res.json({ count: 0, message: "No attendance records were returned by the Dahua device." });
    const personIds = [...new Set(payload.map((record) => record.person_id).filter(Boolean))];
    if (personIds.length) {
      const { data: knownPersons, error: personError } = await supabase
        .from("persons")
        .select("id")
        .in("id", personIds);
      if (personError) throw personError;
      const knownIds = new Set((knownPersons || []).map((person) => String(person.id)));
      for (const record of payload) {
        if (record.person_id && !knownIds.has(String(record.person_id))) {
          record.person_id = null;
        }
      }
    }
    const deviceTimes = [...new Set(payload.map((record) => record.device_time))];
    const { data: existing, error: existingError } = await supabase
      .from("attendance")
      .select("id,person_id,event,point,method,device_time")
      .in("device_time", deviceTimes);
    if (existingError) throw existingError;
    const existingByIdentity = new Map(
      (existing || []).map((record) => [
        `${record.person_id || ""}|${record.device_time}`,
        record,
      ]),
    );
    const incomingIdentityKeys = new Set();
    const newRecords = payload.filter((record) => {
      const identityKey = `${record.person_id || ""}|${record.device_time}`;
      if (existingByIdentity.has(identityKey)) return false;
      if (incomingIdentityKeys.has(identityKey)) return false;
      incomingIdentityKeys.add(identityKey);
      return true;
    });
    for (const record of payload) {
      if (!record.device_time) continue;
      const existingRecord = existingByIdentity.get(
        `${record.person_id || ""}|${record.device_time}`,
      );
      if (existingRecord) {
        const { error: updateError } = await supabase
          .from("attendance")
          .update({ name: record.name, event: record.event, method: record.method })
          .eq("id", existingRecord.id);
        if (updateError && updateError.code !== "23505") throw updateError;
      }
    }
    if (!newRecords.length) return res.json({ count: 0, message: "No new attendance records were found." });

    // Fetch settings to determine morning/afternoon cutoff
    const { data: settingsData } = await supabase.from("settings").select("*").single();
    const settings = settingsData || {};
    let cutoffMin = 12 * 60; // default 12:00 PM
    if (settings.morning_end) {
      const parts = settings.morning_end.split(":").map(Number);
      cutoffMin = parts[0] * 60 + parts[1];
      if (settings.morning_grace_minutes) {
        cutoffMin += Number(settings.morning_grace_minutes);
      }
    }

    // Sort newRecords chronologically so we process the earliest first
    newRecords.sort((a, b) => new Date(a.device_time) - new Date(b.device_time));

    // We need to check existing records in the database for the relevant dates
    const dates = [...new Set(newRecords.map(r => r.device_time.substring(0, 10)))];
    const personIdsToSync = [...new Set(newRecords.map(r => String(r.person_id)).filter(Boolean))];

    const { data: existingDayRecords } = await supabase
      .from("attendance")
      .select("person_id, device_time")
      .in("person_id", personIdsToSync)
      .gte("device_time", `${dates.sort()[0]}T00:00:00Z`);

    // Track which sessions already have a punch
    // Key: "personId|YYYY-MM-DD|session" -> true (session is 'morning' or 'afternoon')
    const hasPunch = new Map();

    if (existingDayRecords) {
      for (const r of existingDayRecords) {
        if (!r.person_id || !r.device_time) continue;
        const pId = String(r.person_id);
        const dateStr = r.device_time.substring(0, 10);
        const d = new Date(r.device_time);
        const mins = d.getHours() * 60 + d.getMinutes();
        const session = mins <= cutoffMin ? "morning" : "afternoon";
        hasPunch.set(`${pId}|${dateStr}|${session}`, true);
      }
    }

    const filteredNewRecords = [];
    for (const record of newRecords) {
      if (!record.person_id) {
        filteredNewRecords.push(record); // Allow unmatched records? Or maybe filter them out? We'll allow them.
        continue;
      }
      const pId = String(record.person_id);
      const dateStr = record.device_time.substring(0, 10);
      const d = new Date(record.device_time);
      const mins = d.getHours() * 60 + d.getMinutes();
      const session = mins <= cutoffMin ? "morning" : "afternoon";
      const key = `${pId}|${dateStr}|${session}`;

      if (!hasPunch.has(key)) {
        hasPunch.set(key, true);
        filteredNewRecords.push(record);
      }
    }

    if (!filteredNewRecords.length) return res.json({ count: 0, message: "No new non-duplicate attendance records were found." });

    let insertedCount = 0;
    for (const record of filteredNewRecords) {
      const { error } = await supabase.from("attendance").insert([record]);
      if (!error) insertedCount += 1;
      else if (error.code !== "23505") throw error;
    }
    res.json({ count: insertedCount, message: insertedCount ? undefined : "No new attendance records were found." });
  } catch (err) {
    console.error("Dahua attendance sync error:", err.message);
    res.status(502).json({ error: `Dahua attendance sync failed: ${err.message}` });
  }
});

app.delete("/api/dahua/attendance", async (req, res) => {
  const { personId, deviceTime } = req.body || {};
  if (!personId || !deviceTime) {
    return res.status(400).json({ error: "Missing personId or deviceTime" });
  }

  try {
    const targetTime = new Date(deviceTime);
    if (Number.isNaN(targetTime.getTime())) {
      return res.status(400).json({ error: "Invalid deviceTime format." });
    }

    const query = "/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=1000";
    const records = parseDahuaRows(await requestDahuaWithDigest(query));

    const normalizeDeviceTimeForCompare = (value) => {
      const iso = normalizeDahuaDeviceTime(value);
      if (!iso) return null;
      return new Date(iso).toISOString().slice(0, 19);
    };

    const targetIso = new Date(targetTime.getTime()).toISOString().slice(0, 19);
    const candidate = records.find((record) => {
      const recordPersonId = firstValue(record, ["UserID", "userID", "CardNo", "cardNo", "CardNo"]);
      const recordTime = normalizeDeviceTimeForCompare(firstValue(record, ["CreateTime", "Time", "time", "TimeStr"]));
      return String(recordPersonId) === String(personId) && recordTime === targetIso;
    });

    let deviceDeleteAttempted = false;
    let deviceDeleteSuccess = false;
    let deviceDeleteMessage = "No matching Dahua record found.";

    if (candidate) {
      const recno = firstValue(candidate, ["RecNo", "recno", "RecNo1", "recno1"]);
      if (recno) {
        deviceDeleteAttempted = true;
        const delQuery = `/cgi-bin/recordUpdater.cgi?action=remove&name=AccessControlCardRec&recno=${encodeURIComponent(recno)}`;
        try {
          const result = await requestDahuaWithDigest(delQuery);
          const text = String(result || "").trim();
          deviceDeleteSuccess = !text || text.includes("OK") || text.includes("ok") || text.includes("success");
          deviceDeleteMessage = deviceDeleteSuccess
            ? "Matching Dahua record removed successfully."
            : "Dahua delete request returned a non-success response.";
        } catch (deleteError) {
          console.warn("Dahua device delete failed, but local delete can still proceed:", deleteError.message);
          deviceDeleteSuccess = false;
          deviceDeleteMessage = deleteError.message;
        }
      }
    }

    if (!candidate && !deviceDeleteAttempted) {
      console.warn("No matching Dahua attendance record found. Local delete will continue.");
    }

    const response = {
      success: true,
      deletedFromDevice: deviceDeleteAttempted ? deviceDeleteSuccess : false,
      deviceFound: Boolean(candidate),
      message: deviceDeleteAttempted
        ? deviceDeleteMessage
        : "No matching Dahua record found; local delete will proceed.",
    };

    res.json(response);
  } catch (err) {
    console.error("Dahua attendance delete error:", err.message);
    res.status(500).json({ error: `Failed to delete from Dahua: ${err.message}` });
  }
});

function clearHlsArtifacts() {
  for (const fileName of fs.readdirSync(hlsDir)) {
    if (fileName.endsWith(".m3u8") || fileName.endsWith(".ts")) {
      fs.rmSync(path.join(hlsDir, fileName), { force: true });
    }
  }
}

function getStreamHealth() {
  const playlistPath = path.join(hlsDir, "index.m3u8");
  const playlistExists = fs.existsSync(playlistPath);
  const segmentFiles = fs
    .readdirSync(hlsDir)
    .filter((fileName) => fileName.endsWith(".ts"));

  let newestSegmentMtimeMs = null;
  for (const fileName of segmentFiles) {
    const filePath = path.join(hlsDir, fileName);
    const stats = fs.statSync(filePath);
    if (newestSegmentMtimeMs === null || stats.mtimeMs > newestSegmentMtimeMs) {
      newestSegmentMtimeMs = stats.mtimeMs;
    }
  }

  return {
    playlistExists,
    segmentCount: segmentFiles.length,
    segmentsUpdating:
      newestSegmentMtimeMs !== null &&
      Date.now() - newestSegmentMtimeMs < STREAM_STALE_MS,
    lastSegmentAt: newestSegmentMtimeMs
      ? new Date(newestSegmentMtimeMs).toISOString()
      : null,
  };
}

function scheduleRestart(reason) {
  if (restartTimer) {
    return;
  }

  restartCount += 1;
  const delayMs = Math.min(1000 * restartCount, MAX_RESTART_DELAY_MS);
  streamState.status = "restarting";
  console.warn(`Scheduling ffmpeg restart in ${delayMs}ms after ${reason}.`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startFfmpeg();
  }, delayMs);
}

function startFfmpeg() {
  if (ffmpegCommand) {
    return ffmpegCommand;
  }

  clearHlsArtifacts();
  streamState.status = "starting";
  streamState.lastError = null;
  streamState.lastStartAt = new Date().toISOString();
  console.log("Starting ffmpeg from RTSP to HLS...");

  const command = ffmpeg(RTSP_URL)
    .inputOptions([
      "-rtsp_transport",
      "tcp",
      "-fflags",
      "nobuffer",
      "-analyzeduration",
      "0",
      "-probesize",
      "32",
      "-flags",
      "low_delay",
    ])
    .addOptions([
      "-an",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-g",
      "10",
      "-keyint_min",
      "10",
      "-sc_threshold",
      "0",
      "-f",
      "hls",
      // Shorter segments and smaller playlist = lower latency
      "-hls_time",
      "0.5",
      "-hls_list_size",
      "2",
      "-hls_flags",
      "delete_segments+omit_endlist+independent_segments+program_date_time",
      "-muxdelay",
      "0",
      "-muxpreload",
      "0",
    ])
    .output(path.join(hlsDir, "index.m3u8"))
    .on("start", (commandLine) => {
      ffmpegCommand = command;
      restartCount = 0;
      streamState.status = "running";
      streamState.pid = command.ffmpegProc ? command.ffmpegProc.pid : null;
      console.log("ffmpeg command:", commandLine);
    })
    .on("error", (err) => {
      ffmpegCommand = null;
      streamState.status = "error";
      streamState.lastError = err.message;
      streamState.pid = null;
      console.error("ffmpeg error:", err.message);
      console.error(
        "Check RTSP_URL, credentials, and that the device is reachable."
      );
      scheduleRestart("ffmpeg error");
    })
    .on("end", () => {
      ffmpegCommand = null;
      streamState.status = "ended";
      streamState.pid = null;
      console.log("ffmpeg process ended");
      scheduleRestart("ffmpeg end");
    })
    .run();

  ffmpegCommand = command;
  return command;
}

startFfmpeg();

// Serve HLS segments and playlist
app.use(
  "/hls",
  express.static(hlsDir, {
    setHeaders: (res, filePath) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range"
      );
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      );

      if (filePath.toLowerCase().endsWith(".m3u8")) {
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      }
    },
  })
);
app.use(
  "/models",
  express.static(path.join(__dirname, "models"), {
    setHeaders: (res, filePath) => {
      // Allow cross-origin requests for model files
      res.setHeader("Access-Control-Allow-Origin", "*");
      // Cache model files aggressively (long-lived immutable assets)
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }),
);

app.get("/health/stream", (req, res) => {
  res.json({
    ...streamState,
    ...getStreamHealth(),
  });
});

// Compatibility endpoint expected by the frontend DeviceStatus component
app.get("/api/device/status", (req, res) => {
  try {
    const health = getStreamHealth();
    res.json({
      online:
        streamState.status === "running" &&
        health.playlistExists &&
        health.segmentsUpdating,
      deviceIp: process.env.DAHUA_DEVICE_IP || null,
      statusCode: streamState.status,
      error: streamState.lastError || null,
      ...health,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to read stream status." });
  }
});
// Supabase-backed attendance API
app.get("/api/attendance", async (req, res) => {
  if (!supabase) {
    return res
      .status(500)
      .json({ error: "Supabase not configured on server." });
  }

  try {
    const { data, error } = await supabase
      .from("attendance")
      .select("*")
      .order("device_time", { ascending: false })
      .limit(200);

    if (error) {
      console.error("Supabase select error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to load attendance from Supabase." });
    }

    // Always return JSON, never use res.send or res.end here
    res.json({ records: data || [] });
  } catch (err) {
    console.error("Unexpected /api/attendance error:", err.message);
    res.status(500).json({ error: "Unexpected error loading attendance." });
  }
});

// Endpoint you (or the device) can POST to in order to record a scan directly into Supabase
app.post("/api/attendance", async (req, res) => {
  if (!supabase) {
    return res
      .status(500)
      .json({ error: "Supabase not configured on server." });
  }

  const { person_id, name, department, event, point, method, device_time } =
    req.body || {};

  try {
    // Ensure a person record exists for this ID (first scan creates a new person)
    if (person_id) {
      const { error: upsertError } = await supabase.from("persons").upsert(
        [
          {
            id: person_id,
            name: name || null,
            department: department || null,
          },
        ],
        { onConflict: "id" }
      );

      if (upsertError) {
        console.error("Supabase persons upsert error:", upsertError.message);
      }
    }

    const { error } = await supabase.from("attendance").insert([
      {
        person_id: person_id || null,
        name: name || null,
        department: department || null,
        event: event || null,
        point: point || null,
        method: method || null,
        device_time: device_time || null,
      },
    ]);

    if (error) {
      console.error("Supabase insert error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to insert attendance into Supabase." });
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Unexpected POST /api/attendance error:", err.message);
    res.status(500).json({ error: "Unexpected error inserting attendance." });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

let automaticSyncInFlight = false;

async function runAutomaticAttendanceSync() {
  if (automaticSyncInFlight || !AUTO_SYNC_ATTENDANCE_MINUTES) return;
  automaticSyncInFlight = true;
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/dahua/sync-attendance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    console.log(`Automatic Dahua attendance sync completed: ${result.count || 0} new record(s).`);
  } catch (err) {
    console.error("Automatic Dahua attendance sync failed:", err.message);
  } finally {
    automaticSyncInFlight = false;
  }
}

app.listen(PORT, () => {
  console.log(`HLS server running at http://localhost:${PORT}/hls/index.m3u8`);
  if (AUTO_SYNC_ATTENDANCE_MINUTES > 0) {
    const intervalMs = AUTO_SYNC_ATTENDANCE_MINUTES * 60 * 1000;
    console.log(`Automatic Dahua attendance sync enabled every ${AUTO_SYNC_ATTENDANCE_MINUTES} minute(s).`);
    setTimeout(runAutomaticAttendanceSync, 5000);
    setInterval(runAutomaticAttendanceSync, intervalMs);
  }
});
