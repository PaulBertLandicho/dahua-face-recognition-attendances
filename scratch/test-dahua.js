require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const http = require("http");
const crypto = require("crypto");

const DAHUA_IP = process.env.DAHUA_DEVICE_IP || "192.168.111.222";
const DAHUA_PORT = Number(process.env.DAHUA_DEVICE_PORT || 80);
const DAHUA_USER = process.env.DAHUA_USERNAME || "admin";
const DAHUA_PASS = process.env.DAHUA_PASSWORD || "12a34s56d";

console.log(`[Diagnostic Test] Target Dahua Device: ${DAHUA_IP}:${DAHUA_PORT}`);
console.log(`[Diagnostic Test] Username: ${DAHUA_USER}`);

function parseDigestChallenge(header) {
  return Object.fromEntries(
    [...header.matchAll(/([a-z]+)=(?:"([^"]*)"|([^,]+))/gi)].map((match) => [
      match[1].toLowerCase(),
      match[2] || match[3].trim(),
    ])
  );
}

function digestResponse(method, requestPath, challenge) {
  const ha1 = crypto.createHash("md5").update(`${DAHUA_USER}:${challenge.realm}:${DAHUA_PASS}`).digest("hex");
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

function requestDahua(requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: DAHUA_IP,
        port: DAHUA_PORT,
        path: requestPath,
        method: "GET",
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Timeout connecting to Dahua IP " + DAHUA_IP));
    });
    request.on("error", reject);
    request.end();
  });
}

async function requestDahuaAuth(requestPath) {
  const first = await requestDahua(requestPath);
  if (first.statusCode !== 401) return first.body;

  const challengeHeader = first.headers["www-authenticate"];
  if (!challengeHeader) return first.body;

  const challenge = parseDigestChallenge(challengeHeader);
  const digest = digestResponse("GET", requestPath, challenge);
  const fields = [
    `username="${DAHUA_USER}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${requestPath}"`,
    `response="${digest.response || digest}"`,
  ];
  if (digest.qop) fields.push(`qop=${digest.qop}`, `nc=${digest.nonceCount}`, `cnonce="${digest.cnonce}"`);
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) fields.push(`algorithm=${challenge.algorithm}`);

  const authHeader = `Digest ${fields.join(", ")}`;

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: DAHUA_IP,
        port: DAHUA_PORT,
        path: requestPath,
        method: "GET",
        timeout: 5000,
        headers: { Authorization: authHeader },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      }
    );
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Timeout on authenticated request to Dahua IP " + DAHUA_IP));
    });
    request.on("error", reject);
    request.end();
  });
}

async function runDiagnostics() {
  try {
    console.log("\n--- TEST 1: Ping Dahua System Info ---");
    const sysInfo = await requestDahuaAuth("/cgi-bin/magicBox.cgi?action=getSystemInfo");
    console.log("System Info Response:", sysInfo.slice(0, 300));

    const tables = ["AccessControlCardRec", "AccessUser", "AccessControlCard", "Attendance"];
    for (const name of tables) {
      console.log(`\n--- TEST 2: Query Finder for Table: ${name} ---`);
      const findRes = await requestDahuaAuth(`/cgi-bin/recordFinder.cgi?action=find&name=${name}`);
      console.log(`find (${name}):`, findRes.trim());

      const tokenMatch = findRes.match(/token=(\d+)/i);
      if (tokenMatch && tokenMatch[1]) {
        const token = tokenMatch[1];
        console.log(`Found token: ${token}, fetching doFind...`);
        const doFindRes = await requestDahuaAuth(`/cgi-bin/recordFinder.cgi?action=doFind&token=${token}&count=20`);
        console.log(`doFind (${name}):`, doFindRes.trim().slice(0, 500));
        await requestDahuaAuth(`/cgi-bin/recordFinder.cgi?action=destroy&token=${token}`);
      }
    }
  } catch (e) {
    console.error("\n❌ Diagnostic Error:", e.message);
  }
}

runDiagnostics();
