/**
 * Local Dahua Connector Service
 * 
 * Runs on the same LAN as the Dahua device and proxies requests from the remote backend.
 * This solves the network isolation issue where cPanel cannot reach private LAN addresses.
 * 
 * Usage: node dahua-local-connector.js
 * The connector will listen on CONNECTOR_PORT (default 5000)
 */

require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const CONNECTOR_PORT = Number(process.env.DAHUA_CONNECTOR_PORT || 5000);

// Dahua Device Configuration
const DAHUA_DEVICE_IP = process.env.DAHUA_DEVICE_IP || "192.168.111.222";
const DAHUA_DEVICE_PORT = Number(process.env.DAHUA_DEVICE_PORT || 80);
const DAHUA_USERNAME = process.env.DAHUA_USERNAME || "admin";
const DAHUA_PASSWORD = process.env.DAHUA_PASSWORD || "";
const DAHUA_REQUEST_TIMEOUT_MS = Number(process.env.DAHUA_REQUEST_TIMEOUT_MS || 30000);

console.log(`[Dahua Local Connector] Starting on port ${CONNECTOR_PORT}`);
console.log(`[Dahua Local Connector] Target Dahua device: ${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}`);

// ==========================================
// DAHUA HELPER FUNCTIONS (same as server.js)
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
      const error = new Error(`Dahua request timed out after ${DAHUA_REQUEST_TIMEOUT_MS}ms`);
      request.destroy(error);
      reject(error);
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

// ==========================================
// CONNECTOR ROUTES
// ==========================================

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", connector: "dahua-local", target: `${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}` });
});

// Proxy endpoint for JSON RPC requests with digest auth
app.post("/dahua/rpc", async (req, res) => {
  try {
    const { path = "/RPC2", method = "POST", payload } = req.body;
    
    console.log(`[Dahua Proxy] POST ${path}`);
    
    const result = await requestDahuaJsonWithDigest(path, method, payload);
    const responseBody = result.body;
    
    res.json({
      success: true,
      statusCode: result.response.statusCode,
      body: responseBody,
    });
  } catch (error) {
    console.error("[Dahua Proxy] RPC Error:", error.message);
    res.status(502).json({
      success: false,
      error: error.message,
    });
  }
});

// Proxy endpoint for GET requests with digest auth (used for recordFinder.cgi)
app.get("/dahua/get", async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: "path parameter is required" });
    
    console.log(`[Dahua Proxy] GET ${path}`);
    
    const result = await requestDahuaWithDigest(path);
    res.setHeader("Content-Type", "text/plain");
    res.send(result);
  } catch (error) {
    console.error("[Dahua Proxy] GET Error:", error.message);
    res.status(502).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// START SERVER
// ==========================================

app.listen(CONNECTOR_PORT, () => {
  console.log(`\n✓ Dahua Local Connector running on http://localhost:${CONNECTOR_PORT}`);
  console.log(`✓ Dahua device: http://${DAHUA_DEVICE_IP}:${DAHUA_DEVICE_PORT}`);
  console.log(`✓ Ready to proxy requests from cPanel backend\n`);
  console.log(`Configuration:`);
  console.log(`  - Device IP: ${DAHUA_DEVICE_IP}`);
  console.log(`  - Device Port: ${DAHUA_DEVICE_PORT}`);
  console.log(`  - Username: ${DAHUA_USERNAME}`);
  console.log(`  - Timeout: ${DAHUA_REQUEST_TIMEOUT_MS}ms\n`);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
  process.exit(1);
});
