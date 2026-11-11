import os

server_path = "server.js"
with open(server_path, "r", encoding="utf-8") as f:
    content = f.read()

verify_service_code = """
// ==========================================
// FACE VERIFICATION & SECURITY TOKEN SERVICE
// ==========================================
const FACE_TOKEN_SECRET = process.env.FACE_TOKEN_SECRET || "dahua_face_secret_key_892348923489234";
const FACE_VERIFY_THRESHOLD = Number(process.env.FACE_VERIFY_THRESHOLD || 0.28);
const FACE_MARGIN_THRESHOLD = 0.04;

function signFaceToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", FACE_TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyFaceToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "Malformed token" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, error: "Invalid token format" };
  const [bodyB64, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", FACE_TOKEN_SECRET).update(bodyB64).digest("base64url");
  
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: "Invalid signature" };
  }

  try {
    const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf-8"));
    const now = Date.now();
    // Allow 10 minute window for clock skew between client and server
    if (payload.exp && now > payload.exp + (10 * 60 * 1000)) {
      return { valid: false, error: "Token expired" };
    }
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: "Corrupted payload" };
  }
}

// In-memory cache for eligible persons
let eligiblePersonsCache = null;
let eligiblePersonsCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000;

function clearEligiblePersonsCache() {
  eligiblePersonsCache = null;
  eligiblePersonsCacheTime = 0;
}

async function getEligiblePersons() {
  const now = Date.now();
  if (eligiblePersonsCache && (now - eligiblePersonsCacheTime < CACHE_TTL_MS)) {
    return eligiblePersonsCache;
  }
  const [rows] = await pool.query(
    "SELECT id, name, department, descriptor FROM persons WHERE archived = 0 AND descriptor IS NOT NULL"
  );
  const persons = [];
  for (const r of rows) {
    try {
      let desc = r.descriptor;
      if (typeof desc === "string") desc = JSON.parse(desc);
      if (Array.isArray(desc) && desc.length === 128) {
        let sum = 0;
        for (let i = 0; i < 128; i++) sum += desc[i] * desc[i];
        const norm = Math.sqrt(sum) || 1.0;
        const normDesc = new Float32Array(128);
        for (let i = 0; i < 128; i++) normDesc[i] = desc[i] / norm;

        persons.push({
          id: String(r.id),
          name: r.name,
          department: r.department,
          descriptor: normDesc,
        });
      }
    } catch (e) {}
  }
  eligiblePersonsCache = persons;
  eligiblePersonsCacheTime = now;
  return persons;
}

const verifyRateLimits = new Map();
function checkVerifyRateLimit(ip) {
  const now = Date.now();
  const entry = verifyRateLimits.get(ip) || { count: 0, resetTime: now + 60000 };
  if (now > entry.resetTime) {
    entry.count = 1;
    entry.resetTime = now + 60000;
  } else {
    entry.count += 1;
  }
  verifyRateLimits.set(ip, entry);
  return entry.count <= 10;
}

function calcEuclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// POST /api/face/verify
app.post("/api/face/verify", async (req, res) => {
  try {
    const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
    if (!checkVerifyRateLimit(clientIp)) {
      return res.status(429).json({ matched: false, error: "Too many verification attempts. Please wait a minute." });
    }

    const { descriptor } = req.body || {};
    if (!Array.isArray(descriptor) || descriptor.length !== 128 || !descriptor.every(n => typeof n === "number" && isFinite(n))) {
      return res.status(400).json({ matched: false, error: "Invalid face descriptor: must be array of 128 numbers" });
    }

    let sum = 0;
    for (let i = 0; i < 128; i++) sum += descriptor[i] * descriptor[i];
    const norm = Math.sqrt(sum) || 1.0;
    const inputDesc = new Float32Array(128);
    for (let i = 0; i < 128; i++) inputDesc[i] = descriptor[i] / norm;

    const persons = await getEligiblePersons();
    if (persons.length === 0) {
      return res.json({ matched: false, error: "No registered persons with face data found. Contact admin." });
    }

    let bestDist = Infinity;
    let secondBestDist = Infinity;
    let bestPerson = null;

    for (const p of persons) {
      const dist = calcEuclideanDistance(inputDesc, p.descriptor);
      if (dist < bestDist) {
        secondBestDist = bestDist;
        bestDist = dist;
        bestPerson = p;
      } else if (dist < secondBestDist) {
        secondBestDist = dist;
      }
    }

    console.log(`[Face Verify] IP: ${clientIp}, Candidate: ${bestPerson?.name} (${bestPerson?.id}), Dist: ${bestDist.toFixed(4)}, 2nd: ${secondBestDist.toFixed(4)}, Threshold: ${FACE_VERIFY_THRESHOLD}`);

    if (bestDist < FACE_VERIFY_THRESHOLD && (secondBestDist - bestDist >= FACE_MARGIN_THRESHOLD)) {
      const iat = Date.now();
      const exp = iat + 5 * 60 * 1000;
      const tokenPayload = {
        pid: bestPerson.id,
        name: bestPerson.name,
        department: bestPerson.department,
        iat,
        exp,
        jti: crypto.randomUUID(),
      };
      const token = signFaceToken(tokenPayload);

      return res.json({
        matched: true,
        person: {
          id: bestPerson.id,
          name: bestPerson.name,
          department: bestPerson.department,
        },
        token,
        distance: Number(bestDist.toFixed(4)),
      });
    }

    return res.json({
      matched: false,
      error: "Face not recognized. Please retry.",
      distance: Number(bestDist.toFixed(4)),
    });
  } catch (err) {
    console.error("[Face Verify Error]:", err);
    return res.status(500).json({ matched: false, error: "Internal server error: " + err.message });
  }
});
"""

target_marker = "// ==========================================\n// AUTOMATED STORAGE MAINTENANCE & PHOTO PRUNING"
replacement_marker = verify_service_code + "\n" + target_marker

target_insert_block = """      for (const item of items) {
        if (!item) continue;
        const itemObj = { ...item };
        
        // Auto-generate UUID if missing for tables using string UUIDs (like persons/users)
        if (!itemObj.id && (table === "persons" || table === "users")) {
          itemObj.id = crypto.randomUUID();
        }"""

replacement_insert_block = """      for (const item of items) {
        if (!item) continue;
        const itemObj = { ...item };
        
        // Auto-generate UUID if missing for tables using string UUIDs (like persons/users)
        if (!itemObj.id && (table === "persons" || table === "users")) {
          itemObj.id = crypto.randomUUID();
        }

        // Face Verification Token validation for field attendance
        if (table === "attendance" && itemObj.verification_token) {
          const tokenRes = verifyFaceToken(itemObj.verification_token);
          if (!tokenRes.valid) {
            return res.status(400).json({ error: { message: "Invalid or expired verification token: " + tokenRes.error } });
          }
          delete itemObj.verification_token;
          const verifiedTag = `Verified by: ${tokenRes.payload.name} (ID ${tokenRes.payload.pid})`;
          if (itemObj.notes && itemObj.notes.trim()) {
            if (!itemObj.notes.includes(verifiedTag)) {
              itemObj.notes = `${verifiedTag} | ${itemObj.notes.trim()}`;
            }
          } else {
            itemObj.notes = verifiedTag;
          }
        }"""

target_try_block = """  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: { message: `Table '${table}' is not accessible.` } });
  }

  try {"""

replacement_try_block = """  if (!allowedTables.includes(table)) {
    return res.status(400).json({ error: { message: `Table '${table}' is not accessible.` } });
  }

  try {
    if (table === "persons" && action !== "select") {
      clearEligiblePersonsCache();
    }"""

norm_content = content.replace("\r\n", "\n")
norm_tm = target_marker.replace("\r\n", "\n")
norm_rm = replacement_marker.replace("\r\n", "\n")
norm_tib = target_insert_block.replace("\r\n", "\n")
norm_rib = replacement_insert_block.replace("\r\n", "\n")
norm_ttb = target_try_block.replace("\r\n", "\n")
norm_rtb = replacement_try_block.replace("\r\n", "\n")

if norm_tm in norm_content and norm_tib in norm_content and norm_ttb in norm_content:
    updated = norm_content.replace(norm_tm, norm_rm, 1)
    updated = updated.replace(norm_tib, norm_rib, 1)
    updated = updated.replace(norm_ttb, norm_rtb, 1)
    if "\r\n" in content:
        updated = updated.replace("\n", "\r\n")
    with open(server_path, "w", encoding="utf-8") as f:
        f.write(updated)
    print("SUCCESS: server.js updated with face verify and token audit.")
else:
    print("FAILED: Could not find target markers in server.js.")
