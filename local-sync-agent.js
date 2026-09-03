require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const CONNECTOR_URL = (process.env.LOCAL_DAHUA_CONNECTOR_URL || "http://localhost:5000").replace(/\/$/, "");
const BACKEND_URL = (process.env.ATTENDANCE_IMPORT_URL || "https://attendance.multifactors-sales.com/api/attendance/import").replace(/\/$/, "");
const IMPORT_TOKEN = process.env.ATTENDANCE_IMPORT_TOKEN || "";
const SYNC_INTERVAL_MS = Number(process.env.LOCAL_SYNC_INTERVAL_MS || 5 * 60 * 1000);
const FETCH_LIMIT = Number(process.env.LOCAL_SYNC_FETCH_LIMIT || 1000);

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

async function syncOnce() {
  if (!IMPORT_TOKEN) throw new Error("ATTENDANCE_IMPORT_TOKEN is not configured.");
  const query = `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&count=${FETCH_LIMIT}`;
  const deviceResponse = await fetch(`${CONNECTOR_URL}/dahua/get?path=${encodeURIComponent(query)}`);
  if (!deviceResponse.ok) throw new Error(`Local connector returned HTTP ${deviceResponse.status}.`);
  const records = parseDahuaRows(await deviceResponse.text());
  const payload = records.map((record) => ({
    person_id: firstValue(record, ["UserID", "userID", "CardNo"]),
    name: firstValue(record, ["CardName", "Name", "name"]),
    event: "device",
    point: firstValue(record, ["AttendancePoint", "Point", "point"]),
    method: firstValue(record, ["Method", "method"]),
    device_time: firstValue(record, ["CreateTime", "Time", "time"]),
  })).filter((record) => record.person_id && record.device_time);

  const response = await fetch(BACKEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-attendance-import-token": IMPORT_TOKEN,
    },
    body: JSON.stringify({ records: payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Backend returned HTTP ${response.status}.`);
  console.log(`[Local Sync] received=${result.received || 0}, stored=${result.count || 0}`);
}

async function main() {
  console.log(`[Local Sync] Connector: ${CONNECTOR_URL}`);
  console.log(`[Local Sync] Backend: ${BACKEND_URL}`);
  await syncOnce();
  if (process.env.LOCAL_SYNC_ONCE === "1") return;
  setInterval(() => syncOnce().catch((error) => console.error(`[Local Sync] ${error.message}`)), SYNC_INTERVAL_MS);
}

main().catch((error) => {
  console.error(`[Local Sync] ${error.message}`);
  process.exitCode = 1;
});
